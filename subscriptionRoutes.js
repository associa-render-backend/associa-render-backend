const express = require('express');
const router = express.Router();

const db = require('../db');

const authMiddleware = require('../middleware/authMiddleware');

const {
    requireOrganization,
    requirePermission
} = require('../middleware/authorizationMiddleware');

const checkSubscription = require('../middleware/subscriptionMiddleware');
const requireFeature = require('../middleware/featureMiddleware');
const FEATURES = require('../config/features');

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(value || '');
}

router.use(
    authMiddleware,
    requireOrganization,
    requirePermission('statements.view'),
    checkSubscription,
    requireFeature(FEATURES.MEMBER_STATEMENTS)
);

function parseDate(value, fieldName) {
    if (!value) {
        return null;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const error = new Error(`${fieldName} must be in YYYY-MM-DD format`);
        error.statusCode = 400;
        throw error;
    }

    const date = new Date(`${value}T00:00:00.000Z`);

    if (Number.isNaN(date.getTime())) {
        const error = new Error(`${fieldName} is invalid`);
        error.statusCode = 400;
        throw error;
    }

    return date;
}

function formatDate(value) {
    if (!value) {
        return '';
    }

    return new Date(value).toLocaleDateString('en-GB', {
        day:'2-digit',
        month:'short',
        year:'numeric',
        timeZone:'UTC'
    });
}

function isBefore(value, boundary) {
    return boundary && new Date(value).getTime() < boundary.getTime();
}

function isWithinPeriod(value, fromDate, toDate) {
    const timestamp = new Date(value).getTime();

    if (fromDate && timestamp < fromDate.getTime()) {
        return false;
    }

    if (toDate && timestamp > toDate.getTime()) {
        return false;
    }

    return true;
}

function getGeneratedBy(user) {
    return user?.fullName || user?.email || 'System User';
}

router.get('/members', async (req, res) => {
    try {
        const organizationId = req.user?.organizationId || req.organizationId;

        if (!organizationId) {
            return res.status(403).json({
                success:false,
                message:'Your account is not assigned to an organization'
            });
        }

        const result = await db.query(`
            SELECT
                "Id",
                COALESCE("MemberNo", "MemberNumber") AS "MemberNo",
                COALESCE("Surname", '') AS "Surname",
                COALESCE("FirstName", '') AS "FirstName",
                "Status"
            FROM "Members"
            WHERE "OrganizationId" = $1
            ORDER BY
                COALESCE("Surname", ''),
                COALESCE("FirstName", ''),
                COALESCE("MemberNo", "MemberNumber")
        `, [organizationId]);

        res.json({
            success:true,
            data:result.rows
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success:false,
            message:'Unable to load organization members'
        });
    }
});

router.get('/:memberId', authMiddleware, async (req, res) => {
    try {
        const memberId = req.params.memberId;
        const organizationId = req.user?.organizationId || req.organizationId;

        if (!organizationId) {
            return res.status(403).json({
                success:false,
                message:'Your account is not assigned to an organization'
            });
        }

        if (!isUuid(memberId)) {
            return res.status(400).json({
                success:false,
                message:'Invalid member ID'
            });
        }

        const fromDate = parseDate(req.query.fromDate, 'fromDate');
        const toDate = parseDate(req.query.toDate, 'toDate');

        if (fromDate && toDate && fromDate > toDate) {
            return res.status(400).json({
                success:false,
                message:'From date cannot be later than to date'
            });
        }

        const memberResult = await db.query(`
            SELECT
                "Id",
                "OrganizationId",
                COALESCE("MemberNo", "MemberNumber") AS "MemberNo",
                COALESCE("Surname", '') AS "Surname",
                COALESCE("FirstName", '') AS "FirstName",
                COALESCE("OtherName", '') AS "OtherName",
                "Phone",
                "Email",
                "Village",
                "Branch",
                "Zone",
                "Status",
                COALESCE("CreditBalance", 0) AS "CreditBalance"
            FROM "Members"
            WHERE "Id" = $1
              AND "OrganizationId" = $2
            LIMIT 1
        `, [memberId, organizationId]);

        if (memberResult.rows.length === 0) {
            return res.status(404).json({
                success:false,
                message:'Member not found'
            });
        }

        const member = memberResult.rows[0];

        const settingsResult = await db.query(`
            SELECT
                "AssociationName",
                "Slogan",
                "LogoPath",
                "Address",
                "Phone",
                "Email",
                "Website"
            FROM "AssociationSettings"
            WHERE "OrganizationId" = $1
            LIMIT 1
        `, [organizationId]);

        const settings = settingsResult.rows[0] || {};

        const obligationsResult = await db.query(`
            SELECT
                "Id",
                "Description",
                "AmountDue",
                COALESCE("WaivedAmount", 0) AS "WaivedAmount",
                "DueDate",
                "CreatedAt",
                COALESCE("DueDate", "CreatedAt"::date) AS "EntryDate"
            FROM "Obligations"
            WHERE "MemberId" = $1
              AND "OrganizationId" = $2
            ORDER BY
                COALESCE("DueDate", "CreatedAt"::date),
                "CreatedAt",
                "Id"
        `, [memberId, organizationId]);

        const allocationsResult = await db.query(`
            SELECT
                pa."Id",
                pa."ObligationId",
                COALESCE(pa."Amount", pa."AmountAllocated", 0) AS "Amount",
                pa."AllocatedAt",
                pa."AllocatedBy",
                p."Id" AS "PaymentId",
                p."PaymentDate" AS "EntryDate",
                p."CreatedAt" AS "PaymentCreatedAt",
                COALESCE(p."Reference", p."PaymentReference") AS "Reference",
                p."PaymentMethod",
                o."Description"
            FROM "PaymentAllocations" pa
            INNER JOIN "Payments" p
                ON pa."PaymentId" = p."Id"
            INNER JOIN "Obligations" o
                ON pa."ObligationId" = o."Id"
            WHERE p."MemberId" = $1
              AND p."OrganizationId" = $2
              AND o."OrganizationId" = $2
              AND o."MemberId" = $1
              AND COALESCE(p."Status", 'POSTED') = 'POSTED'
            ORDER BY
                p."PaymentDate",
                p."CreatedAt",
                pa."Id"
        `, [memberId, organizationId]);

        const obligations = obligationsResult.rows;
        const allocations = allocationsResult.rows;

        let openingDebit = 0;
        let openingCredit = 0;

        if (fromDate) {
            obligations.forEach(row => {
                if (isBefore(row.EntryDate, fromDate)) {
                    openingDebit += Number(row.AmountDue || 0);
                    openingCredit += Number(row.WaivedAmount || 0);
                }
            });

            allocations.forEach(row => {
                if (isBefore(row.EntryDate, fromDate)) {
                    openingCredit += Number(row.Amount || 0);
                }
            });
        }

        const openingBalance = openingDebit - openingCredit;
        const periodEntries = [];

        obligations.forEach(row => {
            if (!isWithinPeriod(row.EntryDate, fromDate, toDate)) {
                return;
            }

            periodEntries.push({
                SortDate:row.EntryDate,
                SortTimestamp:row.CreatedAt || row.EntryDate,
                SortOrder:1,
                SortId:String(row.Id),
                Date:formatDate(row.EntryDate),
                Reference:'OBLIGATION',
                Description:row.Description || 'Member obligation',
                Debit:Number(row.AmountDue || 0),
                Credit:0
            });

            const waivedAmount = Number(row.WaivedAmount || 0);

            if (waivedAmount > 0) {
                periodEntries.push({
                    SortDate:row.EntryDate,
                    SortTimestamp:row.CreatedAt || row.EntryDate,
                    SortOrder:2,
                    SortId:`${row.Id}-WAIVER`,
                    Date:formatDate(row.EntryDate),
                    Reference:'WAIVER',
                    Description:`Waiver: ${row.Description || 'Member obligation'}`,
                    Debit:0,
                    Credit:waivedAmount
                });
            }
        });

        allocations.forEach(row => {
            if (!isWithinPeriod(row.EntryDate, fromDate, toDate)) {
                return;
            }

            periodEntries.push({
                SortDate:row.EntryDate,
                SortTimestamp:row.PaymentCreatedAt || row.AllocatedAt || row.EntryDate,
                SortOrder:3,
                SortId:String(row.Id),
                Date:formatDate(row.EntryDate),
                Reference:row.Reference || 'PAYMENT',
                Description:`Payment for ${row.Description || 'member obligation'}`,
                Debit:0,
                Credit:Number(row.Amount || 0)
            });
        });

        periodEntries.sort((a, b) => {
            const dateDifference = new Date(a.SortDate) - new Date(b.SortDate);

            if (dateDifference !== 0) {
                return dateDifference;
            }

            if (a.SortOrder !== b.SortOrder) {
                return a.SortOrder - b.SortOrder;
            }

            const timestampDifference = new Date(a.SortTimestamp) - new Date(b.SortTimestamp);

            if (timestampDifference !== 0) {
                return timestampDifference;
            }

            return a.SortId.localeCompare(b.SortId);
        });

        let runningBalance = openingBalance;

        const ledger = [{
            Date:'',
            Reference:'',
            Description:'Opening Balance',
            Debit:0,
            Credit:0,
            Balance:openingBalance
        }];

        periodEntries.forEach(row => {
            runningBalance += Number(row.Debit || 0);
            runningBalance -= Number(row.Credit || 0);

            ledger.push({
                Date:row.Date,
                Reference:row.Reference,
                Description:row.Description,
                Debit:row.Debit,
                Credit:row.Credit,
                Balance:runningBalance
            });
        });

        const totalDebit = periodEntries.reduce(
            (sum, row) => sum + Number(row.Debit || 0),
            0
        );

        const totalCredit = periodEntries.reduce(
            (sum, row) => sum + Number(row.Credit || 0),
            0
        );

        ledger.push({
            Date:'',
            Reference:'',
            Description:'Period Closing Balance',
            Debit:0,
            Credit:0,
            Balance:runningBalance
        });

        const outstanding = [];

        obligations.forEach(obligation => {
            const allocated = allocations
                .filter(row => String(row.ObligationId).toLowerCase() === String(obligation.Id).toLowerCase())
                .reduce((sum, row) => sum + Number(row.Amount || 0), 0);

            const waived = Number(obligation.WaivedAmount || 0);
            const amountDue = Number(obligation.AmountDue || 0);
            const balance = Math.max(0, amountDue - allocated - waived);

            if (balance <= 0) {
                return;
            }

            outstanding.push({
                Description:obligation.Description || 'Member obligation',
                DueDate:obligation.DueDate ? formatDate(obligation.DueDate) : '',
                AmountDue:amountDue,
                AmountPaid:allocated,
                WaivedAmount:waived,
                Balance:balance,
                Status:(allocated > 0 || waived > 0) ? 'PARTLY PAID' : 'UNPAID'
            });
        });

        const now = new Date();
        const generatedBy = getGeneratedBy(req.user);
        const statementNumber = `STM-${member.MemberNo || member.Id}-${now.toISOString().replace(/\D/g, '').slice(0, 14)}`;
        const outstandingBalance = outstanding.reduce(
            (sum, item) => sum + Number(item.Balance || 0),
            0
        );

        res.json({
            success:true,
            member,
            association:{
                name:settings.AssociationName || '',
                slogan:settings.Slogan || '',
                logo:settings.LogoPath || '',
                address:settings.Address || '',
                phone:settings.Phone || '',
                email:settings.Email || '',
                website:settings.Website || ''
            },
            statementInfo:{
                statementNumber,
                generatedDate:now.toLocaleString('en-GB'),
                generatedBy
            },
            reportPeriod:{
                fromDate:req.query.fromDate || null,
                toDate:req.query.toDate || null
            },
            summary:{
                openingBalance,
                totalDebit,
                totalCredit,
                closingBalance:outstandingBalance
            },
            transactions:ledger,
            outstanding,
            footer:{
                line1:`Prepared By: ${generatedBy}`,
                line2:'This statement reflects the obligations, waivers and posted payments recorded for this member.',
                line3:'For enquiries contact the Association Financial Secretary.'
            }
        });
    } catch (err) {
        console.error(err);

        res.status(err.statusCode || 500).json({
            success:false,
            message:err.statusCode ? err.message : 'Unable to generate member statement'
        });
    }
});

module.exports = router;

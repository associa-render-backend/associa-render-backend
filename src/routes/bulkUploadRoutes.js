const express = require('express');
const router = express.Router();

const multer = require('multer');
const XLSX = require('xlsx');

const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');
const { authorizeRoles, requireOrganization } = require('../middleware/authorizationMiddleware');
const { writeAuditEvent } = require('../services/auditService');

const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:10 * 1024 * 1024 } });

router.use(authMiddleware, requireOrganization, authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER', 'DATA_ENTRY'));

function normalizeExcelDate(value) {
    try {
        if (!value) return null;
        if (typeof value === 'number') {
            const excelDate = XLSX.SSF.parse_date_code(value);
            return `${excelDate.y}-${String(excelDate.m).padStart(2, '0')}-${String(excelDate.d).padStart(2, '0')}`;
        }
        if (value instanceof Date) return value.toISOString().split('T')[0];
        const str = String(value).trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
            const parts = str.split('/');
            return `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        if (/^\d{2}-\d{2}-\d{4}$/.test(str)) {
            const parts = str.split('-');
            return `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
        const parsed = new Date(str);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
        return null;
    } catch {
        return null;
    }
}

function text(value, max = 255) {
    return String(value || '').trim().slice(0, max);
}

function paymentReference(value) {
    const reference = text(value, 500);
    return ['NA', 'N/A', 'NONE', 'NULL', '-'].includes(reference.toUpperCase())
        ? ''
        : reference;
}

function fullName(row) {
    return [row.Surname, row.FirstName, row.OtherName].map(x => text(x, 200)).filter(Boolean).join(' ') || text(row.MemberNo, 100);
}

function actorName(req) {
    return req.user?.fullName || req.user?.email || 'System User';
}

function isOffsetMethod(value) {
    return String(value || '').trim().toUpperCase() === 'OFFSET';
}

function readRows(req) {
    if (!req.file) {
        const error = new Error('No file uploaded');
        error.statusCode = 400;
        throw error;
    }
    const workbook = XLSX.read(req.file.buffer, { type:'buffer' });
    const sheetName = workbook.SheetNames[0];
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { raw:true });
}

function readPaymentRows(req) {
    if (!req.file) {
        const error = new Error('No file uploaded');
        error.statusCode = 400;
        throw error;
    }

    const workbook = XLSX.read(req.file.buffer, { type:'buffer' });
    const sheetName = workbook.SheetNames[0];
    const values = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header:1,
        raw:true,
        defval:null
    });
    const headers = values[0] || [];

    return values.slice(1).reduce((rows, cells, index) => {
        if (!cells.some(value => value !== null && value !== '')) {
            return rows;
        }

        const row = { __excelRow:index + 2 };
        headers.forEach((header, column) => {
            if (header !== null && header !== '') {
                row[String(header).trim()] = cells[column];
            }
        });
        rows.push(row);
        return rows;
    }, []);
}

async function getIndividualCampaignId(organizationId) {
    const existing = await db.query(`
        SELECT "Id"
        FROM "Campaigns"
        WHERE "OrganizationId" = $1
          AND "CampaignCode" = 'INDIVIDUAL'
        LIMIT 1
    `, [organizationId]);

    if (existing.rows.length > 0) {
        return existing.rows[0].Id;
    }

    const created = await db.query(`
        INSERT INTO "Campaigns"
        (
            "OrganizationId",
            "CampaignCode",
            "CampaignName",
            "ContributionType",
            "Amount",
            "TargetScope",
            "Status",
            "CreatedAt"
        )
        VALUES
        (
            $1,
            'INDIVIDUAL',
            'Individual Obligations',
            'OTHER',
            0,
            'INDIVIDUAL',
            'ACTIVE',
            CURRENT_TIMESTAMP
        )
        RETURNING "Id"
    `, [organizationId]);

    return created.rows[0].Id;
}

async function allocatePaymentToOldestObligations(tx, {
    organizationId,
    memberId,
    paymentId,
    amount,
    actor
}) {
    let remaining = Number(amount || 0);

    const obligations = await tx.query(`
        SELECT
            "Id",
            "AmountDue",
            "AmountPaid",
            "Balance"
        FROM "Obligations"
        WHERE "OrganizationId" = $1
          AND "MemberId" = $2
          AND COALESCE("Balance", 0) > 0
        ORDER BY
            "DueDate" NULLS LAST,
            "CreatedAt",
            "Id"
        FOR UPDATE
    `, [organizationId, memberId]);

    for (const obligation of obligations.rows) {
        if (remaining <= 0) {
            break;
        }

        const balance = Number(obligation.Balance || 0);
        const allocationAmount = Math.min(balance, remaining);
        const newPaid = Number(obligation.AmountPaid || 0) + allocationAmount;
        const newBalance = Math.max(0, balance - allocationAmount);
        const newStatus = newBalance <= 0 ? 'PAID' : 'PARTLY PAID';

        await tx.query(`
            UPDATE "Obligations"
            SET
                "AmountPaid" = $1,
                "Balance" = $2,
                "Status" = $3,
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Id" = $4
              AND "OrganizationId" = $5
        `, [
            newPaid,
            newBalance,
            newStatus,
            obligation.Id,
            organizationId
        ]);

        await tx.query(`
            INSERT INTO "PaymentAllocations"
            (
                "OrganizationId",
                "PaymentId",
                "ObligationId",
                "Amount",
                "AmountAllocated",
                "AllocatedAt",
                "AllocatedBy",
                "CreatedAt"
            )
            VALUES ($1, $2, $3, $4, $4, CURRENT_TIMESTAMP, $5, CURRENT_TIMESTAMP)
        `, [
            organizationId,
            paymentId,
            obligation.Id,
            allocationAmount,
            actor
        ]);

        remaining -= allocationAmount;
    }

    return Math.max(0, remaining);
}

function numberFromJson(value, key) {
    if (!value || typeof value !== 'object') {
        return 0;
    }

    return Number(value[key] || 0);
}

function uploadTypeFromEntityType(entityType) {
    if (entityType === 'BULK_MEMBERS') {
        return 'Members';
    }

    if (entityType === 'BULK_MEMBER_OBLIGATIONS') {
        return 'Financial Obligations';
    }

    if (entityType === 'BULK_PAYMENTS') {
        return 'Payments';
    }

    if (entityType === 'BULK_EXPENDITURES') {
        return 'Expenditures';
    }

    return 'Import';
}

router.get('/stats', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                (
                    SELECT COUNT(*)
                    FROM "Members"
                    WHERE "OrganizationId" = $1
                ) AS "TotalMembersImported",
                (
                    SELECT COUNT(*)
                    FROM "Obligations"
                    WHERE "OrganizationId" = $1
                ) AS "TotalObligationsImported",
                (
                    SELECT COUNT(*)
                    FROM "Payments"
                    WHERE "OrganizationId" = $1
                      AND COALESCE("Status", 'POSTED') = 'POSTED'
                ) AS "TotalPaymentsImported",
                (
                    SELECT MAX("CreatedAt")
                    FROM "AuditEvents"
                    WHERE "OrganizationId" = $1
                      AND "Action" = 'IMPORT'
                      AND "EntityType" IN ('BULK_MEMBERS', 'BULK_MEMBER_OBLIGATIONS', 'BULK_PAYMENTS', 'BULK_EXPENDITURES')
                ) AS "LastUploadDate"
        `, [req.organizationId]);

        const row = result.rows[0] || {};

        res.json({
            success:true,
            data:{
                totalMembersImported:Number(row.TotalMembersImported || 0),
                totalObligationsImported:Number(row.TotalObligationsImported || 0),
                totalPaymentsImported:Number(row.TotalPaymentsImported || 0),
                lastUploadDate:row.LastUploadDate || null
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to load bulk upload statistics' });
    }
});

router.get('/history', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                "Id",
                "EntityType",
                "EntityId",
                "Summary",
                "AfterData",
                "Metadata",
                "ActorName",
                "ActorEmail",
                "CreatedAt"
            FROM "AuditEvents"
            WHERE "OrganizationId" = $1
              AND "Action" = 'IMPORT'
              AND "EntityType" IN ('BULK_MEMBERS', 'BULK_MEMBER_OBLIGATIONS', 'BULK_PAYMENTS', 'BULK_EXPENDITURES')
            ORDER BY "CreatedAt" DESC, "Id" DESC
            LIMIT 25
        `, [req.organizationId]);

        const data = result.rows.map(row => {
            const created = numberFromJson(row.AfterData, 'created');
            const processed = numberFromJson(row.AfterData, 'processed');
            const skipped = numberFromJson(row.AfterData, 'skipped');
            const rows = numberFromJson(row.AfterData, 'rows');
            const successful = created || processed;
            const records = rows || successful + skipped;

            return {
                id:row.Id,
                date:row.CreatedAt,
                type:uploadTypeFromEntityType(row.EntityType),
                records,
                successful,
                skipped,
                status:skipped > 0 ? 'Completed with skips' : 'Completed',
                uploadedBy:row.ActorName || row.ActorEmail || 'System User',
                fileName:row.Metadata?.fileName || row.EntityId || '',
                summary:row.Summary
            };
        });

        res.json({ success:true, data });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to load import history' });
    }
});



router.post('/members', upload.single('file'), async (req, res) => {
    try {
        const rows = readRows(req);
        let created = 0;
        let skipped = 0;
        for (const row of rows) {
            try {
                const memberNo = text(row.MemberNo, 100);
                if (!memberNo) { skipped++; continue; }
                const existing = await db.query(`SELECT "Id" FROM "Members" WHERE "OrganizationId" = $1 AND ("MemberNo" = $2 OR "MemberNumber" = $2) LIMIT 1`, [req.organizationId, memberNo]);
                if (existing.rows.length > 0) { skipped++; continue; }
                await db.query(`
                    INSERT INTO "Members"
                    ("OrganizationId", "MemberNumber", "MemberNo", "FullName", "Surname", "FirstName", "OtherName", "Phone", "Email", "Village", "Branch", "Zone", "Status", "CreditBalance", "CreatedAt")
                    VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE',0,CURRENT_TIMESTAMP)
                `, [req.organizationId, memberNo, fullName(row), text(row.Surname, 200), text(row.FirstName, 200), text(row.OtherName, 200), text(row.Phone, 100), text(row.Email, 255), text(row.Village, 200), text(row.Branch, 200), text(row.Zone, 200)]);
                created++;
            } catch (err) { console.error(err); skipped++; }
        }
        await writeAuditEvent({ req, organizationId:req.organizationId, action:'IMPORT', entityType:'BULK_MEMBERS', entityId:req.file.originalname, summary:`${created} members imported; ${skipped} skipped`, afterData:{ created, skipped, rows:rows.length }, metadata:{ fileName:req.file.originalname } });
        res.json({ success:true, message:`${created} members uploaded successfully. ${skipped} skipped.` });
    } catch (err) { console.error(err); res.status(err.statusCode || 500).json({ success:false, message:err.message }); }
});

router.post('/member-obligations', upload.single('file'), async (req, res) => {
    try {
        const rows = readRows(req);
        const campaignId = await getIndividualCampaignId(req.organizationId);
        let created = 0;
        let skipped = 0;
        for (const row of rows) {
            try {
                const memberNo = text(row.MemberNo, 100);
                const memberResult = await db.query(`SELECT "Id" FROM "Members" WHERE "OrganizationId" = $1 AND ("MemberNo" = $2 OR "MemberNumber" = $2) LIMIT 1`, [req.organizationId, memberNo]);
                if (memberResult.rows.length === 0) { skipped++; continue; }
                const amount = Number(row.Amount || 0);
                const dueDate = normalizeExcelDate(row.DueDate);
                if (amount <= 0 || !dueDate) { skipped++; continue; }
                const obligationType = text(row.Type || 'OTHER', 100);
                const description = text(row.Description, 500);
                const duplicateResult = await db.query(`
                    SELECT "Id"
                    FROM "Obligations"
                    WHERE "OrganizationId" = $1
                      AND "MemberId" = $2
                      AND "AssignmentType" = 'INDIVIDUAL'
                      AND COALESCE("ObligationType", '') = $3
                      AND COALESCE("Description", '') = $4
                      AND "AmountDue"::numeric = $5::numeric
                      AND "DueDate" = $6::date
                    LIMIT 1
                `, [req.organizationId, memberResult.rows[0].Id, obligationType, description, amount, dueDate]);
                if (duplicateResult.rows.length > 0) { skipped++; continue; }
                await db.query(`
                    INSERT INTO "Obligations"
                    ("OrganizationId", "CampaignId", "MemberId", "AmountDue", "AmountPaid", "WaivedAmount", "CreditBalance", "Balance", "DueDate", "Status", "CreatedAt", "UpdatedAt", "AssignmentType", "ObligationType", "Description")
                    VALUES ($1,$2,$3,$4,0,0,0,$4,$5,'UNPAID',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'INDIVIDUAL',$6,$7)
                `, [req.organizationId, campaignId, memberResult.rows[0].Id, amount, dueDate, obligationType, description]);
                created++;
            } catch (err) { console.error(err); skipped++; }
        }
        await writeAuditEvent({ req, organizationId:req.organizationId, action:'IMPORT', entityType:'BULK_MEMBER_OBLIGATIONS', entityId:req.file.originalname, summary:`${created} obligations imported; ${skipped} skipped`, afterData:{ created, skipped, rows:rows.length }, metadata:{ fileName:req.file.originalname } });
        res.json({ success:true, message:`${created} obligations uploaded successfully. ${skipped} skipped.` });
    } catch (err) { console.error(err); res.status(err.statusCode || 500).json({ success:false, message:err.message }); }
});

router.post('/payments', upload.single('file'), async (req, res) => {
    try {
        const rows = readPaymentRows(req);
        let processed = 0;
        let skipped = 0;
        const skippedRows = [];

        const skipRow = (row, reason) => {
            skipped++;
            if (skippedRows.length < 250) {
                skippedRows.push({
                    rowNumber:row.__excelRow,
                    memberNo:text(row.MemberNo, 100) || null,
                    amount:row.Amount ?? null,
                    paymentDate:row.PaymentDate ?? null,
                    reference:paymentReference(row.Reference || row.PaymentReference) || null,
                    reason
                });
            }
        };
        for (const row of rows) {
            try {
                const memberNo = text(row.MemberNo, 100);
                const amount = Number(row.Amount || 0);
                const paymentDate = normalizeExcelDate(row.PaymentDate);
                const paymentMethod = text(row.PaymentMethod || row.Method || 'BULK UPLOAD', 100) || 'BULK UPLOAD';
                const purpose = text(row.PurposeOfPayment || row.Description || row.Remarks, 500);
                const reference = paymentReference(row.Reference || row.PaymentReference);
                const remarks = isOffsetMethod(paymentMethod)
                    ? 'Offset payment - no cashbook income'
                    : 'Bulk Upload';

                if (!memberNo) { skipRow(row, 'Member number is missing'); continue; }
                if (amount <= 0) { skipRow(row, 'Amount must be greater than zero'); continue; }
                if (!paymentDate) { skipRow(row, 'Payment date is invalid or missing'); continue; }

                const memberResult = await db.query(`SELECT "Id" FROM "Members" WHERE "OrganizationId" = $1 AND ("MemberNo" = $2 OR "MemberNumber" = $2) LIMIT 1`, [req.organizationId, memberNo]);
                if (memberResult.rows.length === 0) { skipRow(row, 'Member number was not found'); continue; }
                const saved = await db.transaction(async tx => {
                    const existingResult = reference
                        ? await tx.query(`
                            SELECT "Id"
                            FROM "Payments"
                            WHERE "OrganizationId" = $1
                              AND "MemberId" = $2
                              AND "PaymentDate" = $3::date
                              AND COALESCE("Amount", "AmountPaid", 0)::numeric = $4::numeric
                              AND COALESCE("Reference", "PaymentReference", '') = $5
                              AND COALESCE("PaymentMethod", '') = $6
                              AND COALESCE("Status", 'POSTED') = 'POSTED'
                            LIMIT 1
                        `, [
                            req.organizationId,
                            memberResult.rows[0].Id,
                            paymentDate,
                            amount,
                            reference,
                            paymentMethod
                        ])
                        : { rows:[] };

                    if (existingResult.rows.length > 0) {
                        skipRow(row, 'A posted payment with this reference already exists');
                        return false;
                    }

                    const paymentResult = await tx.query(`
                        INSERT INTO "Payments"
                        ("OrganizationId", "MemberId", "Amount", "AmountPaid", "PaymentDate", "PaymentMethod", "Reference", "Remarks", "Status", "CreatedBy", "CreatedAt")
                        VALUES ($1,$2,$3,$3,$4,$5,$6,$7,'POSTED',$8,CURRENT_TIMESTAMP)
                        RETURNING "Id"
                    `, [
                        req.organizationId,
                        memberResult.rows[0].Id,
                        amount,
                        paymentDate,
                        paymentMethod,
                        reference,
                        remarks,
                        actorName(req)
                    ]);

                    const paymentId = paymentResult.rows[0].Id;

                    const creditIncrease = await allocatePaymentToOldestObligations(tx, {
                        organizationId:req.organizationId,
                        memberId:memberResult.rows[0].Id,
                        paymentId,
                        amount,
                        actor:actorName(req)
                    });

                    if (creditIncrease > 0) {
                        await tx.query(`
                            UPDATE "Members"
                            SET
                                "CreditBalance" = COALESCE("CreditBalance", 0) + $1,
                                "UpdatedAt" = CURRENT_TIMESTAMP
                            WHERE "Id" = $2
                              AND "OrganizationId" = $3
                        `, [
                            creditIncrease,
                            memberResult.rows[0].Id,
                            req.organizationId
                        ]);
                    }

                    if (!isOffsetMethod(paymentMethod)) {
                        await tx.query(`
                            INSERT INTO "FinancialTransactions"
                            (
                                "OrganizationId",
                                "TransactionDate",
                                "TransactionType",
                                "Category",
                                "Description",
                                "Amount",
                                "Reference",
                                "PaymentMethod",
                                "Source",
                                "SourceId",
                                "CreatedBy",
                                "CreatedAt",
                                "Status"
                            )
                            VALUES
                            (
                                $1, $2, 'INCOME', 'Member Contributions',
                                $3, $4, $5, $6, 'MEMBER_PAYMENT', $7,
                                $8, CURRENT_TIMESTAMP, 'POSTED'
                            )
                        `, [
                            req.organizationId,
                            paymentDate,
                            reference || purpose || 'Bulk member payment',
                            amount,
                            paymentId,
                            paymentMethod,
                            paymentId,
                            actorName(req)
                        ]);
                    }

                    return true;
                });
                if (saved) {
                    processed++;
                }
            } catch (err) {
                console.error(err);
                skipRow(row, 'Unable to process this row');
            }
        }
        await writeAuditEvent({ req, organizationId:req.organizationId, action:'IMPORT', entityType:'BULK_PAYMENTS', entityId:req.file.originalname, summary:`${processed} payments imported; ${skipped} skipped`, afterData:{ processed, skipped, rows:rows.length, skippedRows }, metadata:{ fileName:req.file.originalname } });
        res.json({ success:true, message:`${processed} payments uploaded successfully. ${skipped} skipped.`, skippedRows });
    } catch (err) { console.error(err); res.status(err.statusCode || 500).json({ success:false, message:err.message }); }
});

router.post('/expenditures', upload.single('file'), async (req, res) => {
    try {
        const rows = readRows(req);
        let processed = 0;
        let skipped = 0;

        for (const row of rows) {
            try {
                const amount = Number(row.Amount || row.ExpenseAmount || 0);
                const transactionDate = normalizeExcelDate(row.Date || row.TransactionDate || row.PaymentDate);
                const category = text(row.Category || row.Type || 'General Expense', 150);
                const description = text(row.Description || row.Purpose || row.Payee || 'Bulk expenditure', 500);
                const reference = text(row.Reference || row.Ref || row.VoucherNo || row.ReceiptNo || '', 100);
                const paymentMethod = text(row.PaymentMethod || row.Method || 'BULK UPLOAD', 100) || 'BULK UPLOAD';
                const isNonCash = isOffsetMethod(paymentMethod);
                const status = isNonCash ? 'NON_CASH' : 'POSTED';
                const source = isNonCash ? 'BULK_EXPENDITURE_OFFSET' : 'BULK_EXPENDITURE';

                if (amount <= 0 || !transactionDate || !category) {
                    skipped++;
                    continue;
                }

                const existingResult = await db.query(`
                    SELECT "Id"
                    FROM "FinancialTransactions"
                    WHERE "OrganizationId" = $1
                      AND "TransactionDate" = $2::date
                      AND "TransactionType" = 'EXPENSE'
                      AND COALESCE("Category", '') = $3
                      AND COALESCE("Description", '') = $4
                      AND "Amount"::numeric = $5::numeric
                      AND COALESCE("Reference", '') = $6
                      AND COALESCE("PaymentMethod", '') = $7
                      AND COALESCE("Status", 'POSTED') = $8
                    LIMIT 1
                `, [
                    req.organizationId,
                    transactionDate,
                    category,
                    description,
                    amount,
                    reference,
                    paymentMethod,
                    status
                ]);

                if (existingResult.rows.length > 0) {
                    skipped++;
                    continue;
                }

                await db.query(`
                    INSERT INTO "FinancialTransactions"
                    (
                        "OrganizationId",
                        "TransactionDate",
                        "TransactionType",
                        "Category",
                        "Description",
                        "Amount",
                        "Reference",
                        "PaymentMethod",
                        "Source",
                        "CreatedBy",
                        "CreatedAt",
                        "Status"
                    )
                    VALUES
                    (
                        $1, $2, 'EXPENSE', $3, $4, $5, $6, $7,
                        $8, $9, CURRENT_TIMESTAMP, $10
                    )
                `, [
                    req.organizationId,
                    transactionDate,
                    category,
                    description,
                    amount,
                    reference,
                    paymentMethod,
                    source,
                    actorName(req),
                    status
                ]);

                processed++;
            } catch (err) {
                console.error(err);
                skipped++;
            }
        }

        await writeAuditEvent({
            req,
            organizationId:req.organizationId,
            action:'IMPORT',
            entityType:'BULK_EXPENDITURES',
            entityId:req.file.originalname,
            summary:`${processed} expenditures imported; ${skipped} skipped`,
            afterData:{ processed, skipped, rows:rows.length },
            metadata:{ fileName:req.file.originalname }
        });

        res.json({ success:true, message:`${processed} expenditures uploaded successfully. ${skipped} skipped.` });
    } catch (err) {
        console.error(err);
        res.status(err.statusCode || 500).json({ success:false, message:err.message });
    }
});

module.exports = router;

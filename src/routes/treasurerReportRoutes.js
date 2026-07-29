const express = require('express');
const router = express.Router();

const db = require('../db');

const authMiddleware = require('../middleware/authMiddleware');

const {
    requireOrganization,
    requirePermission
} = require('../middleware/authorizationMiddleware');

router.use(
    authMiddleware,
    requireOrganization,
    requirePermission('treasurerReports.view')
);

function parseReportDate(value) {
    if (!value) {
        return null;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error('Dates must be in YYYY-MM-DD format.');
    }

    const date = new Date(`${value}T00:00:00.000Z`);

    if (Number.isNaN(date.getTime())) {
        throw new Error('Invalid report date.');
    }

    return value;
}

function getReportDateRange(req) {
    const fromDate = parseReportDate(req.query.fromDate);
    const toDate = parseReportDate(req.query.toDate);

    if (fromDate && toDate && fromDate > toDate) {
        throw new Error('fromDate cannot be later than toDate.');
    }

    return {
        fromDate,
        toDate,
        fromDateText:req.query.fromDate || null,
        toDateText:req.query.toDate || null
    };
}

function transactionDateFilter(range, startIndex = 2, alias = 'ft') {
    const filters = [];
    const params = [];
    let index = startIndex;

    if (range.fromDate) {
        filters.push(`${alias}."TransactionDate" >= $${index}::date`);
        params.push(range.fromDate);
        index += 1;
    }

    if (range.toDate) {
        filters.push(`${alias}."TransactionDate" < ($${index}::date + INTERVAL '1 day')`);
        params.push(range.toDate);
        index += 1;
    }

    return {
        clause:filters.length ? `AND ${filters.join(' AND ')}` : '',
        params,
        nextIndex:index
    };
}

function createdDateFilter(range, startIndex = 2, alias = 'o') {
    const filters = [];
    const params = [];
    let index = startIndex;

    if (range.fromDate) {
        filters.push(`${alias}."CreatedAt" >= $${index}::date`);
        params.push(range.fromDate);
        index += 1;
    }

    if (range.toDate) {
        filters.push(`${alias}."CreatedAt" < ($${index}::date + INTERVAL '1 day')`);
        params.push(range.toDate);
        index += 1;
    }

    return {
        clause:filters.length ? `AND ${filters.join(' AND ')}` : '',
        params,
        nextIndex:index
    };
}

function handleRouteError(res, err) {
    const isBadRequest = /date/i.test(err.message || '');

    res.status(isBadRequest ? 400 : 500).json({
        success:false,
        message:err.message
    });
}

async function getOpeningBalance(organizationId) {
    const result = await db.query(`
        SELECT COALESCE("OpeningBalance", 0) AS "OpeningBalance"
        FROM "AssociationSettings"
        WHERE "OrganizationId" = $1
        LIMIT 1
    `, [organizationId]);

    return Number(result.rows[0]?.OpeningBalance || 0);
}

async function getCashTotals(organizationId, range = {}) {
    const filter = transactionDateFilter(range, 2, 'ft');

    const result = await db.query(`
        SELECT
            COALESCE(
                SUM(
                    CASE
                        WHEN ft."TransactionType" = 'INCOME'
                        THEN ft."Amount"
                        ELSE 0
                    END
                ),
                0
            ) AS "TotalIncome",
            COALESCE(
                SUM(
                    CASE
                        WHEN ft."TransactionType" = 'EXPENSE'
                        THEN ft."Amount"
                        ELSE 0
                    END
                ),
                0
            ) AS "TotalExpense"
        FROM "FinancialTransactions" ft
        WHERE ft."OrganizationId" = $1
          ${filter.clause}
    `, [organizationId, ...filter.params]);

    return {
        totalIncome:Number(result.rows[0]?.TotalIncome || 0),
        totalExpense:Number(result.rows[0]?.TotalExpense || 0)
    };
}

router.get('/summary', async (req, res) => {
    try {
        const range = getReportDateRange(req);
        const totals = await getCashTotals(req.organizationId, range);

        const receivableResult = await db.query(`
            SELECT COALESCE(SUM("Balance"), 0) AS "Receivables"
            FROM "Obligations"
            WHERE "OrganizationId" = $1
              AND "Balance" > 0
        `, [req.organizationId]);

        const receivables = Number(receivableResult.rows[0]?.Receivables || 0);
        const cashPosition = await getOpeningBalance(req.organizationId) +
            totals.totalIncome -
            totals.totalExpense;

        res.json({
            success:true,
            totalIncome:totals.totalIncome,
            totalExpense:totals.totalExpense,
            receivables,
            cashPosition
        });
    } catch (err) {
        console.error(err);
        handleRouteError(res, err);
    }
});

router.get('/income-expenditure', async (req, res) => {
    try {
        const range = getReportDateRange(req);
        const filter = transactionDateFilter(range, 2, 'ft');

        const incomeResult = await db.query(`
            SELECT
                COALESCE(ft."Category", 'Uncategorized') AS "Category",
                SUM(ft."Amount") AS "Amount"
            FROM "FinancialTransactions" ft
            WHERE ft."OrganizationId" = $1
              AND ft."TransactionType" = 'INCOME'
              ${filter.clause}
            GROUP BY COALESCE(ft."Category", 'Uncategorized')
            ORDER BY "Category"
        `, [req.organizationId, ...filter.params]);

        const expenseResult = await db.query(`
            SELECT
                COALESCE(ft."Category", 'Uncategorized') AS "Category",
                SUM(ft."Amount") AS "Amount"
            FROM "FinancialTransactions" ft
            WHERE ft."OrganizationId" = $1
              AND ft."TransactionType" = 'EXPENSE'
              ${filter.clause}
            GROUP BY COALESCE(ft."Category", 'Uncategorized')
            ORDER BY "Category"
        `, [req.organizationId, ...filter.params]);

        const totalIncome = incomeResult.rows.reduce(
            (sum, row) => sum + Number(row.Amount || 0),
            0
        );
        const totalExpense = expenseResult.rows.reduce(
            (sum, row) => sum + Number(row.Amount || 0),
            0
        );

        res.json({
            success:true,
            reportTitle:'Income & Expenditure Report',
            fromDate:range.fromDateText,
            toDate:range.toDateText,
            income:incomeResult.rows,
            expenses:expenseResult.rows,
            totalIncome,
            totalExpense,
            surplus:totalIncome - totalExpense
        });
    } catch (err) {
        console.error(err);
        handleRouteError(res, err);
    }
});

router.get('/statement-of-affairs', async (req, res) => {
    try {
        const totals = await getCashTotals(req.organizationId);
        const openingBalance = await getOpeningBalance(req.organizationId);
        const cashPosition = openingBalance + totals.totalIncome - totals.totalExpense;

        const receivableResult = await db.query(`
            SELECT COALESCE(SUM("Balance"), 0) AS "Receivables"
            FROM "Obligations"
            WHERE "OrganizationId" = $1
              AND "Balance" > 0
        `, [req.organizationId]);

        const liabilityResult = await db.query(`
            SELECT COALESCE(SUM("CreditBalance"), 0) AS "Liabilities"
            FROM "Members"
            WHERE "OrganizationId" = $1
        `, [req.organizationId]);

        const receivables = Number(receivableResult.rows[0]?.Receivables || 0);
        const liabilities = Number(liabilityResult.rows[0]?.Liabilities || 0);
        const totalAssets = cashPosition + receivables;

        res.json({
            success:true,
            statementDate:new Date().toISOString(),
            assets:{
                cashPosition,
                receivables,
                totalAssets
            },
            liabilities:{
                memberCredits:liabilities,
                totalLiabilities:liabilities
            },
            accumulatedFund:totalAssets - liabilities
        });
    } catch (err) {
        console.error(err);
        handleRouteError(res, err);
    }
});

router.get('/receivables', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                COALESCE(m."MemberNo", m."MemberNumber") AS "MemberNo",
                COALESCE(m."Surname", '') AS "Surname",
                COALESCE(m."FirstName", '') AS "FirstName",
                o."Description",
                o."AmountDue",
                o."AmountPaid",
                o."Balance",
                o."DueDate"
            FROM "Obligations" o
            INNER JOIN "Members" m
                ON o."MemberId" = m."Id"
                AND o."OrganizationId" = m."OrganizationId"
            WHERE o."OrganizationId" = $1
              AND o."Balance" > 0
            ORDER BY
                COALESCE(m."Surname", ''),
                COALESCE(m."FirstName", ''),
                o."DueDate"
        `, [req.organizationId]);

        res.json({
            success:true,
            data:result.rows
        });
    } catch (err) {
        console.error(err);
        handleRouteError(res, err);
    }
});

router.get('/cash-flow', async (req, res) => {
    try {
        const range = getReportDateRange(req);
        const openingBalance = await getOpeningBalance(req.organizationId);

        const priorResult = await db.query(`
            SELECT
                COALESCE(
                    SUM(
                        CASE
                            WHEN "TransactionType" = 'INCOME' THEN "Amount"
                            WHEN "TransactionType" = 'EXPENSE' THEN -"Amount"
                            ELSE 0
                        END
                    ),
                    0
                ) AS "PriorMovement"
            FROM "FinancialTransactions"
            WHERE "OrganizationId" = $1
              AND (
                    $2::date IS NULL
                    OR "TransactionDate" < $2::date
              )
        `, [req.organizationId, range.fromDate]);

        const filter = transactionDateFilter(range, 2, 'ft');

        const movementResult = await db.query(`
            SELECT
                ft."TransactionType",
                COALESCE(ft."PaymentMethod", 'Unspecified') AS "PaymentMethod",
                SUM(ft."Amount") AS "Amount"
            FROM "FinancialTransactions" ft
            WHERE ft."OrganizationId" = $1
              ${filter.clause}
            GROUP BY
                ft."TransactionType",
                COALESCE(ft."PaymentMethod", 'Unspecified')
            ORDER BY
                ft."TransactionType",
                "PaymentMethod"
        `, [req.organizationId, ...filter.params]);

        const openingCash = openingBalance + Number(priorResult.rows[0]?.PriorMovement || 0);
        const receipts = movementResult.rows.filter(row => row.TransactionType === 'INCOME');
        const payments = movementResult.rows.filter(row => row.TransactionType === 'EXPENSE');
        const totalReceipts = receipts.reduce((sum, row) => sum + Number(row.Amount || 0), 0);
        const totalPayments = payments.reduce((sum, row) => sum + Number(row.Amount || 0), 0);

        res.json({
            success:true,
            fromDate:range.fromDateText,
            toDate:range.toDateText,
            openingCash,
            receipts,
            payments,
            totalReceipts,
            totalPayments,
            closingCash:openingCash + totalReceipts - totalPayments
        });
    } catch (err) {
        console.error(err);
        handleRouteError(res, err);
    }
});

router.get('/campaign-analysis', async (req, res) => {
    try {
        const range = getReportDateRange(req);
        const filter = createdDateFilter(range, 2, 'o');

        const result = await db.query(`
            SELECT
                COALESCE(c."CampaignCode", 'MANUAL') AS "CampaignCode",
                COALESCE(c."CampaignName", o."Description") AS "CampaignName",
                COUNT(o."Id") AS "AssignedMembers",
                COALESCE(SUM(o."AmountDue"), 0) AS "AmountDue",
                COALESCE(SUM(o."AmountPaid"), 0) AS "AmountPaid",
                COALESCE(SUM(o."WaivedAmount"), 0) AS "WaivedAmount",
                COALESCE(SUM(o."Balance"), 0) AS "Balance",
                SUM(
                    CASE
                        WHEN o."Balance" <= 0 THEN 1
                        ELSE 0
                    END
                ) AS "FullyPaidMembers"
            FROM "Obligations" o
            LEFT JOIN "Campaigns" c
                ON o."CampaignId" = c."Id"
                AND o."OrganizationId" = c."OrganizationId"
            WHERE o."OrganizationId" = $1
              ${filter.clause}
            GROUP BY
                COALESCE(c."CampaignCode", 'MANUAL'),
                COALESCE(c."CampaignName", o."Description")
            ORDER BY "CampaignName"
        `, [req.organizationId, ...filter.params]);

        const totals = result.rows.reduce(
            (acc, row) => {
                acc.amountDue += Number(row.AmountDue || 0);
                acc.amountPaid += Number(row.AmountPaid || 0);
                acc.waivedAmount += Number(row.WaivedAmount || 0);
                acc.balance += Number(row.Balance || 0);
                acc.assignedMembers += Number(row.AssignedMembers || 0);
                acc.fullyPaidMembers += Number(row.FullyPaidMembers || 0);
                return acc;
            },
            {
                amountDue:0,
                amountPaid:0,
                waivedAmount:0,
                balance:0,
                assignedMembers:0,
                fullyPaidMembers:0
            }
        );

        res.json({
            success:true,
            data:result.rows,
            totals
        });
    } catch (err) {
        console.error(err);
        handleRouteError(res, err);
    }
});

router.get('/bank-reconciliation', async (req, res) => {
    try {
        const range = getReportDateRange(req);
        const openingBalance = await getOpeningBalance(req.organizationId);
        const filter = transactionDateFilter(range, 2, 'ft');

        const result = await db.query(`
            SELECT
                COALESCE(
                    SUM(
                        CASE
                            WHEN ft."TransactionType" = 'INCOME' THEN ft."Amount"
                            WHEN ft."TransactionType" = 'EXPENSE' THEN -ft."Amount"
                            ELSE 0
                        END
                    ),
                    0
                ) AS "NetMovement",
                COUNT(*) AS "TransactionCount",
                MAX(ft."TransactionDate") AS "LastTransactionDate"
            FROM "FinancialTransactions" ft
            WHERE ft."OrganizationId" = $1
              ${filter.clause}
        `, [req.organizationId, ...filter.params]);

        const bookBalance = openingBalance + Number(result.rows[0]?.NetMovement || 0);

        res.json({
            success:true,
            openingBalance,
            bookBalance,
            bankStatementBalance:null,
            outstandingDeposits:0,
            unpresentedPayments:0,
            difference:null,
            transactionCount:Number(result.rows[0]?.TransactionCount || 0),
            lastTransactionDate:result.rows[0]?.LastTransactionDate || null,
            status:'READY_FOR_MANUAL_BANK_STATEMENT',
            note:'Enter the bank statement closing balance during final reconciliation to calculate difference.'
        });
    } catch (err) {
        console.error(err);
        handleRouteError(res, err);
    }
});

module.exports = router;

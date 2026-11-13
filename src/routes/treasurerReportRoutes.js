const express = require('express');
const router = express.Router();
const { liveAmountPaidSql, liveBalanceSql } = require('../services/obligationBalanceService');

const db = require('../db');

const NON_BANK_PAYMENT_METHODS = new Set(['', 'CASH', 'OFFSET', 'NON-CASH', 'IN-KIND', 'INKIND', 'WAIVER']);

function isBankReconciliationMethod(paymentMethod) {
    const method = String(paymentMethod || '').trim().toUpperCase();
    return Boolean(method) &&
        !NON_BANK_PAYMENT_METHODS.has(method) &&
        !method.startsWith('CASH');
}

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

async function getOpeningBalanceSettings(organizationId) {
    const result = await db.query(`
        SELECT
            COALESCE("OpeningBalance", 0) AS "OpeningBalance",
            "OpeningBalanceDate"
        FROM "AssociationSettings"
        WHERE "OrganizationId" = $1
        LIMIT 1
    `, [organizationId]);

    return {
        openingBalance:Number(result.rows[0]?.OpeningBalance || 0),
        openingBalanceDate:result.rows[0]?.OpeningBalanceDate || null
    };
}

async function getOpeningBalance(organizationId) {
    return (await getOpeningBalanceSettings(organizationId)).openingBalance;
}

function cashRangeFromOpeningBalance(range, openingBalanceDate) {
    if (!openingBalanceDate) {
        return range;
    }

    return {
        ...range,
        fromDate:!range.fromDate || range.fromDate < openingBalanceDate
            ? openingBalanceDate
            : range.fromDate
    };
}

async function getCashTotals(organizationId, range = {}) {
    const openingSettings = await getOpeningBalanceSettings(organizationId);
    const effectiveRange = cashRangeFromOpeningBalance(range, openingSettings.openingBalanceDate);
    const filter = transactionDateFilter(effectiveRange, 2, 'ft');

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
          AND COALESCE(ft."Status", 'POSTED') = 'POSTED'
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
        const totals = await getCashTotals(req.organizationId, { toDate:range.toDate });

        const liveReceivableBalanceSql = liveBalanceSql('o');
        const receivableResult = await db.query(`
            SELECT COALESCE(SUM(${liveReceivableBalanceSql}), 0) AS "Receivables"
            FROM "Obligations" o
            WHERE o."OrganizationId" = $1
              AND ${liveReceivableBalanceSql} > 0
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
              AND COALESCE(ft."Status", 'POSTED') = 'POSTED'
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
              AND COALESCE(ft."Status", 'POSTED') = 'POSTED'
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

router.get('/income-expenditure-notes', async (req, res) => {
    try {
        const range = getReportDateRange(req);
        const filter = transactionDateFilter(range, 2, 'ft');
        const entriesResult = await db.query(`
            SELECT
                ft."TransactionType",
                COALESCE(ft."Category", 'Uncategorized') AS "Category",
                ft."TransactionDate",
                COALESCE(ft."Description", '') AS "Description",
                COALESCE(ft."Reference", '') AS "Reference",
                COALESCE(ft."PaymentMethod", '') AS "PaymentMethod",
                ft."Amount"
            FROM "FinancialTransactions" ft
            WHERE ft."OrganizationId" = $1
              AND ft."TransactionType" IN ('INCOME', 'EXPENSE')
              AND COALESCE(ft."Status", 'POSTED') = 'POSTED'
              ${filter.clause}
            ORDER BY
                ft."TransactionType",
                COALESCE(ft."Category", 'Uncategorized'),
                ft."TransactionDate",
                ft."CreatedAt",
                ft."Id"
        `, [req.organizationId, ...filter.params]);

        const grouped = entriesResult.rows.reduce((notes, entry) => {
            const type = entry.TransactionType === 'INCOME' ? 'income' : 'expense';
            const key = `${type}:${entry.Category}`;
            let note = notes.get(key);

            if (!note) {
                note = {
                    type,
                    category:entry.Category,
                    total:0,
                    entries:[]
                };
                notes.set(key, note);
            }

            const amount = Number(entry.Amount || 0);
            note.total += amount;
            note.entries.push({
                date:entry.TransactionDate,
                description:entry.Description,
                reference:entry.Reference,
                paymentMethod:entry.PaymentMethod,
                amount
            });

            return notes;
        }, new Map());

        res.json({
            success:true,
            fromDate:range.fromDateText,
            toDate:range.toDateText,
            notes:Array.from(grouped.values())
        });
    } catch (err) {
        console.error(err);
        handleRouteError(res, err);
    }
});

router.get('/member-contributions-note', async (req, res) => {
    try {
        const range = getReportDateRange(req);
        const filter = transactionDateFilter(range, 2, 'ft');
        const result = await db.query(`
            WITH contribution_transactions AS (
                SELECT
                    ft."Id" AS "TransactionId",
                    ft."Source",
                    ft."SourceId",
                    ft."Amount"
                FROM "FinancialTransactions" ft
                WHERE ft."OrganizationId" = $1
                  AND ft."TransactionType" = 'INCOME'
                  AND COALESCE(ft."Category", 'Uncategorized') = 'Member Contributions'
                  AND COALESCE(ft."Status", 'POSTED') = 'POSTED'
                  ${filter.clause}
            ),
            allocations AS (
                SELECT
                    ct."TransactionId",
                    p."MemberId",
                    COALESCE(o."Description", 'Unallocated Member Credit') AS "Obligation",
                    SUM( COALESCE(pa."Amount", pa."AmountAllocated", 0) * ct."Amount" / NULLIF(COALESCE(p."Amount", p."AmountPaid", 0), 0) ) AS "Amount"
                FROM contribution_transactions ct
                INNER JOIN "Payments" p
                    ON p."Id" = ct."SourceId"
                    AND p."OrganizationId" = $1
                    AND COALESCE(p."Status", 'POSTED') = 'POSTED'
                INNER JOIN "PaymentAllocations" pa
                    ON pa."PaymentId" = p."Id"
                    AND pa."OrganizationId" = $1
                LEFT JOIN "Obligations" o
                    ON o."Id" = pa."ObligationId"
                    AND o."OrganizationId" = $1
                WHERE ct."Source" = 'MEMBER_PAYMENT'
                GROUP BY ct."TransactionId", p."MemberId", COALESCE(o."Description", 'Unallocated Member Credit')
            ),
            unallocated AS (
                SELECT
                    p."MemberId",
                    'Unallocated Member Credit' AS "Obligation",
                    ct."Amount" - COALESCE(SUM(a."Amount"), 0) AS "Amount"
                FROM contribution_transactions ct
                INNER JOIN "Payments" p
                    ON p."Id" = ct."SourceId"
                    AND p."OrganizationId" = $1
                    AND COALESCE(p."Status", 'POSTED') = 'POSTED'
                LEFT JOIN allocations a ON a."TransactionId" = ct."TransactionId"
                WHERE ct."Source" = 'MEMBER_PAYMENT'
                GROUP BY ct."TransactionId", p."MemberId", ct."Amount"
                HAVING ct."Amount" - COALESCE(SUM(a."Amount"), 0) > 0
            ),
            unlinked AS (
                SELECT ct."Amount" AS "Amount"
                FROM contribution_transactions ct
                LEFT JOIN "Payments" p
                    ON p."Id" = ct."SourceId"
                    AND p."OrganizationId" = $1
                    AND COALESCE(p."Status", 'POSTED') = 'POSTED'
                WHERE ct."Source" IS DISTINCT FROM 'MEMBER_PAYMENT'
                   OR p."Id" IS NULL
            ),
            contribution_rows AS (
                SELECT "MemberId", "Obligation", "Amount" FROM allocations
                UNION ALL
                SELECT "MemberId", "Obligation", "Amount" FROM unallocated
                UNION ALL
                SELECT NULL::uuid AS "MemberId", 'Unallocated Member Contribution' AS "Obligation", "Amount" FROM unlinked
            )
            SELECT
                COALESCE(m."MemberNo", m."MemberNumber", 'UNLINKED') AS "MemberNo",
                COALESCE(
                    NULLIF(TRIM(CONCAT_WS(' ', m."FirstName", m."OtherName", m."Surname")), ''),
                    'Unlinked cashbook receipt'
                ) AS "MemberName",
                cr."Obligation",
                SUM(cr."Amount") AS "Amount"
            FROM contribution_rows cr
            LEFT JOIN "Members" m
                ON m."Id" = cr."MemberId"
                AND m."OrganizationId" = $1
            GROUP BY
                COALESCE(m."MemberNo", m."MemberNumber", 'UNLINKED'),
                COALESCE(NULLIF(TRIM(CONCAT_WS(' ', m."FirstName", m."OtherName", m."Surname")), ''), 'Unlinked cashbook receipt'),
                cr."Obligation"
            ORDER BY "MemberName", "Obligation"
        `, [req.organizationId, ...filter.params]);

        res.json({ success:true, data:result.rows });
    } catch (err) {
        console.error(err);
        handleRouteError(res, err);
    }
});
router.get('/outstanding-members-summary', async (req, res) => {
    try {
        const balanceSql = liveBalanceSql('o');
        const result = await db.query(`
            SELECT
                COALESCE(m."MemberNo", m."MemberNumber") AS "MemberNo",
                TRIM(CONCAT_WS(' ', m."FirstName", m."OtherName", m."Surname")) AS "MemberName",
                COALESCE(o."Description", 'Uncategorized Obligation') AS "Obligation",
                SUM(${balanceSql}) AS "Balance"
            FROM "Obligations" o
            INNER JOIN "Members" m ON m."Id" = o."MemberId" AND m."OrganizationId" = o."OrganizationId"
            WHERE o."OrganizationId" = $1 AND ${balanceSql} > 0
            GROUP BY COALESCE(m."MemberNo", m."MemberNumber"), TRIM(CONCAT_WS(' ', m."FirstName", m."OtherName", m."Surname")), COALESCE(o."Description", 'Uncategorized Obligation')
            ORDER BY "MemberName", "Obligation"
        `, [req.organizationId]);

        res.json({ success:true, data:result.rows });
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

        const liveReceivableBalanceSql = liveBalanceSql('o');
        const receivableResult = await db.query(`
            SELECT COALESCE(SUM(${liveReceivableBalanceSql}), 0) AS "Receivables"
            FROM "Obligations" o
            WHERE o."OrganizationId" = $1
              AND ${liveReceivableBalanceSql} > 0
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
        const amountPaidSql = liveAmountPaidSql('o');
        const balanceSql = liveBalanceSql('o');
        const result = await db.query(`
            SELECT
                COALESCE(m."MemberNo", m."MemberNumber") AS "MemberNo",
                COALESCE(m."Surname", '') AS "Surname",
                COALESCE(m."FirstName", '') AS "FirstName",
                o."Description", o."AmountDue", ${amountPaidSql} AS "AmountPaid", ${balanceSql} AS "Balance", o."DueDate"
            FROM "Obligations" o
            INNER JOIN "Members" m ON o."MemberId" = m."Id" AND o."OrganizationId" = m."OrganizationId"
            WHERE o."OrganizationId" = $1 AND ${balanceSql} > 0
            ORDER BY COALESCE(m."Surname", ''), COALESCE(m."FirstName", ''), o."DueDate"
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
        const openingSettings = await getOpeningBalanceSettings(req.organizationId);
        const effectiveRange = cashRangeFromOpeningBalance(range, openingSettings.openingBalanceDate);

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
              AND COALESCE("Status", 'POSTED') = 'POSTED'
              AND ($3::date IS NULL OR "TransactionDate" >= $3::date)
              AND ($2::date IS NULL OR "TransactionDate" < $2::date)
        `, [
            req.organizationId,
            effectiveRange.fromDate,
            openingSettings.openingBalanceDate
        ]);

        const filter = transactionDateFilter(effectiveRange, 2, 'ft');
        const movementResult = await db.query(`
            SELECT
                ft."TransactionType",
                COALESCE(ft."PaymentMethod", 'Unspecified') AS "PaymentMethod",
                SUM(ft."Amount") AS "Amount"
            FROM "FinancialTransactions" ft
            WHERE ft."OrganizationId" = $1
              AND COALESCE(ft."Status", 'POSTED') = 'POSTED'
              ${filter.clause}
            GROUP BY
                ft."TransactionType",
                COALESCE(ft."PaymentMethod", 'Unspecified')
            ORDER BY
                ft."TransactionType",
                "PaymentMethod"
        `, [req.organizationId, ...filter.params]);

        const openingCash = openingSettings.openingBalance + Number(priorResult.rows[0]?.PriorMovement || 0);
        const receipts = movementResult.rows.filter(row => row.TransactionType === 'INCOME');
        const payments = movementResult.rows.filter(row => row.TransactionType === 'EXPENSE');
        const totalReceipts = receipts.reduce((sum, row) => sum + Number(row.Amount || 0), 0);
        const totalPayments = payments.reduce((sum, row) => sum + Number(row.Amount || 0), 0);
        const bankReceipts = receipts
            .filter(row => isBankReconciliationMethod(row.PaymentMethod))
            .reduce((sum, row) => sum + Number(row.Amount || 0), 0);
        const bankPayments = payments
            .filter(row => isBankReconciliationMethod(row.PaymentMethod))
            .reduce((sum, row) => sum + Number(row.Amount || 0), 0);
        const closingCashPosition = openingCash + totalReceipts - totalPayments;
        const closingBankBalance = openingSettings.openingBalance + bankReceipts - bankPayments;

        res.json({
            success:true,
            fromDate:range.fromDateText,
            toDate:range.toDateText,
            openingCash,
            receipts,
            payments,
            totalReceipts,
            totalPayments,
            closingCash:closingCashPosition,
            closingBankBalance,
            netNonBankMovement:(totalReceipts - totalPayments) - (bankReceipts - bankPayments),
            openingBalanceDate:openingSettings.openingBalanceDate,
            effectiveFromDate:effectiveRange.fromDate
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

        const amountPaidSql = liveAmountPaidSql('o');
        const balanceSql = liveBalanceSql('o');
        const result = await db.query(`
            SELECT
                COALESCE(c."CampaignCode", 'MANUAL') AS "CampaignCode",
                COALESCE(c."CampaignName", o."Description") AS "CampaignName",
                COUNT(o."Id") AS "AssignedMembers",
                COALESCE(SUM(o."AmountDue"), 0) AS "AmountDue",
                COALESCE(SUM(${amountPaidSql}), 0) AS "AmountPaid",
                COALESCE(SUM(o."WaivedAmount"), 0) AS "WaivedAmount",
                COALESCE(SUM(${balanceSql}), 0) AS "Balance",
                SUM(CASE WHEN ${balanceSql} <= 0 THEN 1 ELSE 0 END) AS "FullyPaidMembers"
            FROM "Obligations" o
            LEFT JOIN "Campaigns" c ON o."CampaignId" = c."Id" AND o."OrganizationId" = c."OrganizationId"
            WHERE o."OrganizationId" = $1
              ${filter.clause}
            GROUP BY COALESCE(c."CampaignCode", 'MANUAL'), COALESCE(c."CampaignName", o."Description")
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
              AND COALESCE(ft."Status", 'POSTED') = 'POSTED'
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

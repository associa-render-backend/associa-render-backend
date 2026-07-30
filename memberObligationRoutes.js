const express = require('express');
const router = express.Router();

const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');
const { authorizeRoles, requireOrganization, requirePermission } = require('../middleware/authorizationMiddleware');
const { writeAuditEvent } = require('../services/auditService');

router.use(authMiddleware, requireOrganization, requirePermission('bankReconciliation.view'));

function userName(req) { return req.user?.fullName || req.user?.email || 'System User'; }
function money(value) { return Number(value || 0); }
function invalidUuidError(err) { return /invalid input syntax for type uuid/i.test(err.message || ''); }

function validatePeriod(periodStart, periodEnd) {
    if (!periodStart || !periodEnd || Number.isNaN(Date.parse(periodStart)) || Number.isNaN(Date.parse(periodEnd))) {
        return 'Valid period start and end dates are required';
    }
    if (new Date(periodStart) > new Date(periodEnd)) return 'Period start cannot be after period end';
    return null;
}

async function getOpeningSettings(organizationId) {
    const result = await db.query(`
        SELECT COALESCE("OpeningBalance", 0) AS "OpeningBalance", "OpeningBalanceDate"
        FROM "AssociationSettings"
        WHERE "OrganizationId" = $1
        LIMIT 1
    `, [organizationId]);
    return result.rows.length ? {
        openingBalance:Number(result.rows[0].OpeningBalance || 0),
        openingBalanceDate:result.rows[0].OpeningBalanceDate || null
    } : { openingBalance:0, openingBalanceDate:null };
}

async function calculateBookPosition({ organizationId, periodStart, periodEnd }) {
    const opening = await getOpeningSettings(organizationId);
    const balanceResult = await db.query(`
        SELECT COALESCE(SUM(CASE WHEN "TransactionType" = 'INCOME' THEN "Amount" ELSE -"Amount" END), 0) AS "MovementToDate"
        FROM "FinancialTransactions"
        WHERE "OrganizationId" = $1
          AND "TransactionDate" <= $2::date
          AND ($3::date IS NULL OR "TransactionDate" >= $3::date)
    `, [organizationId, periodEnd, opening.openingBalanceDate]);
    const periodResult = await db.query(`
        SELECT COALESCE(SUM(CASE WHEN "TransactionType" = 'INCOME' THEN "Amount" ELSE 0 END), 0) AS "PeriodIncome",
               COALESCE(SUM(CASE WHEN "TransactionType" = 'EXPENSE' THEN "Amount" ELSE 0 END), 0) AS "PeriodExpense",
               COUNT(*) AS "TransactionCount"
        FROM "FinancialTransactions"
        WHERE "OrganizationId" = $1
          AND "TransactionDate" >= $2::date
          AND "TransactionDate" <= $3::date
    `, [organizationId, periodStart, periodEnd]);
    return {
        openingBalance:opening.openingBalance,
        openingBalanceDate:opening.openingBalanceDate,
        bookBalance:opening.openingBalance + Number(balanceResult.rows[0].MovementToDate || 0),
        periodIncome:Number(periodResult.rows[0].PeriodIncome || 0),
        periodExpense:Number(periodResult.rows[0].PeriodExpense || 0),
        transactionCount:Number(periodResult.rows[0].TransactionCount || 0)
    };
}

async function loadTransactions({ organizationId, periodStart, periodEnd, reconciliationId }) {
    const result = await db.query(`
        SELECT t."Id", t."TransactionDate", t."TransactionType", t."Category", t."Description", t."Amount",
               t."Reference", t."PaymentMethod", t."Source", i."ReconciliationStatus", i."ClearedDate", i."Notes" AS "ReconciliationNotes"
        FROM "FinancialTransactions" t
        LEFT JOIN "BankReconciliationItems" i
            ON i."TransactionId" = t."Id" AND i."ReconciliationId" = $4::uuid
        WHERE t."OrganizationId" = $1
          AND t."TransactionDate" >= $2::date
          AND t."TransactionDate" <= $3::date
        ORDER BY t."TransactionDate" ASC, t."CreatedAt" ASC, t."Id" ASC
    `, [organizationId, periodStart, periodEnd, reconciliationId || null]);
    return result.rows;
}

function calculateReconciliation({ bookBalance, bankStatementBalance, transactions, clearedTransactionIds }) {
    const cleared = new Set((clearedTransactionIds || []).map(String));
    let outstandingDeposits = 0;
    let unpresentedPayments = 0;
    transactions.forEach(transaction => {
        if (cleared.has(String(transaction.Id))) return;
        if (transaction.TransactionType === 'INCOME') outstandingDeposits += money(transaction.Amount);
        else unpresentedPayments += money(transaction.Amount);
    });
    const adjustedBankBalance = money(bankStatementBalance) + outstandingDeposits - unpresentedPayments;
    return { outstandingDeposits, unpresentedPayments, adjustedBankBalance, difference:money(bookBalance) - adjustedBankBalance };
}

router.get('/working-paper', async (req, res) => {
    try {
        const { periodStart, periodEnd, reconciliationId } = req.query;
        const periodError = validatePeriod(periodStart, periodEnd);
        if (periodError) return res.status(400).json({ success:false, message:periodError });
        const position = await calculateBookPosition({ organizationId:req.organizationId, periodStart, periodEnd });
        const transactions = await loadTransactions({ organizationId:req.organizationId, periodStart, periodEnd, reconciliationId });
        res.json({ success:true, data:{ periodStart, periodEnd, ...position, transactions } });
    } catch (err) { console.error(err); res.status(500).json({ success:false, message:'Unable to prepare bank reconciliation working paper' }); }
});

router.get('/history', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT "Id", "PeriodStart", "PeriodEnd", "BankStatementBalance", "BookBalance", "OutstandingDeposits",
                   "UnpresentedPayments", "AdjustedBankBalance", "Difference", "Status", "PreparedBy", "FinalizedBy", "FinalizedAt", "CreatedAt", "UpdatedAt"
            FROM "BankReconciliations"
            WHERE "OrganizationId" = $1
            ORDER BY "PeriodEnd" DESC, "CreatedAt" DESC
            LIMIT 50
        `, [req.organizationId]);
        res.json({ success:true, data:result.rows });
    } catch (err) { console.error(err); res.status(500).json({ success:false, message:'Unable to load reconciliation history' }); }
});

router.get('/:id', async (req, res) => {
    try {
        const headerResult = await db.query(`SELECT * FROM "BankReconciliations" WHERE "Id" = $1 AND "OrganizationId" = $2 LIMIT 1`, [req.params.id, req.organizationId]);
        if (headerResult.rows.length === 0) return res.status(404).json({ success:false, message:'Reconciliation not found' });
        const itemResult = await db.query(`
            SELECT i."Id", i."TransactionId", i."ReconciliationStatus", i."ClearedDate", i."Notes",
                   t."TransactionDate", t."TransactionType", t."Category", t."Description", t."Amount", t."Reference", t."PaymentMethod", t."Source"
            FROM "BankReconciliationItems" i
            INNER JOIN "FinancialTransactions" t ON i."TransactionId" = t."Id"
            WHERE i."ReconciliationId" = $1
            ORDER BY t."TransactionDate" ASC, t."CreatedAt" ASC, t."Id" ASC
        `, [req.params.id]);
        res.json({ success:true, data:{ ...headerResult.rows[0], items:itemResult.rows } });
    } catch (err) { console.error(err); res.status(invalidUuidError(err) ? 400 : 500).json({ success:false, message:invalidUuidError(err) ? 'Invalid reconciliation ID' : 'Unable to load reconciliation' }); }
});

router.post('/', authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER'), async (req, res) => {
    try {
        const { periodStart, periodEnd, bankStatementBalance, clearedTransactionIds, notes } = req.body;
        const periodError = validatePeriod(periodStart, periodEnd);
        if (periodError) return res.status(400).json({ success:false, message:periodError });
        if (!Number.isFinite(Number(bankStatementBalance))) return res.status(400).json({ success:false, message:'Bank statement balance must be a valid amount' });
        const position = await calculateBookPosition({ organizationId:req.organizationId, periodStart, periodEnd });
        const transactions = await loadTransactions({ organizationId:req.organizationId, periodStart, periodEnd });
        const totals = calculateReconciliation({ bookBalance:position.bookBalance, bankStatementBalance, transactions, clearedTransactionIds });
        const output = await db.transaction(async tx => {
            const header = await tx.query(`
                INSERT INTO "BankReconciliations"
                ("OrganizationId", "PeriodStart", "PeriodEnd", "BankStatementBalance", "BookBalance", "OutstandingDeposits", "UnpresentedPayments", "AdjustedBankBalance", "Difference", "Status", "Notes", "PreparedBy", "CreatedAt", "UpdatedAt")
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10,$11,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
                RETURNING "Id"
            `, [req.organizationId, periodStart, periodEnd, Number(bankStatementBalance), position.bookBalance, totals.outstandingDeposits, totals.unpresentedPayments, totals.adjustedBankBalance, totals.difference, notes || null, userName(req)]);
            const reconciliationId = header.rows[0].Id;
            const cleared = new Set((clearedTransactionIds || []).map(String));
            for (const item of transactions) {
                const status = cleared.has(String(item.Id)) ? 'CLEARED' : item.TransactionType === 'INCOME' ? 'OUTSTANDING_DEPOSIT' : 'UNPRESENTED_PAYMENT';
                await tx.query(`
                    INSERT INTO "BankReconciliationItems"
                    ("ReconciliationId", "TransactionId", "ReconciliationStatus", "ClearedDate", "CreatedAt", "UpdatedAt")
                    VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
                `, [reconciliationId, item.Id, status, status === 'CLEARED' ? periodEnd : null]);
            }
            await writeAuditEvent({ dbClient:tx, req, organizationId:req.organizationId, action:'CREATE', entityType:'BANK_RECONCILIATION', entityId:reconciliationId, summary:'Bank reconciliation draft prepared', afterData:{ periodStart, periodEnd, bankStatementBalance, ...position, ...totals } });
            return reconciliationId;
        });
        res.json({ success:true, message:'Bank reconciliation saved as draft', data:{ id:output, ...position, ...totals } });
    } catch (err) { console.error(err); res.status(500).json({ success:false, message:'Unable to save bank reconciliation' }); }
});

router.post('/:id/finalize', authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER'), async (req, res) => {
    try {
        const result = await db.query(`
            UPDATE "BankReconciliations"
            SET "Status" = 'FINALIZED', "FinalizedBy" = $1, "FinalizedAt" = CURRENT_TIMESTAMP, "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Id" = $2 AND "OrganizationId" = $3 AND "Status" <> 'FINALIZED'
            RETURNING *
        `, [userName(req), req.params.id, req.organizationId]);
        if (result.rows.length === 0) return res.status(404).json({ success:false, message:'Draft reconciliation not found or already finalized' });
        await writeAuditEvent({ req, organizationId:req.organizationId, action:'FINALIZE', entityType:'BANK_RECONCILIATION', entityId:req.params.id, summary:'Bank reconciliation finalized', afterData:result.rows[0] });
        res.json({ success:true, message:'Bank reconciliation finalized', data:result.rows[0] });
    } catch (err) { console.error(err); res.status(invalidUuidError(err) ? 400 : 500).json({ success:false, message:invalidUuidError(err) ? 'Invalid reconciliation ID' : 'Unable to finalize reconciliation' }); }
});

module.exports = router;

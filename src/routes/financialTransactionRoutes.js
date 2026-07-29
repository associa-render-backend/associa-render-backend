const express = require('express');
const router = express.Router();

const db = require('../db');

const authMiddleware = require('../middleware/authMiddleware');

const {
    authorizeRoles,
    requireOrganization,
    requirePermission
} = require('../middleware/authorizationMiddleware');

const {
    writeAuditEvent
} = require('../services/auditService');

const PROTECTED_SOURCES = new Set([
    'MEMBER_PAYMENT',
    'SYSTEM_GENERATED',
    'AUTO_POSTED',
    'PAYMENT_REVERSAL'
]);

function actorName(req) {
    return req.user?.fullName || req.user?.email || 'System User';
}

function cleanText(value, maxLength) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maxLength) : null;
}

function invalidUuidError(err) {
    return /invalid input syntax for type uuid/i.test(err.message || '');
}

async function getOpeningBalanceSettings(organizationId, runner = db) {
    const result = await runner.query(`
        SELECT
            COALESCE("OpeningBalance", 0) AS "OpeningBalance",
            "OpeningBalanceDate"
        FROM "AssociationSettings"
        WHERE "OrganizationId" = $1
        LIMIT 1
    `, [organizationId]);

    if (result.rows.length === 0) {
        return {
            openingBalance:0,
            openingBalanceDate:null
        };
    }

    return {
        openingBalance:Number(result.rows[0].OpeningBalance || 0),
        openingBalanceDate:result.rows[0].OpeningBalanceDate || null
    };
}

router.use(
    authMiddleware,
    requireOrganization,
    requirePermission('cashbook.view')
);

router.get('/', async (req, res) => {
    try {
        const openingSettings = await getOpeningBalanceSettings(req.organizationId);

        const result = await db.query(`
            SELECT
                "Id",
                "TransactionDate",
                "TransactionType",
                "Category",
                "Description",
                "Amount",
                "Reference",
                "PaymentMethod",
                "Source",
                "Status",
                "ReversalOfId",
                "ReversedByTransactionId",
                "ReversedAt",
                "ReversedBy",
                "ReversalReason",
                "CreatedBy",
                "CreatedAt"
            FROM "FinancialTransactions"
            WHERE "OrganizationId" = $1
              AND (
                    $2::date IS NULL
                    OR "TransactionDate" >= $2::date
              )
            ORDER BY
                "TransactionDate" ASC,
                "CreatedAt" ASC,
                "Id" ASC
        `, [req.organizationId, openingSettings.openingBalanceDate]);

        let runningBalance = openingSettings.openingBalance;

        const ledger = result.rows.map(row => {
            const amount = Number(row.Amount || 0);

            if (row.TransactionType === 'INCOME') {
                runningBalance += amount;
            } else {
                runningBalance -= amount;
            }

            return {
                ...row,
                RunningBalance:runningBalance
            };
        });

        res.json({
            success:true,
            data:ledger,
            openingBalance:openingSettings.openingBalance,
            openingBalanceDate:openingSettings.openingBalanceDate
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success:false,
            message:err.message
        });
    }
});

router.get('/summary', async (req, res) => {
    try {
        const openingSettings = await getOpeningBalanceSettings(req.organizationId);

        const summaryResult = await db.query(`
            SELECT
                COALESCE(
                    SUM(
                        CASE
                            WHEN "TransactionType" = 'INCOME'
                            THEN "Amount"
                            ELSE 0
                        END
                    ),
                    0
                ) AS "TotalIncome",
                COALESCE(
                    SUM(
                        CASE
                            WHEN "TransactionType" = 'EXPENSE'
                            THEN "Amount"
                            ELSE 0
                        END
                    ),
                    0
                ) AS "TotalExpense",
                COUNT(*) AS "TotalTransactions"
            FROM "FinancialTransactions"
            WHERE "OrganizationId" = $1
              AND (
                    $2::date IS NULL
                    OR "TransactionDate" >= $2::date
              )
        `, [req.organizationId, openingSettings.openingBalanceDate]);

        const row = summaryResult.rows[0] || {};
        const totalIncome = Number(row.TotalIncome || 0);
        const totalExpense = Number(row.TotalExpense || 0);
        const cashPosition = openingSettings.openingBalance + totalIncome - totalExpense;

        res.json({
            success:true,
            totalIncome,
            totalExpense,
            cashPosition,
            openingBalance:openingSettings.openingBalance,
            openingBalanceDate:openingSettings.openingBalanceDate,
            totalTransactions:Number(row.TotalTransactions || 0)
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success:false,
            message:err.message
        });
    }
});

router.get('/opening-balance', async (req, res) => {
    try {
        const settings = await getOpeningBalanceSettings(req.organizationId);

        res.json({
            success:true,
            data:settings
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success:false,
            message:err.message
        });
    }
});

router.put(
    '/opening-balance',
    authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER'),
    async (req, res) => {
        try {
            const beforeSettings = await getOpeningBalanceSettings(req.organizationId);
            const openingBalance = Number(req.body.openingBalance);
            const openingBalanceDate = req.body.openingBalanceDate;

            if (!Number.isFinite(openingBalance)) {
                return res.status(400).json({
                    success:false,
                    message:'Opening balance must be a valid number'
                });
            }

            if (!openingBalanceDate || Number.isNaN(Date.parse(openingBalanceDate))) {
                return res.status(400).json({
                    success:false,
                    message:'Opening balance date is required'
                });
            }

            await db.query(`
                INSERT INTO "AssociationSettings"
                (
                    "OrganizationId",
                    "AssociationName",
                    "OpeningBalance",
                    "OpeningBalanceDate",
                    "CreatedAt",
                    "UpdatedAt"
                )
                VALUES
                (
                    $1,
                    COALESCE(
                        (
                            SELECT "Name"
                            FROM "Organizations"
                            WHERE "Id" = $1
                            LIMIT 1
                        ),
                        'Association'
                    ),
                    $2,
                    $3,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                )
                ON CONFLICT ("OrganizationId")
                DO UPDATE SET
                    "OpeningBalance" = EXCLUDED."OpeningBalance",
                    "OpeningBalanceDate" = EXCLUDED."OpeningBalanceDate",
                    "UpdatedAt" = CURRENT_TIMESTAMP
            `, [req.organizationId, openingBalance, openingBalanceDate]);

            await writeAuditEvent({
                req,
                organizationId:req.organizationId,
                action:'UPDATE',
                entityType:'CASHBOOK_OPENING_BALANCE',
                entityId:req.organizationId,
                summary:'Cashbook opening balance updated',
                beforeData:beforeSettings,
                afterData:{
                    openingBalance,
                    openingBalanceDate
                }
            });

            res.json({
                success:true,
                message:'Opening balance saved successfully'
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success:false,
                message:err.message
            });
        }
    }
);

router.get('/:id', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT *
            FROM "FinancialTransactions"
            WHERE "Id" = $1
              AND "OrganizationId" = $2
            LIMIT 1
        `, [req.params.id, req.organizationId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success:false,
                message:'Transaction not found'
            });
        }

        res.json({
            success:true,
            data:result.rows[0]
        });
    } catch (err) {
        console.error(err);

        res.status(invalidUuidError(err) ? 400 : 500).json({
            success:false,
            message:invalidUuidError(err) ? 'Invalid transaction ID' : err.message
        });
    }
});

router.post(
    '/',
    authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER', 'DATA_ENTRY'),
    async (req, res) => {
        try {
            const transactionDate = req.body.transactionDate || null;
            const normalizedType = String(req.body.transactionType || '').toUpperCase();
            const normalizedMethod = String(req.body.paymentMethod || 'CASH').toUpperCase();
            const category = cleanText(req.body.category, 255);
            const description = cleanText(req.body.description, 1000);
            const reference = cleanText(req.body.reference, 255);
            const amount = Number(req.body.amount);

            if (!['INCOME', 'EXPENSE'].includes(normalizedType)) {
                return res.status(400).json({
                    success:false,
                    message:'Transaction type must be INCOME or EXPENSE'
                });
            }

            if (!category) {
                return res.status(400).json({
                    success:false,
                    message:'Category is required'
                });
            }

            if (!Number.isFinite(amount) || amount <= 0) {
                return res.status(400).json({
                    success:false,
                    message:'Amount must be greater than zero'
                });
            }

            const insertResult = await db.query(`
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
                    $1,
                    COALESCE($2::date, CURRENT_DATE),
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    'MANUAL',
                    $9,
                    CURRENT_TIMESTAMP,
                    'POSTED'
                )
                RETURNING "Id"
            `, [
                req.organizationId,
                transactionDate,
                normalizedType,
                category,
                description,
                amount,
                reference,
                normalizedMethod,
                actorName(req)
            ]);

            const transactionId = insertResult.rows[0].Id;

            await writeAuditEvent({
                req,
                organizationId:req.organizationId,
                action:'CREATE',
                entityType:'CASHBOOK_TRANSACTION',
                entityId:transactionId,
                summary:`Manual ${normalizedType.toLowerCase()} Cashbook entry created`,
                afterData:{
                    id:transactionId,
                    transactionDate,
                    transactionType:normalizedType,
                    category,
                    description,
                    amount,
                    reference,
                    paymentMethod:normalizedMethod,
                    source:'MANUAL'
                }
            });

            res.json({
                success:true,
                message:'Cashbook entry saved successfully'
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success:false,
                message:err.message
            });
        }
    }
);

router.delete(
    '/:id',
    authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER'),
    async (req, res) => {
        try {
            const output = await db.transaction(async tx => {
                const check = await tx.query(`
                    SELECT *
                    FROM "FinancialTransactions"
                    WHERE "Id" = $1
                      AND "OrganizationId" = $2
                    LIMIT 1
                    FOR UPDATE
                `, [req.params.id, req.organizationId]);

                if (check.rows.length === 0) {
                    const error = new Error('Transaction not found');
                    error.statusCode = 404;
                    throw error;
                }

                const transaction = check.rows[0];

                if (PROTECTED_SOURCES.has(String(transaction.Source || '').toUpperCase())) {
                    const error = new Error('Protected system entries cannot be deleted from the Cashbook. Reverse or correct the source record instead.');
                    error.statusCode = 400;
                    throw error;
                }

                await tx.query(`
                    DELETE FROM "FinancialTransactions"
                    WHERE "Id" = $1
                      AND "OrganizationId" = $2
                `, [req.params.id, req.organizationId]);

                await writeAuditEvent({
                    dbClient:tx,
                    req,
                    organizationId:req.organizationId,
                    action:'DELETE',
                    entityType:'CASHBOOK_TRANSACTION',
                    entityId:transaction.Id,
                    summary:'Manual Cashbook entry deleted',
                    beforeData:transaction,
                    metadata:{
                        deletionType:'MANUAL_ENTRY_CORRECTION'
                    }
                });

                return transaction;
            });

            res.json({
                success:true,
                message:'Cashbook entry deleted successfully',
                deletedId:output.Id
            });
        } catch (err) {
            console.error(err);

            res.status(err.statusCode || (invalidUuidError(err) ? 400 : 500)).json({
                success:false,
                message:err.statusCode
                    ? err.message
                    : invalidUuidError(err)
                        ? 'Invalid transaction ID'
                        : err.message
            });
        }
    }
);

module.exports = router;

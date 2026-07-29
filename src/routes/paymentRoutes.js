const express = require('express');
const router = express.Router();

const db = require('../db');

const authMiddleware = require('../middleware/authMiddleware');

const {
    authorizeRoles,
    requireOrganization
} = require('../middleware/authorizationMiddleware');

const {
    writeAuditEvent
} = require('../services/auditService');

const financeAccess = authorizeRoles(
    'SUPER_ADMIN',
    'ADMIN',
    'TREASURER',
    'DATA_ENTRY'
);

router.use(
    authMiddleware,
    requireOrganization,
    financeAccess
);

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

router.get('/', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                p."Id",
                COALESCE(m."MemberNo", m."MemberNumber") AS "MemberNo",
                COALESCE(m."Surname", '') AS "Surname",
                COALESCE(m."FirstName", '') AS "FirstName",
                COALESCE(p."Amount", p."AmountPaid", 0) AS "Amount",
                p."PaymentDate",
                p."PaymentMethod",
                COALESCE(p."Reference", p."PaymentReference") AS "Reference",
                p."Remarks",
                p."Status",
                p."ReversedAt",
                p."ReversedBy",
                p."ReversalReason",
                p."ReversalTransactionId"
            FROM "Payments" p
            INNER JOIN "Members" m
                ON p."MemberId" = m."Id"
                AND p."OrganizationId" = m."OrganizationId"
            WHERE p."OrganizationId" = $1
            ORDER BY
                p."PaymentDate" DESC,
                p."CreatedAt" DESC,
                p."Id"
        `, [req.organizationId]);

        res.json(result.rows);
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success:false,
            message:'Unable to load payments'
        });
    }
});

router.get('/member/:memberId/obligations', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                o."Id",
                o."ObligationType",
                o."Description",
                o."AmountDue",
                o."AmountPaid",
                o."Balance",
                o."DueDate"
            FROM "Obligations" o
            INNER JOIN "Members" m
                ON o."MemberId" = m."Id"
                AND o."OrganizationId" = m."OrganizationId"
            WHERE o."MemberId" = $1
              AND o."OrganizationId" = $2
              AND o."Balance" > 0
            ORDER BY
                o."DueDate",
                o."CreatedAt",
                o."Id"
        `, [req.params.memberId, req.organizationId]);

        res.json(result.rows);
    } catch (err) {
        console.error(err);

        res.status(invalidUuidError(err) ? 400 : 500).json({
            success:false,
            message:invalidUuidError(err)
                ? 'Invalid member ID'
                : 'Unable to load member obligations'
        });
    }
});

router.post('/', async (req, res) => {
    try {
        const memberId = req.body.memberId;
        const obligationId = req.body.obligationId;
        const amount = Number(req.body.amount);
        const paymentMethod = String(req.body.paymentMethod || 'CASH')
            .trim()
            .toUpperCase();
        const remarks = cleanText(req.body.remarks, 1000);

        if (!memberId || !obligationId) {
            return res.status(400).json({
                success:false,
                message:'Member and obligation are required'
            });
        }

        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({
                success:false,
                message:'Payment amount must be greater than zero'
            });
        }

        const allowedMethods = new Set(['CASH', 'TRANSFER', 'POS', 'CHEQUE']);

        if (!allowedMethods.has(paymentMethod)) {
            return res.status(400).json({
                success:false,
                message:'Invalid payment method'
            });
        }

        const output = await db.transaction(async tx => {
            const lookupResult = await tx.query(`
                SELECT
                    m."Id" AS "MemberId",
                    o."Id" AS "ObligationId",
                    o."Description",
                    o."AmountPaid",
                    o."Balance"
                FROM "Members" m
                INNER JOIN "Obligations" o
                    ON o."MemberId" = m."Id"
                    AND o."OrganizationId" = m."OrganizationId"
                WHERE m."Id" = $1
                  AND o."Id" = $2
                  AND m."OrganizationId" = $3
                  AND o."OrganizationId" = $3
                LIMIT 1
                FOR UPDATE OF o, m
            `, [memberId, obligationId, req.organizationId]);

            if (lookupResult.rows.length === 0) {
                const error = new Error('Member obligation not found');
                error.statusCode = 404;
                throw error;
            }

            const obligation = lookupResult.rows[0];
            const oldPaid = Number(obligation.AmountPaid || 0);
            const oldBalance = Number(obligation.Balance || 0);
            const newPaid = oldPaid + amount;
            const rawNewBalance = oldBalance - amount;
            const storedBalance = Math.max(0, rawNewBalance);
            const creditIncrease = Math.max(0, -rawNewBalance);
            const newStatus = storedBalance <= 0 ? 'PAID' : 'PARTLY PAID';

            const paymentResult = await tx.query(`
                INSERT INTO "Payments"
                (
                    "OrganizationId",
                    "MemberId",
                    "Amount",
                    "AmountPaid",
                    "PaymentDate",
                    "PaymentMethod",
                    "Reference",
                    "Remarks",
                    "Status",
                    "CreatedBy",
                    "CreatedAt"
                )
                VALUES
                (
                    $1, $2, $3, $3, CURRENT_DATE, $4, $5,
                    $6, 'POSTED', $7, CURRENT_TIMESTAMP
                )
                RETURNING "Id"
            `, [
                req.organizationId,
                memberId,
                amount,
                paymentMethod,
                obligation.Description || 'Member payment',
                remarks,
                actorName(req)
            ]);

            const paymentId = paymentResult.rows[0].Id;

            await tx.query(`
                UPDATE "Obligations"
                SET
                    "AmountPaid" = $1,
                    "Balance" = $2,
                    "Status" = $3,
                    "UpdatedAt" = CURRENT_TIMESTAMP
                WHERE "Id" = $4
                  AND "OrganizationId" = $5
            `, [newPaid, storedBalance, newStatus, obligationId, req.organizationId]);

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
                VALUES
                (
                    $1, $2, $3, $4, $4,
                    CURRENT_TIMESTAMP, $5, CURRENT_TIMESTAMP
                )
            `, [
                req.organizationId,
                paymentId,
                obligationId,
                amount,
                actorName(req)
            ]);

            const cashbookResult = await tx.query(`
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
                    $1, CURRENT_DATE, 'INCOME', 'Member Contributions',
                    $2, $3, $4, $5, 'MEMBER_PAYMENT', $6,
                    $7, CURRENT_TIMESTAMP, 'POSTED'
                )
                RETURNING "Id"
            `, [
                req.organizationId,
                `Payment for ${obligation.Description || 'member obligation'}`,
                amount,
                paymentId,
                paymentMethod,
                paymentId,
                actorName(req)
            ]);

            if (creditIncrease > 0) {
                await tx.query(`
                    UPDATE "Members"
                    SET
                        "CreditBalance" = COALESCE("CreditBalance", 0) + $1,
                        "UpdatedAt" = CURRENT_TIMESTAMP
                    WHERE "Id" = $2
                      AND "OrganizationId" = $3
                `, [creditIncrease, memberId, req.organizationId]);
            }

            await writeAuditEvent({
                dbClient:tx,
                req,
                organizationId:req.organizationId,
                action:'CREATE',
                entityType:'PAYMENT',
                entityId:paymentId,
                summary:`Payment of ${amount} posted for ${obligation.Description || 'member obligation'}`,
                beforeData:{
                    obligation:{
                        id:obligationId,
                        amountPaid:oldPaid,
                        balance:oldBalance
                    }
                },
                afterData:{
                    payment:{
                        id:paymentId,
                        memberId,
                        obligationId,
                        amount,
                        paymentMethod,
                        status:'POSTED'
                    },
                    obligation:{
                        amountPaid:newPaid,
                        balance:storedBalance,
                        status:newStatus
                    },
                    creditIncrease,
                    cashbookTransactionId:cashbookResult.rows[0].Id
                }
            });

            return {
                paymentId
            };
        });

        res.status(201).json({
            success:true,
            paymentId:output.paymentId,
            message:'Payment posted successfully'
        });
    } catch (err) {
        console.error(err);

        res.status(err.statusCode || (invalidUuidError(err) ? 400 : 500)).json({
            success:false,
            message:err.statusCode
                ? err.message
                : invalidUuidError(err)
                    ? 'Invalid member or obligation ID'
                    : 'Unable to post payment'
        });
    }
});

router.post(
    '/:id/reverse',
    authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER'),
    async (req, res) => {
        const reason = String(req.body.reason || '').trim();

        if (reason.length < 5) {
            return res.status(400).json({
                success:false,
                message:'A reversal reason of at least 5 characters is required'
            });
        }

        try {
            const output = await db.transaction(async tx => {
                const paymentResult = await tx.query(`
                    SELECT
                        p."Id",
                        p."MemberId",
                        COALESCE(p."Amount", p."AmountPaid", 0) AS "Amount",
                        p."PaymentDate",
                        p."PaymentMethod",
                        COALESCE(p."Reference", p."PaymentReference") AS "Reference",
                        p."Remarks",
                        p."Status",
                        p."CreatedAt",
                        m."CreditBalance"
                    FROM "Payments" p
                    INNER JOIN "Members" m
                        ON p."MemberId" = m."Id"
                        AND p."OrganizationId" = m."OrganizationId"
                    WHERE p."Id" = $1
                      AND p."OrganizationId" = $2
                    LIMIT 1
                    FOR UPDATE OF p, m
                `, [req.params.id, req.organizationId]);

                if (paymentResult.rows.length === 0) {
                    const error = new Error('Payment not found');
                    error.statusCode = 404;
                    throw error;
                }

                const payment = paymentResult.rows[0];

                if (String(payment.Status).toUpperCase() !== 'POSTED') {
                    const error = new Error('Only posted payments can be reversed');
                    error.statusCode = 409;
                    throw error;
                }

                const allocationResult = await tx.query(`
                    SELECT
                        allocation."Id",
                        allocation."ObligationId",
                        COALESCE(allocation."Amount", allocation."AmountAllocated", 0) AS "Amount",
                        obligation."AmountDue",
                        obligation."AmountPaid",
                        obligation."WaivedAmount",
                        obligation."Balance",
                        obligation."Status"
                    FROM "PaymentAllocations" allocation
                    INNER JOIN "Obligations" obligation
                        ON allocation."ObligationId" = obligation."Id"
                    WHERE allocation."PaymentId" = $1
                      AND obligation."OrganizationId" = $2
                    ORDER BY allocation."Id"
                    FOR UPDATE OF obligation
                `, [payment.Id, req.organizationId]);

                const beforeObligations = allocationResult.rows.map(row => ({
                    id:row.ObligationId,
                    amountPaid:Number(row.AmountPaid || 0),
                    balance:Number(row.Balance || 0),
                    status:row.Status
                }));

                const afterObligations = [];
                let creditReduction = 0;

                for (const allocation of allocationResult.rows) {
                    const amountDue = Number(allocation.AmountDue || 0);
                    const waivedAmount = Number(allocation.WaivedAmount || 0);
                    const oldPaid = Number(allocation.AmountPaid || 0);
                    const allocatedAmount = Number(allocation.Amount || 0);
                    const payableAmount = Math.max(0, amountDue - waivedAmount);
                    const oldExcess = Math.max(0, oldPaid - payableAmount);
                    const newPaid = Math.max(0, oldPaid - allocatedAmount);
                    const newExcess = Math.max(0, newPaid - payableAmount);
                    const newBalance = Math.max(0, payableAmount - newPaid);
                    const newStatus = newBalance <= 0
                        ? 'PAID'
                        : (newPaid > 0 || waivedAmount > 0)
                            ? 'PARTLY PAID'
                            : 'UNPAID';

                    creditReduction += Math.max(0, oldExcess - newExcess);

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
                        allocation.ObligationId,
                        req.organizationId
                    ]);

                    afterObligations.push({
                        id:allocation.ObligationId,
                        amountPaid:newPaid,
                        balance:newBalance,
                        status:newStatus
                    });
                }

                if (creditReduction > 0) {
                    await tx.query(`
                        UPDATE "Members"
                        SET
                            "CreditBalance" = GREATEST(
                                0,
                                COALESCE("CreditBalance", 0) - $1
                            ),
                            "UpdatedAt" = CURRENT_TIMESTAMP
                        WHERE "Id" = $2
                          AND "OrganizationId" = $3
                    `, [creditReduction, payment.MemberId, req.organizationId]);
                }

                const cashbookResult = await tx.query(`
                    SELECT
                        "Id",
                        "Amount",
                        "Description",
                        "PaymentMethod",
                        "Status"
                    FROM "FinancialTransactions"
                    WHERE "OrganizationId" = $1
                      AND "Reference" = $2
                      AND "Source" = 'MEMBER_PAYMENT'
                    ORDER BY "CreatedAt"
                    LIMIT 1
                    FOR UPDATE
                `, [req.organizationId, String(payment.Id)]);

                const originalCashbook = cashbookResult.rows[0] || null;
                let reversalTransactionId = null;

                if (originalCashbook) {
                    const updateCashbook = await tx.query(`
                        UPDATE "FinancialTransactions"
                        SET
                            "Status" = 'REVERSED',
                            "ReversedAt" = CURRENT_TIMESTAMP,
                            "ReversedBy" = $1,
                            "ReversalReason" = $2
                        WHERE "Id" = $3
                          AND "OrganizationId" = $4
                        RETURNING "Id"
                    `, [actorName(req), reason, originalCashbook.Id, req.organizationId]);

                    const reversalResult = await tx.query(`
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
                            "Status",
                            "ReversalOfId",
                            "ReversalReason"
                        )
                        VALUES
                        (
                            $1, CURRENT_DATE, 'EXPENSE', 'Payment Reversal',
                            'Reversal of member payment', $2, $3, $4,
                            'PAYMENT_REVERSAL', $5, CURRENT_TIMESTAMP,
                            'POSTED', $6, $7
                        )
                        RETURNING "Id"
                    `, [
                        req.organizationId,
                        Number(payment.Amount || 0),
                        String(payment.Id),
                        payment.PaymentMethod || 'CASH',
                        actorName(req),
                        originalCashbook.Id,
                        reason
                    ]);

                    reversalTransactionId = reversalResult.rows[0].Id;

                    await tx.query(`
                        UPDATE "FinancialTransactions"
                        SET "ReversedByTransactionId" = $1
                        WHERE "Id" = $2
                          AND "OrganizationId" = $3
                    `, [
                        reversalTransactionId,
                        updateCashbook.rows[0].Id,
                        req.organizationId
                    ]);
                }

                await tx.query(`
                    UPDATE "Payments"
                    SET
                        "Status" = 'REVERSED',
                        "ReversedAt" = CURRENT_TIMESTAMP,
                        "ReversedBy" = $1,
                        "ReversalReason" = $2,
                        "ReversalTransactionId" = $3,
                        "UpdatedAt" = CURRENT_TIMESTAMP
                    WHERE "Id" = $4
                      AND "OrganizationId" = $5
                `, [
                    actorName(req),
                    reason,
                    reversalTransactionId,
                    payment.Id,
                    req.organizationId
                ]);

                await writeAuditEvent({
                    dbClient:tx,
                    req,
                    organizationId:req.organizationId,
                    action:'REVERSE',
                    entityType:'PAYMENT',
                    entityId:payment.Id,
                    summary:`Payment of ${Number(payment.Amount)} reversed`,
                    beforeData:{
                        payment:{
                            ...payment,
                            CreditBalance:Number(payment.CreditBalance || 0)
                        },
                        obligations:beforeObligations,
                        cashbook:originalCashbook
                    },
                    afterData:{
                        payment:{
                            id:payment.Id,
                            status:'REVERSED',
                            reversedBy:actorName(req),
                            reason,
                            reversalTransactionId
                        },
                        obligations:afterObligations,
                        creditReduction,
                        cashbookReversalId:reversalTransactionId
                    },
                    metadata:{reason}
                });

                return {
                    reversalTransactionId
                };
            });

            res.json({
                success:true,
                reversalTransactionId:output.reversalTransactionId,
                message:'Payment reversed successfully'
            });
        } catch (err) {
            console.error(err);

            res.status(err.statusCode || (invalidUuidError(err) ? 400 : 500)).json({
                success:false,
                message:err.statusCode
                    ? err.message
                    : invalidUuidError(err)
                        ? 'Invalid payment ID'
                        : 'Unable to reverse payment'
            });
        }
    }
);

module.exports = router;

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');
const {
    initializeTransaction,
    verifyTransaction
} = require('../services/paystackService');

function getUserValue(user, ...names) {
    for (const name of names) {
        if (user && user[name]) {
            return user[name];
        }
    }

    return null;
}

function makeReference(organizationId) {
    return [
        'ASSOCIA',
        String(organizationId || '').replace(/-/g, '').slice(0, 8).toUpperCase(),
        Date.now(),
        crypto.randomBytes(3).toString('hex').toUpperCase()
    ].join('-');
}

function getPublicAppUrl(req) {
    return (
        process.env.PUBLIC_APP_URL ||
        process.env.FRONTEND_ORIGIN ||
        process.env.FRONTEND_URL ||
        req.get('origin') ||
        'https://associa-5rc.pages.dev'
    ).replace(/\/+$/, '');
}

function getPrice(plan, billingCycle) {
    if (billingCycle === 'MONTHLY') {
        return Number(plan.MonthlyPrice || 0);
    }

    return Number(plan.AnnualPrice || 0);
}

router.post('/purchase/start', authMiddleware, async (req, res) => {
    try {
        const planId = req.body?.PlanId || req.body?.planId;
        const billingCycle = String(
            req.body?.BillingCycle || req.body?.billingCycle || 'ANNUAL'
        ).toUpperCase();

        const organizationId =
            req.body?.OrganizationId ||
            req.body?.organizationId ||
            getUserValue(req.user, 'organizationId', 'OrganizationId');

        const email =
            getUserValue(req.user, 'email', 'Email') ||
            req.body?.email;

        if (!organizationId) {
            return res.status(403).json({
                success: false,
                message: 'Your account is not assigned to an organization'
            });
        }

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'User email is required to start checkout'
            });
        }

        if (!planId) {
            return res.status(400).json({
                success: false,
                message: 'Subscription plan is required'
            });
        }

        if (!['MONTHLY', 'ANNUAL'].includes(billingCycle)) {
            return res.status(400).json({
                success: false,
                message: 'Billing cycle must be MONTHLY or ANNUAL'
            });
        }

        const planResult = await db.query(`
            SELECT
                "Id",
                "PlanCode",
                "PlanName",
                "MonthlyPrice",
                "AnnualPrice",
                "IsActive"
            FROM "SubscriptionPlans"
            WHERE "Id" = $1
              AND "IsActive" = TRUE
            LIMIT 1
        `, [planId]);

        if (planResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Subscription plan was not found'
            });
        }

        const plan = planResult.rows[0];
        const amount = getPrice(plan, billingCycle);

        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'This plan is not configured for online purchase'
            });
        }

        const reference = makeReference(organizationId);
        const callbackUrl =
            `${getPublicAppUrl(req)}/subscription-success.html?reference=${encodeURIComponent(reference)}`;

        const paystackResult = await initializeTransaction({
            email,
            amount: Math.round(amount * 100),
            currency: 'NGN',
            reference,
            callback_url: callbackUrl,
            metadata: {
                organizationId,
                planId,
                billingCycle,
                planCode: plan.PlanCode
            }
        });

        await db.query(`
            INSERT INTO "SubscriptionPurchases"
            (
                "Id",
                "OrganizationId",
                "PlanId",
                "Provider",
                "ProviderReference",
                "ProviderAuthorizationUrl",
                "Amount",
                "Currency",
                "BillingCycle",
                "Status",
                "RawProviderPayload",
                "CreatedAt",
                "UpdatedAt"
            )
            VALUES
            (
                gen_random_uuid(),
                $1,
                $2,
                'PAYSTACK',
                $3,
                $4,
                $5,
                'NGN',
                $6,
                'PENDING',
                $7,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            )
        `, [
            organizationId,
            planId,
            reference,
            paystackResult.data?.authorization_url || null,
            amount,
            billingCycle,
            JSON.stringify(paystackResult)
        ]);

        return res.json({
            success: true,
            data: {
                reference,
                authorizationUrl: paystackResult.data?.authorization_url,
                accessCode: paystackResult.data?.access_code
            }
        });
    } catch (err) {
        console.error(err);

        return res.status(500).json({
            success: false,
            message: err.message || 'Unable to start subscription purchase'
        });
    }
});

function addBillingPeriod(startDate, billingCycle) {
    const endDate = new Date(startDate);

    if (billingCycle === 'MONTHLY') {
        endDate.setMonth(endDate.getMonth() + 1);
    } else {
        endDate.setFullYear(endDate.getFullYear() + 1);
    }

    return endDate;
}

async function activatePurchase(reference, providerPayload) {
    const purchaseResult = await db.query(`
        SELECT
            "Id",
            "OrganizationId",
            "PlanId",
            "Amount",
            "BillingCycle",
            "Status"
        FROM "SubscriptionPurchases"
        WHERE "Provider" = 'PAYSTACK'
          AND "ProviderReference" = $1
        LIMIT 1
    `, [reference]);

    if (purchaseResult.rows.length === 0) {
        const error = new Error('Payment record was not found in Associa.');
        error.statusCode = 404;
        throw error;
    }

    const purchase = purchaseResult.rows[0];

    if (purchase.Status === 'PAID') {
        return purchase;
    }

    const paidAmount =
        Number(providerPayload?.data?.amount || 0) / 100;

    if (paidAmount < Number(purchase.Amount || 0)) {
        const error = new Error('Payment amount is lower than the selected subscription plan.');
        error.statusCode = 400;
        throw error;
    }

    const startDate = new Date();
    const endDate = addBillingPeriod(
        startDate,
        String(purchase.BillingCycle || 'ANNUAL').toUpperCase()
    );

    await db.query('BEGIN');

    try {
        await db.query(`
            UPDATE "SubscriptionPurchases"
            SET
                "Status" = 'PAID',
                "PaidAt" = CURRENT_TIMESTAMP,
                "VerifiedAt" = CURRENT_TIMESTAMP,
                "RawProviderPayload" = $2,
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Provider" = 'PAYSTACK'
              AND "ProviderReference" = $1
        `, [
            reference,
            JSON.stringify(providerPayload)
        ]);

        await db.query(`
            UPDATE "OrganizationSubscriptions"
            SET
                "Status" = 'EXPIRED',
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "OrganizationId" = $1
              AND "Status" IN ('ACTIVE', 'TRIAL', 'GRACE')
        `, [purchase.OrganizationId]);

        await db.query(`
            INSERT INTO "OrganizationSubscriptions"
            (
                "Id",
                "OrganizationId",
                "PlanId",
                "Status",
                "StartDate",
                "EndDate",
                "CreatedAt",
                "UpdatedAt"
            )
            VALUES
            (
                gen_random_uuid(),
                $1,
                $2,
                'ACTIVE',
                $3,
                $4,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            )
        `, [
            purchase.OrganizationId,
            purchase.PlanId,
            startDate,
            endDate
        ]);

        await db.query('COMMIT');
    } catch (err) {
        await db.query('ROLLBACK');
        throw err;
    }

    return purchase;
}

router.get('/purchase/verify/:reference', authMiddleware, async (req, res) => {
    try {
        const reference = String(req.params.reference || '').trim();

        if (!reference) {
            return res.status(400).json({
                success: false,
                message: 'Payment reference is required'
            });
        }

        const providerPayload = await verifyTransaction(reference);

        if (providerPayload?.data?.status !== 'success') {
            return res.status(400).json({
                success: false,
                message: 'Payment has not been confirmed by Paystack yet.'
            });
        }

        await activatePurchase(reference, providerPayload);

        return res.json({
            success: true,
            message: 'Subscription payment confirmed and activated.'
        });
    } catch (err) {
        console.error(err);

        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message || 'Unable to verify subscription purchase'
        });
    }
});

module.exports = router;

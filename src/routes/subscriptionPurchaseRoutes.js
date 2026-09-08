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

function daysBetween(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const msPerDay = 24 * 60 * 60 * 1000;

    return Math.max(
        0,
        Math.ceil((end.getTime() - start.getTime()) / msPerDay)
    );
}

async function getActiveSubscription(organizationId) {
    const result = await db.query(`
        SELECT
            s."Id",
            s."OrganizationId",
            s."PlanId",
            s."Status",
            s."StartDate",
            s."EndDate",
            p."PlanCode",
            p."PlanName",
            p."MonthlyPrice",
            p."AnnualPrice"
        FROM "OrganizationSubscriptions" s
        INNER JOIN "SubscriptionPlans" p
            ON p."Id" = s."PlanId"
        WHERE s."OrganizationId" = $1
          AND s."Status" IN ('ACTIVE', 'TRIAL', 'GRACE')
          AND (
                s."EndDate" IS NULL
                OR s."EndDate" >= CURRENT_TIMESTAMP
          )
        ORDER BY s."EndDate" DESC, s."CreatedAt" DESC
        LIMIT 1
    `, [organizationId]);

    return result.rows[0] || null;
}

function getPlanRank(plan) {
    const code = String(plan?.PlanCode || '').toUpperCase();
    const name = String(plan?.PlanName || '').toUpperCase();
    const label = `${code} ${name}`;

    if (label.includes('PRO')) {
        return 30;
    }

    if (label.includes('STANDARD')) {
        return 20;
    }

    if (label.includes('STARTER')) {
        return 10;
    }

    return Number(plan?.AnnualPrice || plan?.MonthlyPrice || 0);
}

function getBillingDays(billingCycle) {
    return billingCycle === 'MONTHLY' ? 30 : 365;
}

function buildPurchaseQuote({
    currentSubscription,
    targetPlan,
    billingCycle
}) {
    const targetPrice = getPrice(targetPlan, billingCycle);

    if (!currentSubscription || currentSubscription.Status !== 'ACTIVE') {
        return {
            purchaseType: 'NEW',
            amount: targetPrice,
            originalAmount: targetPrice,
            creditAmount: 0,
            daysRemaining: 0,
            endDate: null,
            message: 'New subscription purchase'
        };
    }

    const currentPrice = getPrice(currentSubscription, billingCycle);
    const currentRank = getPlanRank(currentSubscription);
    const targetRank = getPlanRank(targetPlan);

    if (String(currentSubscription.PlanId) === String(targetPlan.Id)) {
        return {
            purchaseType: 'CURRENT_PLAN',
            amount: 0,
            originalAmount: targetPrice,
            creditAmount: 0,
            daysRemaining: 0,
            endDate: currentSubscription.EndDate,
            message: 'This organization is already on this plan'
        };
    }

    if (targetRank <= currentRank) {
        return {
            purchaseType: 'NOT_UPGRADE',
            amount: 0,
            originalAmount: targetPrice,
            creditAmount: 0,
            daysRemaining: 0,
            endDate: currentSubscription.EndDate,
            message: 'Choose a higher plan to upgrade'
        };
    }

    if (!currentSubscription.EndDate) {
        return {
            purchaseType: 'UPGRADE',
            amount: Math.max(0, targetPrice - currentPrice),
            originalAmount: targetPrice,
            creditAmount: currentPrice,
            daysRemaining: 0,
            endDate: null,
            message: 'Upgrade top-up'
        };
    }

    const now = new Date();
    const endDate = new Date(currentSubscription.EndDate);
    const totalDays = getBillingDays(billingCycle);
    const daysRemaining = Math.min(
        totalDays,
        daysBetween(now, endDate)
    );
    const remainingRatio = daysRemaining / totalDays;
    const targetRemainingValue = targetPrice * remainingRatio;
    const currentRemainingValue = currentPrice * remainingRatio;
    const topUpAmount = Math.max(
        0,
        targetRemainingValue - currentRemainingValue
    );

    return {
        purchaseType: 'UPGRADE',
        amount: Math.ceil(topUpAmount),
        originalAmount: Math.ceil(targetRemainingValue),
        creditAmount: Math.floor(currentRemainingValue),
        daysRemaining,
        endDate: currentSubscription.EndDate,
        message: 'Upgrade top-up'
    };
}

async function getPlan(planId) {
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

    return planResult.rows[0] || null;
}

router.post('/purchase/quote', authMiddleware, async (req, res) => {
    try {
        const planId = req.body?.PlanId || req.body?.planId;
        const billingCycle = String(
            req.body?.BillingCycle || req.body?.billingCycle || 'ANNUAL'
        ).toUpperCase();

        const organizationId =
            req.body?.OrganizationId ||
            req.body?.organizationId ||
            getUserValue(req.user, 'organizationId', 'OrganizationId');

        if (!organizationId) {
            return res.status(403).json({
                success: false,
                message: 'Your account is not assigned to an organization'
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

        const plan = await getPlan(planId);

        if (!plan) {
            return res.status(404).json({
                success: false,
                message: 'Subscription plan was not found'
            });
        }

        const currentSubscription =
            await getActiveSubscription(organizationId);

        const quote = buildPurchaseQuote({
            currentSubscription,
            targetPlan: plan,
            billingCycle
        });

        return res.json({
            success: true,
            data: {
                ...quote,
                plan,
                currentSubscription
            }
        });
    } catch (err) {
        console.error(err);

        return res.status(500).json({
            success: false,
            message: err.message || 'Unable to calculate upgrade amount'
        });
    }
});

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

        const plan = await getPlan(planId);

        if (!plan) {
            return res.status(404).json({
                success: false,
                message: 'Subscription plan was not found'
            });
        }

        const currentSubscription =
            await getActiveSubscription(organizationId);

        const quote = buildPurchaseQuote({
            currentSubscription,
            targetPlan: plan,
            billingCycle
        });

        if (['CURRENT_PLAN', 'NOT_UPGRADE'].includes(quote.purchaseType)) {
            return res.status(400).json({
                success: false,
                message: quote.message
            });
        }

        const amount = Number(quote.amount || 0);

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
                "PurchaseType",
                "PreviousSubscriptionId",
                "OriginalAmount",
                "CreditAmount",
                "UpgradeDaysRemaining",
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
                $7,
                $8,
                $9,
                $10,
                $11,
                'PENDING',
                $12,
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
            quote.purchaseType,
            currentSubscription?.Id || null,
            quote.originalAmount,
            quote.creditAmount,
            quote.daysRemaining,
            JSON.stringify({
                paystack: paystackResult,
                quote
            })
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
            "PurchaseType",
            "PreviousSubscriptionId",
            "UpgradeDaysRemaining",
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
    let endDate = addBillingPeriod(
        startDate,
        String(purchase.BillingCycle || 'ANNUAL').toUpperCase()
    );

    if (
        purchase.PurchaseType === 'UPGRADE' &&
        purchase.PreviousSubscriptionId
    ) {
        const previousResult = await db.query(`
            SELECT "EndDate"
            FROM "OrganizationSubscriptions"
            WHERE "Id" = $1
              AND "OrganizationId" = $2
            LIMIT 1
        `, [
            purchase.PreviousSubscriptionId,
            purchase.OrganizationId
        ]);

        if (previousResult.rows[0]?.EndDate) {
            endDate = previousResult.rows[0].EndDate;
        }
    }

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
                "Status" = CASE
                    WHEN "Id" = $2 THEN 'UPGRADED'
                    ELSE 'EXPIRED'
                END,
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "OrganizationId" = $1
              AND "Status" IN ('ACTIVE', 'TRIAL', 'GRACE')
        `, [
            purchase.OrganizationId,
            purchase.PreviousSubscriptionId || null
        ]);

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

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const { sql } = require('../config/database');
const authMiddleware = require('../middleware/authMiddleware');
const {
    authorizeRoles,
    normalizeRole
} = require('../middleware/authorizationMiddleware');
const {
    writeAuditEvent
} = require('../services/auditService');
const {
    initializeTransaction,
    verifyTransaction,
    verifyWebhookSignature
} = require('../services/paystackService');

function toDateOrNull(value) {
    return value
        ? new Date(value)
        : null;
}

function getTargetOrganizationId(req) {
    const role = normalizeRole(req.user?.role);

    if (
        role === 'SUPER_ADMIN' &&
        req.body?.OrganizationId
    ) {
        return req.body.OrganizationId;
    }

    return req.user?.organizationId;
}

async function safeAudit({
    req,
    organizationId,
    action,
    entityType,
    entityId,
    summary,
    beforeData,
    afterData,
    metadata
}) {
    try {
        await writeAuditEvent({
            req,
            organizationId,
            action,
            entityType,
            entityId,
            summary,
            beforeData,
            afterData,
            metadata
        });
    } catch (err) {
        console.warn(
            'Subscription audit event skipped:',
            err.message
        );
    }
}

function makeLicenseKey(planCode) {
    const cleanCode =
        String(planCode || 'FULL')
        .replace(/[^A-Z0-9]/gi, '')
        .toUpperCase()
        .slice(0, 12);

    return [
        'ASSOCIA',
        cleanCode || 'FULL',
        crypto.randomBytes(3).toString('hex').toUpperCase(),
        crypto.randomBytes(3).toString('hex').toUpperCase()
    ].join('-');
}

function makePurchaseReference(organizationId) {
    return [
        'ASSOCIA',
        String(organizationId || '')
            .replace(/-/g, '')
            .slice(0, 8)
            .toUpperCase(),
        Date.now(),
        crypto.randomBytes(3).toString('hex').toUpperCase()
    ].join('-');
}

function getPlanPrice(plan, billingCycle) {
    if (String(billingCycle || 'ANNUAL').toUpperCase() === 'MONTHLY') {
        return Number(plan.MonthlyPrice || 0);
    }

    return Number(plan.AnnualPrice || 0);
}

function addBillingPeriod(startDate, billingCycle) {
    const endDate = new Date(startDate);

    if (String(billingCycle || 'ANNUAL').toUpperCase() === 'MONTHLY') {
        endDate.setMonth(endDate.getMonth() + 1);
    } else {
        endDate.setFullYear(endDate.getFullYear() + 1);
    }

    return endDate;
}

function getRequestOrigin(req) {
    return process.env.PUBLIC_APP_URL ||
        `${req.protocol}://${req.get('host')}`;
}

router.get(
    '/plans',
    authMiddleware,
    async (req, res) => {
        try {
            const result = await sql.query(`
                SELECT
                    Id,
                    PlanCode,
                    PlanName,
                    Description,
                    MonthlyPrice,
                    AnnualPrice,
                    MaxMembers,
                    MaxUsers,
                    MaxOrganizations,
                    IsActive
                FROM SubscriptionPlans
                WHERE IsActive = 1
                ORDER BY MonthlyPrice, PlanName
            `);

            res.json({
                success: true,
                data: result.recordset
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to load subscription plans. Please confirm the subscription database setup has been applied.'
            });
        }
    }
);

router.get(
    '/current',
    authMiddleware,
    async (req, res) => {
        try {
            const organizationId = req.user?.organizationId;

            if (!organizationId) {
                return res.status(403).json({
                    success: false,
                    message: 'Your account is not assigned to an organization'
                });
            }

            const request = new sql.Request();

            request.input(
                'OrganizationId',
                sql.UniqueIdentifier,
                organizationId
            );

            const result = await request.query(`
                SELECT TOP 1
                    s.Id,
                    s.OrganizationId,
                    s.PlanId,
                    s.Status,
                    s.StartDate,
                    s.EndDate,
                    s.TrialEndsAt,
                    s.GraceEndsAt,
                    s.CreatedAt,
                    p.PlanCode,
                    p.PlanName,
                    p.Description,
                    p.MonthlyPrice,
                    p.AnnualPrice,
                    p.MaxMembers,
                    p.MaxUsers,
                    p.MaxOrganizations
                FROM OrganizationSubscriptions s
                INNER JOIN SubscriptionPlans p
                    ON s.PlanId = p.Id
                WHERE s.OrganizationId = @OrganizationId
                ORDER BY
                    CASE
                        WHEN s.Status IN ('ACTIVE', 'TRIAL', 'GRACE') THEN 0
                        ELSE 1
                    END,
                    s.EndDate DESC,
                    s.CreatedAt DESC
            `);

            if (result.recordset.length === 0) {
                return res.json({
                    success: true,
                    subscribed: false
                });
            }

            const subscription = result.recordset[0];
            const entitlementRequest = new sql.Request();

            entitlementRequest.input(
                'PlanId',
                sql.UniqueIdentifier,
                subscription.PlanId
            );

            const entitlements = await entitlementRequest.query(`
                SELECT
                    FeatureCode,
                    FeatureName,
                    IsEnabled
                FROM FeatureEntitlements
                WHERE PlanId = @PlanId
                ORDER BY FeatureCode
            `);

            res.json({
                success: true,
                subscribed: true,
                data: {
                    ...subscription,
                    Entitlements: entitlements.recordset
                }
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to load current subscription'
            });
        }
    }
);

router.get(
    '/all',
    authMiddleware,
    authorizeRoles('SUPER_ADMIN'),
    async (req, res) => {
        try {
            const result = await sql.query(`
                SELECT
                    o.Name AS OrganizationName,
                    p.PlanName,
                    p.MonthlyPrice,
                    p.AnnualPrice,
                    s.Id,
                    s.OrganizationId,
                    s.PlanId,
                    s.StartDate,
                    s.EndDate,
                    s.TrialEndsAt,
                    s.GraceEndsAt,
                    CASE
                        WHEN s.Status IN ('ACTIVE', 'TRIAL', 'GRACE')
                             AND s.EndDate IS NOT NULL
                             AND CAST(s.EndDate AS date) < CAST(GETDATE() AS date)
                            THEN 'EXPIRED'
                        ELSE s.Status
                    END AS Status,
                    DATEDIFF(day, CAST(GETDATE() AS date), CAST(s.EndDate AS date)) AS DaysRemaining
                FROM OrganizationSubscriptions s
                INNER JOIN Organizations o
                    ON s.OrganizationId = o.Id
                INNER JOIN SubscriptionPlans p
                    ON s.PlanId = p.Id
                ORDER BY
                    o.Name,
                    s.EndDate DESC
            `);

            res.json({
                success: true,
                data: result.recordset
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to load organization subscriptions'
            });
        }
    }
);

router.post(
    '/assign-plan',
    authMiddleware,
    authorizeRoles('SUPER_ADMIN'),
    async (req, res) => {
        const transaction = new sql.Transaction();

        try {
            const {
                OrganizationId,
                PlanId,
                StartDate,
                EndDate,
                Status
            } = req.body;

            if (
                !OrganizationId ||
                !PlanId ||
                !EndDate
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Organization, plan and end date are required'
                });
            }

            await transaction.begin();

            const deactivateRequest = new sql.Request(transaction);

            deactivateRequest.input(
                'OrganizationId',
                sql.UniqueIdentifier,
                OrganizationId
            );

            await deactivateRequest.query(`
                UPDATE OrganizationSubscriptions
                SET
                    Status = 'REPLACED',
                    UpdatedAt = SYSUTCDATETIME()
                WHERE OrganizationId = @OrganizationId
                  AND Status IN ('ACTIVE', 'TRIAL', 'GRACE')
            `);

            const insertRequest = new sql.Request(transaction);
            const subscriptionId = crypto.randomUUID();

            insertRequest.input(
                'Id',
                sql.UniqueIdentifier,
                subscriptionId
            );

            insertRequest.input(
                'OrganizationId',
                sql.UniqueIdentifier,
                OrganizationId
            );

            insertRequest.input(
                'PlanId',
                sql.UniqueIdentifier,
                PlanId
            );

            insertRequest.input(
                'StartDate',
                sql.DateTime,
                toDateOrNull(StartDate) || new Date()
            );

            insertRequest.input(
                'EndDate',
                sql.DateTime,
                toDateOrNull(EndDate)
            );

            insertRequest.input(
                'Status',
                sql.NVarChar(30),
                Status || 'ACTIVE'
            );

            await insertRequest.query(`
                INSERT INTO OrganizationSubscriptions
                (
                    Id,
                    OrganizationId,
                    PlanId,
                    StartDate,
                    EndDate,
                    Status,
                    CreatedAt,
                    UpdatedAt
                )
                VALUES
                (
                    @Id,
                    @OrganizationId,
                    @PlanId,
                    @StartDate,
                    @EndDate,
                    @Status,
                    SYSUTCDATETIME(),
                    SYSUTCDATETIME()
                )
            `);

            await transaction.commit();

            await safeAudit({
                req,
                organizationId: OrganizationId,
                action: 'SUBSCRIPTION_ASSIGNED',
                entityType: 'SUBSCRIPTION',
                entityId: subscriptionId,
                summary: 'Subscription plan assigned to organization',
                afterData: req.body
            });

            res.json({
                success: true,
                message: 'Subscription assigned successfully',
                subscriptionId
            });
        } catch (err) {
            try {
                await transaction.rollback();
            } catch (_) {}

            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to assign subscription'
            });
        }
    }
);

router.post(
    '/renew',
    authMiddleware,
    authorizeRoles('SUPER_ADMIN', 'ADMIN'),
    async (req, res) => {
        try {
            const {
                SubscriptionId,
                NewEndDate
            } = req.body;

            if (
                !SubscriptionId ||
                !NewEndDate
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Subscription and new end date are required'
                });
            }

            const request = new sql.Request();

            request.input(
                'SubscriptionId',
                sql.UniqueIdentifier,
                SubscriptionId
            );

            request.input(
                'NewEndDate',
                sql.DateTime,
                toDateOrNull(NewEndDate)
            );

            const renewalOrganizationId =
                normalizeRole(req.user?.role) === 'SUPER_ADMIN'
                    ? null
                    : req.user?.organizationId || null;

            request.input(
                'OrganizationId',
                sql.UniqueIdentifier,
                renewalOrganizationId
            );

            const result = await request.query(`
                UPDATE OrganizationSubscriptions
                SET
                    EndDate = @NewEndDate,
                    Status = 'ACTIVE',
                    UpdatedAt = SYSUTCDATETIME()
                OUTPUT
                    inserted.OrganizationId,
                    inserted.Id,
                    inserted.EndDate
                WHERE Id = @SubscriptionId
                  AND (
                        @OrganizationId IS NULL
                        OR OrganizationId = @OrganizationId
                  )
            `);

            if (result.recordset.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Subscription not found'
                });
            }

            await safeAudit({
                req,
                organizationId: result.recordset[0].OrganizationId,
                action: 'SUBSCRIPTION_RENEWED',
                entityType: 'SUBSCRIPTION',
                entityId: SubscriptionId,
                summary: 'Subscription renewed',
                afterData: {
                    NewEndDate
                }
            });

            res.json({
                success: true,
                message: 'Subscription renewed'
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to renew subscription'
            });
        }
    }
);

router.post(
    '/suspend',
    authMiddleware,
    authorizeRoles('SUPER_ADMIN'),
    async (req, res) => {
        try {
            const {
                SubscriptionId
            } = req.body;

            if (!SubscriptionId) {
                return res.status(400).json({
                    success: false,
                    message: 'Subscription is required'
                });
            }

            const request = new sql.Request();

            request.input(
                'SubscriptionId',
                sql.UniqueIdentifier,
                SubscriptionId
            );

            const result = await request.query(`
                UPDATE OrganizationSubscriptions
                SET
                    Status = 'SUSPENDED',
                    UpdatedAt = SYSUTCDATETIME()
                OUTPUT inserted.OrganizationId
                WHERE Id = @SubscriptionId
            `);

            if (result.recordset.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Subscription not found'
                });
            }

            await safeAudit({
                req,
                organizationId: result.recordset[0].OrganizationId,
                action: 'SUBSCRIPTION_SUSPENDED',
                entityType: 'SUBSCRIPTION',
                entityId: SubscriptionId,
                summary: 'Subscription suspended'
            });

            res.json({
                success: true,
                message: 'Subscription suspended'
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to suspend subscription'
            });
        }
    }
);

async function activatePaidPurchase({
    reference,
    providerPayload,
    req = null
}) {
    const transaction = new sql.Transaction();

    await transaction.begin();

    try {
        const purchaseRequest = new sql.Request(transaction);

        purchaseRequest.input(
            'Provider',
            sql.NVarChar(50),
            'PAYSTACK'
        );

        purchaseRequest.input(
            'ProviderReference',
            sql.NVarChar(120),
            reference
        );

        const purchaseResult = await purchaseRequest.query(`
            SELECT TOP 1
                *
            FROM SubscriptionPurchases WITH (UPDLOCK, ROWLOCK)
            WHERE Provider = @Provider
              AND ProviderReference = @ProviderReference
        `);

        if (purchaseResult.recordset.length === 0) {
            await transaction.rollback();

            return {
                success: false,
                statusCode: 404,
                message: 'Purchase record not found'
            };
        }

        const purchase = purchaseResult.recordset[0];

        if (purchase.Status === 'PAID') {
            await transaction.commit();

            return {
                success: true,
                alreadyActivated: true,
                organizationId: purchase.OrganizationId
            };
        }

        const paidStatus =
            String(providerPayload?.data?.status || '').toLowerCase();

        const paidAmount =
            Number(providerPayload?.data?.amount || 0) / 100;

        if (
            paidStatus !== 'success' ||
            paidAmount < Number(purchase.Amount || 0)
        ) {
            const failedRequest = new sql.Request(transaction);

            failedRequest.input(
                'Provider',
                sql.NVarChar(50),
                'PAYSTACK'
            );

            failedRequest.input(
                'ProviderReference',
                sql.NVarChar(120),
                reference
            );

            failedRequest.input(
                'RawProviderPayload',
                sql.NVarChar(sql.MAX),
                JSON.stringify(providerPayload || {})
            );

            await failedRequest.query(`
                UPDATE SubscriptionPurchases
                SET
                    Status = 'FAILED',
                    RawProviderPayload = @RawProviderPayload,
                    UpdatedAt = SYSUTCDATETIME()
                WHERE Provider = @Provider
                  AND ProviderReference = @ProviderReference
            `);

            await transaction.commit();

            return {
                success: false,
                statusCode: 400,
                message: 'Payment was not successful'
            };
        }

        const now = new Date();
        const endDate =
            addBillingPeriod(
                now,
                purchase.BillingCycle
            );

        const closeRequest = new sql.Request(transaction);

        closeRequest.input(
            'OrganizationId',
            sql.UniqueIdentifier,
            purchase.OrganizationId
        );

        await closeRequest.query(`
            UPDATE OrganizationSubscriptions
            SET
                Status = 'REPLACED',
                UpdatedAt = SYSUTCDATETIME()
            WHERE OrganizationId = @OrganizationId
              AND Status IN ('ACTIVE', 'TRIAL', 'GRACE')
        `);

        const subscriptionId = crypto.randomUUID();
        const subscriptionRequest = new sql.Request(transaction);

        subscriptionRequest.input(
            'Id',
            sql.UniqueIdentifier,
            subscriptionId
        );

        subscriptionRequest.input(
            'OrganizationId',
            sql.UniqueIdentifier,
            purchase.OrganizationId
        );

        subscriptionRequest.input(
            'PlanId',
            sql.UniqueIdentifier,
            purchase.PlanId
        );

        subscriptionRequest.input(
            'StartDate',
            sql.DateTime,
            now
        );

        subscriptionRequest.input(
            'EndDate',
            sql.DateTime,
            endDate
        );

        await subscriptionRequest.query(`
            INSERT INTO OrganizationSubscriptions
            (
                Id,
                OrganizationId,
                PlanId,
                Status,
                StartDate,
                EndDate,
                CreatedAt,
                UpdatedAt
            )
            VALUES
            (
                @Id,
                @OrganizationId,
                @PlanId,
                'ACTIVE',
                @StartDate,
                @EndDate,
                SYSUTCDATETIME(),
                SYSUTCDATETIME()
            )
        `);

        const updatePurchaseRequest = new sql.Request(transaction);

        updatePurchaseRequest.input(
            'Provider',
            sql.NVarChar(50),
            'PAYSTACK'
        );

        updatePurchaseRequest.input(
            'ProviderReference',
            sql.NVarChar(120),
            reference
        );

        updatePurchaseRequest.input(
            'RawProviderPayload',
            sql.NVarChar(sql.MAX),
            JSON.stringify(providerPayload || {})
        );

        await updatePurchaseRequest.query(`
            UPDATE SubscriptionPurchases
            SET
                Status = 'PAID',
                PaidAt = SYSUTCDATETIME(),
                VerifiedAt = SYSUTCDATETIME(),
                RawProviderPayload = @RawProviderPayload,
                UpdatedAt = SYSUTCDATETIME()
            WHERE Provider = @Provider
              AND ProviderReference = @ProviderReference
        `);

        await transaction.commit();

        if (req) {
            await safeAudit({
                req,
                organizationId: purchase.OrganizationId,
                action: 'SUBSCRIPTION_PURCHASE_ACTIVATED',
                entityType: 'SUBSCRIPTION_PURCHASE',
                entityId: reference,
                summary: 'Online subscription purchase activated',
                metadata: {
                    provider: 'PAYSTACK',
                    subscriptionId,
                    billingCycle: purchase.BillingCycle,
                    amount: purchase.Amount
                }
            });
        }

        return {
            success: true,
            subscriptionId,
            organizationId: purchase.OrganizationId
        };
    } catch (err) {
        try {
            await transaction.rollback();
        } catch (_) {}

        throw err;
    }
}

router.post(
    '/purchase/start',
    authMiddleware,
    async (req, res) => {
        try {
            const organizationId =
                req.user?.organizationId;

            const {
                PlanId,
                BillingCycle
            } = req.body;

            const billingCycle =
                String(BillingCycle || 'ANNUAL').toUpperCase();

            if (!organizationId) {
                return res.status(403).json({
                    success: false,
                    message: 'Your account is not assigned to an organization'
                });
            }

            if (!PlanId) {
                return res.status(400).json({
                    success: false,
                    message: 'Select a subscription plan'
                });
            }

            if (!['MONTHLY', 'ANNUAL'].includes(billingCycle)) {
                return res.status(400).json({
                    success: false,
                    message: 'Billing cycle must be monthly or annual'
                });
            }

            const planRequest = new sql.Request();

            planRequest.input(
                'PlanId',
                sql.UniqueIdentifier,
                PlanId
            );

            const planResult = await planRequest.query(`
                SELECT TOP 1
                    Id,
                    PlanCode,
                    PlanName,
                    MonthlyPrice,
                    AnnualPrice
                FROM SubscriptionPlans
                WHERE Id = @PlanId
                  AND IsActive = 1
            `);

            if (planResult.recordset.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Subscription plan not found'
                });
            }

            const plan = planResult.recordset[0];
            const amount = getPlanPrice(plan, billingCycle);

            if (!Number.isFinite(amount) || amount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'This plan is not configured for online purchase'
                });
            }

            const email = req.user?.email;

            if (!email) {
                return res.status(400).json({
                    success: false,
                    message: 'Your account email is required for checkout'
                });
            }

            const reference =
                makePurchaseReference(organizationId);

            const callbackUrl =
                process.env.PAYSTACK_CALLBACK_URL ||
                `${getRequestOrigin(req)}/subscription-success.html`;

            const paystackResult =
                await initializeTransaction({
                    email,
                    amount: Math.round(amount * 100),
                    currency: 'NGN',
                    reference,
                    callback_url: callbackUrl,
                    metadata: {
                        organizationId,
                        planId: PlanId,
                        billingCycle,
                        product: 'ASSOCIA_SUBSCRIPTION'
                    }
                });

            const purchaseRequest = new sql.Request();

            purchaseRequest.input(
                'Id',
                sql.UniqueIdentifier,
                crypto.randomUUID()
            );

            purchaseRequest.input(
                'OrganizationId',
                sql.UniqueIdentifier,
                organizationId
            );

            purchaseRequest.input(
                'PlanId',
                sql.UniqueIdentifier,
                PlanId
            );

            purchaseRequest.input(
                'Provider',
                sql.NVarChar(50),
                'PAYSTACK'
            );

            purchaseRequest.input(
                'ProviderReference',
                sql.NVarChar(120),
                reference
            );

            purchaseRequest.input(
                'ProviderAuthorizationUrl',
                sql.NVarChar(1000),
                paystackResult.data?.authorization_url || null
            );

            purchaseRequest.input(
                'Amount',
                sql.Decimal(18, 2),
                amount
            );

            purchaseRequest.input(
                'Currency',
                sql.NVarChar(10),
                'NGN'
            );

            purchaseRequest.input(
                'BillingCycle',
                sql.NVarChar(20),
                billingCycle
            );

            await purchaseRequest.query(`
                INSERT INTO SubscriptionPurchases
                (
                    Id,
                    OrganizationId,
                    PlanId,
                    Provider,
                    ProviderReference,
                    ProviderAuthorizationUrl,
                    Amount,
                    Currency,
                    BillingCycle,
                    Status,
                    CreatedAt,
                    UpdatedAt
                )
                VALUES
                (
                    @Id,
                    @OrganizationId,
                    @PlanId,
                    @Provider,
                    @ProviderReference,
                    @ProviderAuthorizationUrl,
                    @Amount,
                    @Currency,
                    @BillingCycle,
                    'PENDING',
                    SYSUTCDATETIME(),
                    SYSUTCDATETIME()
                )
            `);

            await safeAudit({
                req,
                organizationId,
                action: 'SUBSCRIPTION_PURCHASE_STARTED',
                entityType: 'SUBSCRIPTION_PURCHASE',
                entityId: reference,
                summary: 'Online subscription purchase started',
                metadata: {
                    provider: 'PAYSTACK',
                    planId: PlanId,
                    billingCycle,
                    amount
                }
            });

            res.json({
                success: true,
                data: {
                    reference,
                    authorizationUrl:
                        paystackResult.data?.authorization_url,
                    accessCode:
                        paystackResult.data?.access_code
                }
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message:
                    err.message ||
                    'Unable to start subscription purchase'
            });
        }
    }
);

router.get(
    '/purchase/verify/:reference',
    authMiddleware,
    async (req, res) => {
        try {
            const reference =
                req.params.reference;

            const verifyResult =
                await verifyTransaction(reference);

            const activation =
                await activatePaidPurchase({
                    reference,
                    providerPayload: verifyResult,
                    req
                });

            if (!activation.success) {
                return res
                    .status(activation.statusCode || 400)
                    .json(activation);
            }

            res.json({
                success: true,
                message: activation.alreadyActivated
                    ? 'Subscription already activated'
                    : 'Subscription activated',
                data: activation
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message:
                    err.message ||
                    'Unable to verify subscription purchase'
            });
        }
    }
);

router.post(
    '/webhooks/paystack',
    async (req, res) => {
        try {
            const rawBody = Buffer.isBuffer(req.body)
                ? req.body
                : Buffer.from(JSON.stringify(req.body || {}));

            const signature =
                req.headers['x-paystack-signature'];

            if (
                !verifyWebhookSignature(
                    rawBody,
                    signature
                )
            ) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid webhook signature'
                });
            }

            const event =
                JSON.parse(rawBody.toString('utf8'));

            if (
                event.event === 'charge.success' &&
                event.data?.reference
            ) {
                await activatePaidPurchase({
                    reference: event.data.reference,
                    providerPayload: event
                });
            }

            res.json({
                success: true
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false
            });
        }
    }
);

router.post(
    '/activate-license',
    authMiddleware,
    authorizeRoles('SUPER_ADMIN', 'ADMIN'),
    async (req, res) => {
        const transaction = new sql.Transaction();

        try {
            const {
                LicenseKey
            } = req.body;

            const organizationId = getTargetOrganizationId(req);

            if (!LicenseKey) {
                return res.status(400).json({
                    success: false,
                    message: 'License key is required'
                });
            }

            if (!organizationId) {
                return res.status(400).json({
                    success: false,
                    message: 'Select an organization for this license'
                });
            }

            await transaction.begin();

            const licenseRequest = new sql.Request(transaction);

            licenseRequest.input(
                'LicenseKey',
                sql.NVarChar(100),
                LicenseKey.trim()
            );

            const licenseResult = await licenseRequest.query(`
                SELECT TOP 1
                    *
                FROM LicenseKeys WITH (UPDLOCK, ROWLOCK)
                WHERE LicenseKey = @LicenseKey
            `);

            if (licenseResult.recordset.length === 0) {
                await transaction.rollback();

                return res.status(404).json({
                    success: false,
                    message: 'Invalid license key'
                });
            }

            const license = licenseResult.recordset[0];

            if (license.Status !== 'UNUSED') {
                await transaction.rollback();

                return res.status(409).json({
                    success: false,
                    message: 'This license key has already been used'
                });
            }

            if (
                license.ExpiresAt &&
                new Date(license.ExpiresAt) < new Date()
            ) {
                await transaction.rollback();

                return res.status(409).json({
                    success: false,
                    message: 'This license key has expired'
                });
            }

            const deactivateRequest = new sql.Request(transaction);

            deactivateRequest.input(
                'OrganizationId',
                sql.UniqueIdentifier,
                organizationId
            );

            await deactivateRequest.query(`
                UPDATE OrganizationSubscriptions
                SET
                    Status = 'REPLACED',
                    UpdatedAt = SYSUTCDATETIME()
                WHERE OrganizationId = @OrganizationId
                  AND Status IN ('ACTIVE', 'TRIAL', 'GRACE')
            `);

            const subscriptionId = crypto.randomUUID();
            const endDate =
                license.ExpiresAt ||
                new Date(
                    Date.now() +
                    365 * 24 * 60 * 60 * 1000
                );

            const subscriptionRequest = new sql.Request(transaction);

            subscriptionRequest.input(
                'Id',
                sql.UniqueIdentifier,
                subscriptionId
            );

            subscriptionRequest.input(
                'OrganizationId',
                sql.UniqueIdentifier,
                organizationId
            );

            subscriptionRequest.input(
                'PlanId',
                sql.UniqueIdentifier,
                license.PlanId
            );

            subscriptionRequest.input(
                'LicenseKeyId',
                sql.UniqueIdentifier,
                license.Id
            );

            subscriptionRequest.input(
                'EndDate',
                sql.DateTime,
                endDate
            );

            await subscriptionRequest.query(`
                INSERT INTO OrganizationSubscriptions
                (
                    Id,
                    OrganizationId,
                    PlanId,
                    LicenseKeyId,
                    Status,
                    StartDate,
                    EndDate,
                    CreatedAt,
                    UpdatedAt
                )
                VALUES
                (
                    @Id,
                    @OrganizationId,
                    @PlanId,
                    @LicenseKeyId,
                    'ACTIVE',
                    GETDATE(),
                    @EndDate,
                    SYSUTCDATETIME(),
                    SYSUTCDATETIME()
                )
            `);

            const activateRequest = new sql.Request(transaction);

            activateRequest.input(
                'LicenseKey',
                sql.NVarChar(100),
                LicenseKey.trim()
            );

            activateRequest.input(
                'OrganizationId',
                sql.UniqueIdentifier,
                organizationId
            );

            await activateRequest.query(`
                UPDATE LicenseKeys
                SET
                    OrganizationId = @OrganizationId,
                    Status = 'ACTIVATED',
                    ActivatedAt = SYSUTCDATETIME(),
                    UpdatedAt = SYSUTCDATETIME()
                WHERE LicenseKey = @LicenseKey
            `);

            await transaction.commit();

            await safeAudit({
                req,
                organizationId,
                action: 'LICENSE_ACTIVATED',
                entityType: 'LICENSE',
                entityId: license.Id,
                summary: 'License activated and subscription assigned',
                metadata: {
                    subscriptionId,
                    licenseKey: LicenseKey.trim()
                }
            });

            res.json({
                success: true,
                message: 'License activated and subscription assigned',
                subscriptionId
            });
        } catch (err) {
            try {
                await transaction.rollback();
            } catch (_) {}

            console.error(err);

            res.status(500).json({
                success: false,
                message: 'License activation failed'
            });
        }
    }
);

router.post(
    '/licenses/generate',
    authMiddleware,
    authorizeRoles('SUPER_ADMIN'),
    async (req, res) => {
        try {
            const {
                PlanId,
                Quantity,
                ExpiresAt
            } = req.body;

            const quantity =
                Math.min(
                    Math.max(
                        Number(Quantity || 1),
                        1
                    ),
                    100
                );

            if (!PlanId) {
                return res.status(400).json({
                    success: false,
                    message: 'Plan is required'
                });
            }

            const planRequest = new sql.Request();

            planRequest.input(
                'PlanId',
                sql.UniqueIdentifier,
                PlanId
            );

            const planResult = await planRequest.query(`
                SELECT TOP 1
                    PlanCode
                FROM SubscriptionPlans
                WHERE Id = @PlanId
                  AND IsActive = 1
            `);

            if (planResult.recordset.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Plan not found'
                });
            }

            const generated = [];

            for (let index = 0; index < quantity; index += 1) {
                const licenseKey = makeLicenseKey(
                    planResult.recordset[0].PlanCode
                );

                const request = new sql.Request();

                request.input(
                    'Id',
                    sql.UniqueIdentifier,
                    crypto.randomUUID()
                );

                request.input(
                    'LicenseKey',
                    sql.NVarChar(100),
                    licenseKey
                );

                request.input(
                    'PlanId',
                    sql.UniqueIdentifier,
                    PlanId
                );

                request.input(
                    'ExpiresAt',
                    sql.DateTime,
                    toDateOrNull(ExpiresAt)
                );

                await request.query(`
                    INSERT INTO LicenseKeys
                    (
                        Id,
                        LicenseKey,
                        PlanId,
                        Status,
                        IssuedAt,
                        ExpiresAt,
                        CreatedAt,
                        UpdatedAt
                    )
                    VALUES
                    (
                        @Id,
                        @LicenseKey,
                        @PlanId,
                        'UNUSED',
                        GETDATE(),
                        @ExpiresAt,
                        SYSUTCDATETIME(),
                        SYSUTCDATETIME()
                    )
                `);

                generated.push(licenseKey);
            }

            await safeAudit({
                req,
                organizationId: req.user?.organizationId,
                action: 'LICENSE_KEYS_GENERATED',
                entityType: 'LICENSE',
                summary: `${quantity} license key(s) generated`,
                metadata: {
                    PlanId,
                    Quantity: quantity
                }
            });

            res.json({
                success: true,
                message: 'License key(s) generated',
                data: generated
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to generate license keys'
            });
        }
    }
);

router.get(
    '/licenses',
    authMiddleware,
    authorizeRoles('SUPER_ADMIN'),
    async (req, res) => {
        try {
            const result = await sql.query(`
                SELECT
                    l.Id,
                    l.LicenseKey,
                    l.Status,
                    l.ExpiresAt,
                    l.ActivatedAt,
                    l.CreatedAt,
                    p.PlanName,
                    o.Name AS OrganizationName
                FROM LicenseKeys l
                INNER JOIN SubscriptionPlans p
                    ON l.PlanId = p.Id
                LEFT JOIN Organizations o
                    ON l.OrganizationId = o.Id
                ORDER BY l.CreatedAt DESC
            `);

            res.json({
                success: true,
                data: result.recordset
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to load licenses'
            });
        }
    }
);

module.exports = router;

const db = require('../db');

function isDateInFutureOrToday(value) {
    if (!value) {
        return true;
    }

    const date = new Date(value);
    const today = new Date();

    date.setHours(23, 59, 59, 999);
    today.setHours(0, 0, 0, 0);

    return date >= today;
}

async function checkSubscription(req, res, next) {
    try {
        const organizationId = req.organizationId || req.user?.organizationId;

        if (!organizationId) {
            return res.status(403).json({
                success:false,
                message:'Your account is not assigned to an organization'
            });
        }

        const result = await db.query(`
            SELECT
                s."Id",
                s."OrganizationId",
                s."PlanId",
                s."Status",
                s."StartDate",
                s."EndDate",
                s."TrialEndsAt",
                s."GraceEndsAt",
                p."PlanCode",
                p."PlanName"
            FROM "OrganizationSubscriptions" s
            INNER JOIN "SubscriptionPlans" p
                ON s."PlanId" = p."Id"
            WHERE s."OrganizationId" = $1
              AND s."Status" IN ('ACTIVE', 'TRIAL', 'GRACE')
            ORDER BY
                CASE
                    WHEN s."Status" = 'ACTIVE' THEN 0
                    WHEN s."Status" = 'TRIAL' THEN 1
                    WHEN s."Status" = 'GRACE' THEN 2
                    ELSE 3
                END,
                s."EndDate" DESC,
                s."CreatedAt" DESC
            LIMIT 1
        `, [organizationId]);

        if (result.rows.length === 0) {
            return res.status(403).json({
                success:false,
                message:'No active subscription found for this organization'
            });
        }

        const subscription = result.rows[0];

        if (subscription.Status === 'TRIAL' && !isDateInFutureOrToday(subscription.TrialEndsAt)) {
            return res.status(403).json({
                success:false,
                message:'Trial subscription has expired'
            });
        }

        if (subscription.Status === 'GRACE' && !isDateInFutureOrToday(subscription.GraceEndsAt)) {
            return res.status(403).json({
                success:false,
                message:'Subscription grace period has expired'
            });
        }

        if (!isDateInFutureOrToday(subscription.EndDate)) {
            return res.status(403).json({
                success:false,
                message:'Subscription expired. Please renew to continue.'
            });
        }

        req.subscription = subscription;
        req.organizationId = organizationId;

        next();
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success:false,
            message:'Subscription validation failed. Please confirm the subscription database setup has been applied.'
        });
    }
}

module.exports = checkSubscription;

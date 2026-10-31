const db = require('../db');

const {
    resolveSubscriptionState
} = require('../services/subscriptionStateService');

async function checkSubscription(req, res, next) {
    try {
        const organizationId = req.organizationId || req.user?.organizationId;

        if (!organizationId) {
            return res.status(403).json({
                success:false,
                message:'Your account is not assigned to an organization'
            });
        }

        const subscription = await resolveSubscriptionState(
            db,
            organizationId
        );

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


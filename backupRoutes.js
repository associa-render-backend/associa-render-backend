const db = require('../db');

function requireFeature(featureCode) {
    return async (req, res, next) => {
        try {
            if (!req.subscription?.PlanId) {
                return res.status(403).json({
                    success:false,
                    message:'Subscription must be validated before checking plan features'
                });
            }

            const result = await db.query(`
                SELECT "Id"
                FROM "FeatureEntitlements"
                WHERE "PlanId" = $1
                  AND "FeatureCode" = $2
                  AND "IsEnabled" = TRUE
                LIMIT 1
            `, [req.subscription.PlanId, featureCode]);

            if (result.rows.length === 0) {
                return res.status(403).json({
                    success:false,
                    message:`Your current plan does not include ${featureCode.replace(/_/g, ' ').toLowerCase()}.`
                });
            }

            next();
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success:false,
                message:'Feature access validation failed'
            });
        }
    };
}

module.exports = requireFeature;

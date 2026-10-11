const express = require('express');
const router = express.Router();

const db = require('../db');

const authMiddleware = require('../middleware/authMiddleware');

const {
    requireOrganization,
    requirePermission
} = require('../middleware/authorizationMiddleware');

router.get(
    '/summary',
    authMiddleware,
    requireOrganization,
    requirePermission('dashboard.view'),
    async (req, res) => {
        try {
            const result = await db.query(`
                SELECT
                    (
                        SELECT COUNT(*)
                        FROM "Members"
                        WHERE "OrganizationId" = $1
                    ) AS "TotalMembers",
                    (
                        SELECT COUNT(*)
                        FROM "Obligations"
                        WHERE "OrganizationId" = $1
                    ) AS "TotalObligations",
                    (
                        SELECT COUNT(*)
                        FROM "Campaigns"
                        WHERE "OrganizationId" = $1
                    ) AS "TotalCampaigns",
                    (
                        SELECT COALESCE(SUM("AmountDue"), 0)
                        FROM "Obligations"
                        WHERE "OrganizationId" = $1
                    ) AS "AmountDue",
                    (
                        SELECT COALESCE(SUM(COALESCE("Amount", "AmountPaid", 0)), 0)
                        FROM "Payments"
                        WHERE "OrganizationId" = $1
                          AND COALESCE("Status", 'POSTED') = 'POSTED'
                    ) AS "AmountPaid"
            `, [req.organizationId]);

            const summary = result.rows[0] || {};

            res.json({
                totalMembers:Number(summary.TotalMembers || 0),
                totalCampaigns:Number(summary.TotalCampaigns || 0),
                totalObligations:Number(summary.TotalObligations || 0),
                amountDue:Number(summary.AmountDue || 0),
                amountPaid:Number(summary.AmountPaid || 0),
                outstanding:Math.max(0, Number(summary.AmountDue || 0) - Number(summary.AmountPaid || 0)),
                loggedInUser:req.user
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success:false,
                message:'Unable to load dashboard summary'
            });
        }
    }
);

module.exports = router;

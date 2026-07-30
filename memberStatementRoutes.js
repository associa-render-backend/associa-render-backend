const express = require('express');
const router = express.Router();

const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');
const { authorizeRoles, requireOrganization, requirePermission } = require('../middleware/authorizationMiddleware');
const { writeAuditEvent } = require('../services/auditService');

router.use(authMiddleware, requireOrganization, requirePermission('obligations.view'));

function clean(value, max = 255) {
    const text = String(value || '').trim();
    return text ? text.slice(0, max) : null;
}

function invalidUuidError(err) {
    return /invalid input syntax for type uuid/i.test(err.message || '');
}

router.get('/', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT "Id", "OrganizationId", "CampaignCode", "CampaignName", "ContributionType",
                   "Amount", "TargetScope", "StartDate", "DueDate", "Status", "CreatedAt"
            FROM "Campaigns"
            WHERE "OrganizationId" = $1
            ORDER BY "CampaignName", "DueDate", "Id"
        `, [req.organizationId]);

        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to load financial obligations' });
    }
});

router.post('/', authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER'), async (req, res) => {
    try {
        const campaignCode = clean(req.body.CampaignCode, 100);
        const campaignName = clean(req.body.CampaignName, 255);
        const contributionType = clean(req.body.ContributionType, 100);
        const amount = Number(req.body.Amount);
        const targetScope = clean(req.body.TargetScope || 'ALL_MEMBERS', 100);
        const dueDate = req.body.DueDate || null;

        if (!campaignCode || !campaignName || !contributionType || !Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success:false, message:'Code, name, contribution type and a positive amount are required' });
        }

        const duplicate = await db.query(`
            SELECT "Id"
            FROM "Campaigns"
            WHERE "OrganizationId" = $1 AND "CampaignCode" = $2
            LIMIT 1
        `, [req.organizationId, campaignCode]);

        if (duplicate.rows.length > 0) {
            return res.status(409).json({ success:false, message:'Financial obligation code already exists' });
        }

        const insertResult = await db.query(`
            INSERT INTO "Campaigns"
            ("OrganizationId", "CampaignCode", "CampaignName", "ContributionType", "Amount", "TargetScope", "DueDate", "Status", "CreatedAt")
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', CURRENT_TIMESTAMP)
            RETURNING "Id"
        `, [req.organizationId, campaignCode, campaignName, contributionType, amount, targetScope, dueDate]);

        const campaignId = insertResult.rows[0].Id;

        await writeAuditEvent({
            req,
            organizationId:req.organizationId,
            action:'CREATE',
            entityType:'CAMPAIGN',
            entityId:campaignId,
            summary:`Financial obligation ${campaignCode} created`,
            afterData:{ id:campaignId, campaignCode, campaignName, contributionType, amount, dueDate, status:'ACTIVE' }
        });

        res.status(201).json({ success:true, message:'Financial obligation created successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to create financial obligation' });
    }
});

router.post('/sync-universal', authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER'), async (req, res) => {
    try {
        const assignedCount = await db.transaction(async tx => {
            const insertResult = await tx.query(`
                INSERT INTO "Obligations"
                (
                    "OrganizationId",
                    "CampaignId",
                    "MemberId",
                    "AmountDue",
                    "AmountPaid",
                    "WaivedAmount",
                    "CreditBalance",
                    "Balance",
                    "DueDate",
                    "Status",
                    "CreatedAt",
                    "UpdatedAt",
                    "AssignmentType",
                    "ObligationType",
                    "Description"
                )
                SELECT
                    campaigns."OrganizationId",
                    campaigns."Id",
                    members."Id",
                    campaigns."Amount",
                    0,
                    0,
                    0,
                    campaigns."Amount",
                    campaigns."DueDate",
                    'UNPAID',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP,
                    'CAMPAIGN',
                    campaigns."ContributionType",
                    campaigns."CampaignName"
                FROM "Campaigns" campaigns
                INNER JOIN "Members" members
                    ON members."OrganizationId" = campaigns."OrganizationId"
                   AND members."Status" = 'ACTIVE'
                WHERE campaigns."OrganizationId" = $1
                  AND campaigns."Status" = 'ACTIVE'
                  AND COALESCE(campaigns."TargetScope", 'ALL_MEMBERS') IN
                      ('ALL_MEMBERS', 'ALL_ACTIVE_MEMBERS', 'UNIVERSAL')
                  AND NOT EXISTS (
                        SELECT 1
                        FROM "Obligations" existing
                        WHERE existing."OrganizationId" = campaigns."OrganizationId"
                          AND existing."CampaignId" = campaigns."Id"
                          AND existing."MemberId" = members."Id"
                  )
            `, [req.organizationId]);

            await writeAuditEvent({
                dbClient:tx,
                req,
                organizationId:req.organizationId,
                action:'SYNC',
                entityType:'CAMPAIGN',
                entityId:req.organizationId,
                summary:`${insertResult.rowCount} missing universal obligations synced`,
                afterData:{ assignedCount:insertResult.rowCount }
            });

            return insertResult.rowCount;
        });

        res.json({
            success:true,
            message:`${assignedCount} missing universal obligations synced successfully`,
            assignedCount
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success:false,
            message:'Unable to sync universal obligations'
        });
    }
});

router.post('/:id/assign', authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER'), async (req, res) => {
    try {
        const output = await db.transaction(async tx => {
            const campaignResult = await tx.query(`
                SELECT "Id", "CampaignName", "ContributionType", "Amount", "DueDate"
                FROM "Campaigns"
                WHERE "Id" = $1 AND "OrganizationId" = $2 AND "Status" = 'ACTIVE'
                LIMIT 1
            `, [req.params.id, req.organizationId]);

            if (campaignResult.rows.length === 0) {
                const error = new Error('Financial obligation not found');
                error.statusCode = 404;
                throw error;
            }

            const campaign = campaignResult.rows[0];
            const insertResult = await tx.query(`
                INSERT INTO "Obligations"
                ("OrganizationId", "CampaignId", "MemberId", "AmountDue", "AmountPaid", "WaivedAmount", "CreditBalance", "Balance", "DueDate", "Status", "CreatedAt", "UpdatedAt", "AssignmentType", "ObligationType", "Description")
                SELECT $1, $2, members."Id", $3, 0, 0, 0, $3, $4, 'UNPAID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'CAMPAIGN', $5, $6
                FROM "Members" members
                WHERE members."OrganizationId" = $1
                  AND members."Status" = 'ACTIVE'
                  AND NOT EXISTS (
                        SELECT 1
                        FROM "Obligations" existing
                        WHERE existing."OrganizationId" = $1
                          AND existing."CampaignId" = $2
                          AND existing."MemberId" = members."Id"
                  )
            `, [req.organizationId, campaign.Id, campaign.Amount, campaign.DueDate, campaign.ContributionType, campaign.CampaignName]);

            await writeAuditEvent({
                dbClient:tx,
                req,
                organizationId:req.organizationId,
                action:'ASSIGN',
                entityType:'CAMPAIGN',
                entityId:campaign.Id,
                summary:`${insertResult.rowCount} members assigned to ${campaign.CampaignName}`,
                afterData:{ campaign, assignedCount:insertResult.rowCount }
            });

            return insertResult.rowCount;
        });

        res.json({ success:true, message:`${output} member obligations created successfully` });
    } catch (err) {
        console.error(err);
        res.status(err.statusCode || (invalidUuidError(err) ? 400 : 500)).json({
            success:false,
            message:err.statusCode ? err.message : invalidUuidError(err) ? 'Invalid financial obligation ID' : 'Unable to assign financial obligation'
        });
    }
});

router.delete('/:id', authorizeRoles('SUPER_ADMIN', 'ADMIN'), async (req, res) => {
    try {
        const campaignResult = await db.query(`
            SELECT * FROM "Campaigns"
            WHERE "Id" = $1 AND "OrganizationId" = $2
            LIMIT 1
        `, [req.params.id, req.organizationId]);

        const assigned = await db.query(`
            SELECT COUNT(*) AS "Assignments"
            FROM "Obligations"
            WHERE "CampaignId" = $1 AND "OrganizationId" = $2
        `, [req.params.id, req.organizationId]);

        if (Number(assigned.rows[0].Assignments || 0) > 0) {
            return res.status(409).json({ success:false, message:'Assigned financial obligations cannot be deleted' });
        }

        const result = await db.query(`
            DELETE FROM "Campaigns"
            WHERE "Id" = $1 AND "OrganizationId" = $2
        `, [req.params.id, req.organizationId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success:false, message:'Financial obligation not found' });
        }

        await writeAuditEvent({
            req,
            organizationId:req.organizationId,
            action:'DELETE',
            entityType:'CAMPAIGN',
            entityId:req.params.id,
            summary:`Financial obligation ${campaignResult.rows[0]?.CampaignCode || req.params.id} deleted`,
            beforeData:campaignResult.rows[0] || null
        });

        res.json({ success:true, message:'Financial obligation deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to delete financial obligation' });
    }
});

module.exports = router;

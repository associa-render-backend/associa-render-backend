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

router.use(
    authMiddleware,
    requireOrganization,
    requirePermission('obligations.view')
);

function cleanText(value, maxLength) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maxLength) : null;
}

router.get('/', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                o."Id",
                COALESCE(m."MemberNo", m."MemberNumber") AS "MemberNo",
                COALESCE(m."Surname", '') AS "Surname",
                COALESCE(m."FirstName", '') AS "FirstName",
                o."ObligationType",
                o."Description",
                o."AmountDue",
                o."AmountPaid",
                o."WaivedAmount",
                o."Balance",
                o."DueDate",
                o."Status"
            FROM "Obligations" o
            INNER JOIN "Members" m
                ON o."MemberId" = m."Id"
                AND o."OrganizationId" = m."OrganizationId"
            WHERE o."OrganizationId" = $1
              AND o."AssignmentType" = 'INDIVIDUAL'
            ORDER BY
                COALESCE(m."MemberNo", m."MemberNumber"),
                o."DueDate",
                o."CreatedAt",
                o."Id"
        `, [req.organizationId]);

        res.json(result.rows);
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success:false,
            message:'Unable to load member obligations'
        });
    }
});

router.post(
    '/',
    authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER', 'DATA_ENTRY'),
    async (req, res) => {
        try {
            const memberId = req.body.MemberId;
            const obligationType = cleanText(req.body.ObligationType, 100);
            const description = cleanText(req.body.Description, 500);
            const amountDue = Number(req.body.AmountDue);
            const dueDate = req.body.DueDate || null;

            if (
                !memberId ||
                !obligationType ||
                !description ||
                !Number.isFinite(amountDue) ||
                amountDue <= 0
            ) {
                return res.status(400).json({
                    success:false,
                    message:'Member, obligation type, description and positive amount are required'
                });
            }

            const lookup = await db.query(`
                SELECT
                    (
                        SELECT "Id"
                        FROM "Members"
                        WHERE "Id" = $1
                          AND "OrganizationId" = $2
                        LIMIT 1
                    ) AS "MemberId",
                    (
                        SELECT "Id"
                        FROM "Campaigns"
                        WHERE "OrganizationId" = $2
                          AND "CampaignCode" = 'INDIVIDUAL'
                        ORDER BY "CreatedAt"
                        LIMIT 1
                    ) AS "CampaignId"
            `, [memberId, req.organizationId]);

            const member = lookup.rows[0]?.MemberId;
            const campaign = lookup.rows[0]?.CampaignId;

            if (!member) {
                return res.status(404).json({
                    success:false,
                    message:'Member not found'
                });
            }

            if (!campaign) {
                return res.status(409).json({
                    success:false,
                    message:'Create the INDIVIDUAL campaign for this organization first'
                });
            }

            const insertResult = await db.query(`
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
                VALUES
                (
                    $1, $2, $3, $4, 0, 0, 0, $4, $5,
                    'UNPAID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                    'INDIVIDUAL', $6, $7
                )
                RETURNING "Id"
            `, [
                req.organizationId,
                campaign,
                memberId,
                amountDue,
                dueDate,
                obligationType,
                description
            ]);

            const obligationId = insertResult.rows[0].Id;

            await writeAuditEvent({
                req,
                organizationId:req.organizationId,
                action:'CREATE',
                entityType:'MEMBER_OBLIGATION',
                entityId:obligationId,
                summary:`Member obligation created: ${description}`,
                afterData:{
                    id:obligationId,
                    memberId,
                    campaignId:campaign,
                    obligationType,
                    description,
                    amountDue,
                    dueDate,
                    status:'UNPAID'
                }
            });

            res.status(201).json({
                success:true,
                message:'Member obligation created successfully'
            });
        } catch (err) {
            console.error(err);

            const invalidId = /invalid input syntax for type uuid/i.test(
                err.message || ''
            );

            res.status(invalidId ? 400 : 500).json({
                success:false,
                message:invalidId ? 'Invalid member ID' : 'Unable to create member obligation'
            });
        }
    }
);

router.delete(
    '/:id',
    authorizeRoles('SUPER_ADMIN', 'ADMIN'),
    async (req, res) => {
        try {
            const obligationResult = await db.query(`
                SELECT *
                FROM "Obligations"
                WHERE "Id" = $1
                  AND "OrganizationId" = $2
                  AND "AssignmentType" = 'INDIVIDUAL'
                LIMIT 1
            `, [req.params.id, req.organizationId]);

            const allocations = await db.query(`
                SELECT COUNT(*) AS "Allocations"
                FROM "PaymentAllocations" allocation
                INNER JOIN "Obligations" obligation
                    ON allocation."ObligationId" = obligation."Id"
                WHERE obligation."Id" = $1
                  AND obligation."OrganizationId" = $2
            `, [req.params.id, req.organizationId]);

            if (Number(allocations.rows[0].Allocations || 0) > 0) {
                return res.status(409).json({
                    success:false,
                    message:'Obligations with payments cannot be deleted'
                });
            }

            const result = await db.query(`
                DELETE FROM "Obligations"
                WHERE "Id" = $1
                  AND "OrganizationId" = $2
                  AND "AssignmentType" = 'INDIVIDUAL'
            `, [req.params.id, req.organizationId]);

            if (result.rowCount === 0) {
                return res.status(404).json({
                    success:false,
                    message:'Member obligation not found'
                });
            }

            await writeAuditEvent({
                req,
                organizationId:req.organizationId,
                action:'DELETE',
                entityType:'MEMBER_OBLIGATION',
                entityId:req.params.id,
                summary:'Member obligation deleted',
                beforeData:obligationResult.rows[0] || null
            });

            res.json({
                success:true,
                message:'Member obligation deleted successfully'
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success:false,
                message:'Unable to delete member obligation'
            });
        }
    }
);

module.exports = router;

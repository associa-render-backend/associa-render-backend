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

router.use(
    authMiddleware,
    requireOrganization
);

function cleanText(value, maxLength) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maxLength) : null;
}

function buildFullName(surname, firstName, otherName) {
    return [surname, firstName, otherName]
        .filter(Boolean)
        .join(' ')
        .trim();
}

router.get('/', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                "Id",
                COALESCE("MemberNo", "MemberNumber") AS "MemberNo",
                COALESCE("Surname", '') AS "Surname",
                COALESCE("FirstName", '') AS "FirstName",
                COALESCE("OtherName", '') AS "OtherName",
                "Phone",
                "Email",
                "Village",
                "Branch",
                "Zone",
                "Status",
                COALESCE("CreditBalance", 0) AS "CreditBalance",
                "CreatedAt"
            FROM "Members"
            WHERE "OrganizationId" = $1
            ORDER BY
                COALESCE("MemberNo", "MemberNumber"),
                COALESCE("Surname", ''),
                COALESCE("FirstName", '')
        `, [req.organizationId]);

        res.json(result.rows);
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success:false,
            message:'Unable to load members'
        });
    }
});

router.post(
    '/',
    authorizeRoles('SUPER_ADMIN', 'ADMIN', 'DATA_ENTRY'),
    async (req, res) => {
        try {
            const memberNo = cleanText(req.body.MemberNo, 100);
            const surname = cleanText(req.body.Surname, 200);
            const firstName = cleanText(req.body.FirstName, 200);
            const otherName = cleanText(req.body.OtherName, 200);
            const phone = cleanText(req.body.Phone, 100);
            const email = cleanText(req.body.Email, 255);
            const village = cleanText(req.body.Village, 200);
            const branch = cleanText(req.body.Branch, 200);
            const zone = cleanText(req.body.Zone, 200);

            if (!memberNo || !surname || !firstName) {
                return res.status(400).json({
                    success:false,
                    message:'Member number, surname and first name are required'
                });
            }

            const duplicate = await db.query(`
                SELECT "Id"
                FROM "Members"
                WHERE "OrganizationId" = $1
                  AND (
                        "MemberNumber" = $2
                        OR "MemberNo" = $2
                  )
                LIMIT 1
            `, [req.organizationId, memberNo]);

            if (duplicate.rows.length > 0) {
                return res.status(409).json({
                    success:false,
                    message:'Member number already exists in this organization'
                });
            }

            const output = await db.transaction(async tx => {
                const insertResult = await tx.query(`
                    INSERT INTO "Members"
                    (
                        "OrganizationId",
                        "MemberNumber",
                        "MemberNo",
                        "FullName",
                        "Surname",
                        "FirstName",
                        "OtherName",
                        "Phone",
                        "Email",
                        "Village",
                        "Branch",
                        "Zone",
                        "Status",
                        "CreditBalance",
                        "CreatedAt"
                    )
                    VALUES
                    (
                        $1, $2, $2, $3, $4, $5, $6, $7, $8,
                        $9, $10, $11, 'ACTIVE', 0, CURRENT_TIMESTAMP
                    )
                    RETURNING "Id"
                `, [
                    req.organizationId,
                    memberNo,
                    buildFullName(surname, firstName, otherName),
                    surname,
                    firstName,
                    otherName,
                    phone,
                    email,
                    village,
                    branch,
                    zone
                ]);

                const memberId = insertResult.rows[0].Id;

                const universalAssignments = await tx.query(`
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
                        $2,
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
                    WHERE campaigns."OrganizationId" = $1
                      AND campaigns."Status" = 'ACTIVE'
                      AND COALESCE(campaigns."TargetScope", 'ALL_MEMBERS') IN
                          ('ALL_MEMBERS', 'ALL_ACTIVE_MEMBERS', 'UNIVERSAL')
                      AND NOT EXISTS (
                            SELECT 1
                            FROM "Obligations" existing
                            WHERE existing."OrganizationId" = campaigns."OrganizationId"
                              AND existing."CampaignId" = campaigns."Id"
                              AND existing."MemberId" = $2
                      )
                `, [req.organizationId, memberId]);

                await writeAuditEvent({
                    dbClient:tx,
                    req,
                    organizationId:req.organizationId,
                    action:'CREATE',
                    entityType:'MEMBER',
                    entityId:memberId,
                    summary:`Member ${memberNo} created`,
                    afterData:{
                        id:memberId,
                        memberNo,
                        surname,
                        firstName,
                        otherName,
                        phone,
                        email,
                        status:'ACTIVE',
                        universalObligationsAssigned:universalAssignments.rowCount
                    }
                });

                if (universalAssignments.rowCount > 0) {
                    await writeAuditEvent({
                        dbClient:tx,
                        req,
                        organizationId:req.organizationId,
                        action:'ASSIGN',
                        entityType:'MEMBER',
                        entityId:memberId,
                        summary:`${universalAssignments.rowCount} universal obligations assigned to member ${memberNo}`,
                        afterData:{
                            memberId,
                            memberNo,
                            assignedCount:universalAssignments.rowCount
                        }
                    });
                }

                return {
                    memberId,
                    assignedCount:universalAssignments.rowCount
                };
            });

            res.status(201).json({
                success:true,
                message:
                    output.assignedCount > 0
                        ? `Member created successfully. ${output.assignedCount} universal obligations assigned.`
                        : 'Member created successfully',
                assignedUniversalObligations:output.assignedCount
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success:false,
                message:'Unable to create member'
            });
        }
    }
);

router.delete(
    '/:id',
    authorizeRoles('SUPER_ADMIN', 'ADMIN'),
    async (req, res) => {
        try {
            const memberResult = await db.query(`
                SELECT *
                FROM "Members"
                WHERE "Id" = $1
                  AND "OrganizationId" = $2
                LIMIT 1
            `, [req.params.id, req.organizationId]);

            if (memberResult.rows.length === 0) {
                return res.status(404).json({
                    success:false,
                    message:'Member not found'
                });
            }

            const dependencies = await db.query(`
                SELECT
                    (
                        SELECT COUNT(*)
                        FROM "Obligations"
                        WHERE "MemberId" = $1
                          AND "OrganizationId" = $2
                    ) +
                    (
                        SELECT COUNT(*)
                        FROM "Payments"
                        WHERE "MemberId" = $1
                          AND "OrganizationId" = $2
                    ) AS "FinancialRecords"
            `, [req.params.id, req.organizationId]);

            if (Number(dependencies.rows[0].FinancialRecords || 0) > 0) {
                return res.status(409).json({
                    success:false,
                    message:'Members with financial records cannot be deleted'
                });
            }

            const result = await db.query(`
                DELETE FROM "Members"
                WHERE "Id" = $1
                  AND "OrganizationId" = $2
            `, [req.params.id, req.organizationId]);

            if (result.rowCount === 0) {
                return res.status(404).json({
                    success:false,
                    message:'Member not found'
                });
            }

            await writeAuditEvent({
                req,
                organizationId:req.organizationId,
                action:'DELETE',
                entityType:'MEMBER',
                entityId:req.params.id,
                summary:`Member ${memberResult.rows[0].MemberNo || memberResult.rows[0].MemberNumber || req.params.id} deleted`,
                beforeData:memberResult.rows[0]
            });

            res.json({
                success:true,
                message:'Member deleted successfully'
            });
        } catch (err) {
            console.error(err);

            const invalidId = /invalid input syntax for type uuid/i.test(
                err.message || ''
            );

            res.status(invalidId ? 400 : 500).json({
                success:false,
                message:invalidId ? 'Invalid member ID' : 'Unable to delete member'
            });
        }
    }
);

module.exports = router;

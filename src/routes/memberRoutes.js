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

            const insertResult = await db.query(`
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

            await writeAuditEvent({
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
                    status:'ACTIVE'
                }
            });

            res.status(201).json({
                success:true,
                message:'Member created successfully'
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

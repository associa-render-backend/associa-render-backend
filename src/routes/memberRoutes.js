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

async function safeAudit(event) {
    try {
        await writeAuditEvent(event);
    } catch (err) {
        console.warn(
            'Member audit event skipped:',
            err.message
        );
    }
}

function clean(value) {
    const text =
        String(value || '').trim();

    return text || null;
}

router.get(
    '/',
    async (req, res) => {
        try {
            const result =
                await db.query(
                    `
                    SELECT
                        "Id",
                        "MemberNo",
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
                    FROM "Members"
                    WHERE "OrganizationId" = $1
                    ORDER BY
                        "MemberNo",
                        "Surname",
                        "FirstName"
                    `,
                    [
                        req.organizationId
                    ]
                );

            res.json(
                result.rows
            );
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to load members'
            });
        }
    }
);

router.post(
    '/',
    authorizeRoles(
        'SUPER_ADMIN',
        'ADMIN',
        'DATA_ENTRY'
    ),
    async (req, res) => {
        try {
            const memberNo =
                clean(req.body.MemberNo);

            const surname =
                clean(req.body.Surname);

            const firstName =
                clean(req.body.FirstName);

            if (
                !memberNo ||
                !surname ||
                !firstName
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Member number, surname and first name are required'
                });
            }

            const duplicate =
                await db.query(
                    `
                    SELECT "Id"
                    FROM "Members"
                    WHERE "OrganizationId" = $1
                      AND "MemberNo" = $2
                    LIMIT 1
                    `,
                    [
                        req.organizationId,
                        memberNo
                    ]
                );

            if (duplicate.rows.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: 'Member number already exists in this organization'
                });
            }

            const insertResult =
                await db.query(
                    `
                    INSERT INTO "Members"
                    (
                        "Id",
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
                        "CreatedAt"
                    )
                    VALUES
                    (
                        gen_random_uuid(),
                        $1,
                        $2,
                        $2,
                        $11,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        $9,
                        $10,
                        'ACTIVE',
                        CURRENT_TIMESTAMP
                    )
                    RETURNING "Id"
                    `,
                    [
                        req.organizationId,
                        memberNo,
                        surname,
                        firstName,
                        clean(req.body.OtherName),
                        clean(req.body.Phone),
                        clean(req.body.Email),
                        clean(req.body.Village),
                        clean(req.body.Branch),
                        clean(req.body.Zone),
                        [surname, firstName, clean(req.body.OtherName)]
        .filter(Boolean)
        .join(' ')
                    ]
                );

            const memberId =
                insertResult.rows[0].Id;

            await safeAudit({
                req,
                organizationId: req.organizationId,
                action: 'CREATE',
                entityType: 'MEMBER',
                entityId: memberId,
                summary: `Member ${memberNo} created`,
                afterData: {
                    id: memberId,
                    memberNo,
                    surname,
                    firstName,
                    otherName: clean(req.body.OtherName),
                    phone: clean(req.body.Phone),
                    email: clean(req.body.Email),
                    village: clean(req.body.Village),
                    branch: clean(req.body.Branch),
                    zone: clean(req.body.Zone),
                    status: 'ACTIVE'
                }
            });

            res.status(201).json({
                success: true,
                message: 'Member created successfully'
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to create member'
            });
        }
    }
);

router.put(
    '/:id',
    authorizeRoles(
        'SUPER_ADMIN',
        'ADMIN',
        'DATA_ENTRY'
    ),
    async (req, res) => {
        try {
            const memberNo =
                clean(req.body.MemberNo);

            const surname =
                clean(req.body.Surname);

            const firstName =
                clean(req.body.FirstName);

            if (
                !memberNo ||
                !surname ||
                !firstName
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Member number, surname and first name are required'
                });
            }

            const existing =
                await db.query(
                    `
                    SELECT *
                    FROM "Members"
                    WHERE "Id" = $1
                      AND "OrganizationId" = $2
                    LIMIT 1
                    `,
                    [
                        req.params.id,
                        req.organizationId
                    ]
                );

            if (existing.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Member not found'
                });
            }

            const duplicate =
                await db.query(
                    `
                    SELECT "Id"
                    FROM "Members"
                    WHERE "OrganizationId" = $1
                      AND "MemberNo" = $2
                      AND "Id" <> $3
                    LIMIT 1
                    `,
                    [
                        req.organizationId,
                        memberNo,
                        req.params.id
                    ]
                );

            if (duplicate.rows.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: 'Member number already exists in this organization'
                });
            }

            await db.query(
                `
                UPDATE "Members"
                SET
                    "MemberNo" = $1,
                    "Surname" = $2,
                    "FirstName" = $3,
                    "OtherName" = $4,
                    "Phone" = $5,
                    "Email" = $6,
                    "Village" = $7,
                    "Branch" = $8,
                    "Zone" = $9
                WHERE "Id" = $10
                  AND "OrganizationId" = $11
                `,
                [
                    memberNo,
                    surname,
                    firstName,
                    clean(req.body.OtherName),
                    clean(req.body.Phone),
                    clean(req.body.Email),
                    clean(req.body.Village),
                    clean(req.body.Branch),
                    clean(req.body.Zone),
                    req.params.id,
                    req.organizationId
                ]
            );

            await safeAudit({
                req,
                organizationId: req.organizationId,
                action: 'UPDATE',
                entityType: 'MEMBER',
                entityId: req.params.id,
                summary: `Member ${memberNo} updated`,
                beforeData: existing.rows[0],
                afterData: {
                    memberNo,
                    surname,
                    firstName,
                    otherName: clean(req.body.OtherName),
                    phone: clean(req.body.Phone),
                    email: clean(req.body.Email),
                    village: clean(req.body.Village),
                    branch: clean(req.body.Branch),
                    zone: clean(req.body.Zone)
                }
            });

            res.json({
                success: true,
                message: 'Member updated successfully'
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to update member'
            });
        }
    }
);

router.delete(
    '/:id',
    authorizeRoles(
        'SUPER_ADMIN',
        'ADMIN'
    ),
    async (req, res) => {
        try {
            const memberResult =
                await db.query(
                    `
                    SELECT *
                    FROM "Members"
                    WHERE "Id" = $1
                      AND "OrganizationId" = $2
                    LIMIT 1
                    `,
                    [
                        req.params.id,
                        req.organizationId
                    ]
                );

            if (memberResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Member not found'
                });
            }

            const dependencies =
                await db.query(
                    `
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
                    `,
                    [
                        req.params.id,
                        req.organizationId
                    ]
                );

            if (
                Number(
                    dependencies.rows[0].FinancialRecords || 0
                ) > 0
            ) {
                return res.status(409).json({
                    success: false,
                    message: 'Members with financial records cannot be deleted'
                });
            }

            await db.query(
                `
                DELETE FROM "Members"
                WHERE "Id" = $1
                  AND "OrganizationId" = $2
                `,
                [
                    req.params.id,
                    req.organizationId
                ]
            );

            await safeAudit({
                req,
                organizationId: req.organizationId,
                action: 'DELETE',
                entityType: 'MEMBER',
                entityId: req.params.id,
                summary: `Member ${memberResult.rows[0].MemberNo || req.params.id} deleted`,
                beforeData: memberResult.rows[0]
            });

            res.json({
                success: true,
                message: 'Member deleted successfully'
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Unable to delete member'
            });
        }
    }
);

module.exports = router;

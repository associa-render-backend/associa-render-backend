const express = require('express');
const router = express.Router();

const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');

const {
    authorizeRoles,
    normalizeRole
} = require('../middleware/authorizationMiddleware');

const {
    writeAuditEvent
} = require('../services/auditService');

function normalizeText(value, maxLength) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maxLength) : null;
}

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i
        .test(String(value || ''));
}

function publicOrganization(row) {
    return {
        Id: row.Id,
        Name: row.Name,
        ShortName: row.ShortName,
        OrganizationType: row.OrganizationType,
        Phone: row.Phone,
        Email: row.Email,
        Address: row.Address,
        CreatedAt: row.CreatedAt,
        TotalUsers: Number(row.TotalUsers || 0),
        TotalMembers: Number(row.TotalMembers || 0),
        TotalPayments: Number(row.TotalPayments || 0),
        TotalObligations: Number(row.TotalObligations || 0),
        IsArchived: Boolean(row.IsArchived),
        ArchivedAt: row.ArchivedAt || null,
        ArchiveReason: row.ArchiveReason || null,
        ActiveSubscription: row.ActiveSubscription || null
    };
}

router.get('/', authMiddleware, async (req, res) => {
    try {
        const role = normalizeRole(req.user?.role);
        const params = [];
        let organizationFilter = 'WHERE COALESCE(o."IsArchived", FALSE) = FALSE';

        if (role !== 'SUPER_ADMIN') {
            if (!req.user?.organizationId) {
                return res.status(403).json({
                    success:false,
                    message:'Your account is not assigned to an organization'
                });
            }

            params.push(req.user.organizationId);
            organizationFilter += ' AND o."Id" = $1';
        }

        const result = await db.query(`
            SELECT
                o."Id",
                o."Name",
                o."ShortName",
                o."OrganizationType",
                o."Phone",
                o."Email",
                o."Address",
                o."CreatedAt",
                COALESCE(o."IsArchived", FALSE) AS "IsArchived",
                o."ArchivedAt",
                o."ArchiveReason",
                (
                    SELECT COUNT(*)
                    FROM "AdminUsers" u
                    WHERE u."OrganizationId" = o."Id"
                ) AS "TotalUsers",
                (
                    SELECT COUNT(*)
                    FROM "Members" m
                    WHERE m."OrganizationId" = o."Id"
                ) AS "TotalMembers",
                (
                    SELECT COUNT(*)
                    FROM "Payments" p
                    WHERE p."OrganizationId" = o."Id"
                ) AS "TotalPayments",
                (
                    SELECT COUNT(*)
                    FROM "Obligations" ob
                    WHERE ob."OrganizationId" = o."Id"
                ) AS "TotalObligations",
                (
                    SELECT p."PlanName"
                    FROM "OrganizationSubscriptions" s
                    INNER JOIN "SubscriptionPlans" p
                        ON p."Id" = s."PlanId"
                    WHERE s."OrganizationId" = o."Id"
                      AND s."Status" IN ('ACTIVE', 'TRIAL', 'GRACE')
                    ORDER BY s."EndDate" DESC NULLS FIRST
                    LIMIT 1
                ) AS "ActiveSubscription"
            FROM "Organizations" o
            ${organizationFilter}
            ORDER BY o."Name"
        `, params);

        res.json(result.rows.map(publicOrganization));
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to load organizations' });
    }
});

router.get('/duplicates', authMiddleware, authorizeRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const result = await db.query(`
            WITH "OrganizationStats" AS
            (
                SELECT
                    o."Id",
                    o."Name",
                    o."ShortName",
                    o."OrganizationType",
                    o."Phone",
                    o."Email",
                    o."Address",
                    o."CreatedAt",
                    COALESCE(o."IsArchived", FALSE) AS "IsArchived",
                    o."ArchivedAt",
                    o."ArchiveReason",
                    LOWER(TRIM(COALESCE(o."Name", ''))) AS "NormalizedName",
                    LOWER(TRIM(COALESCE(o."ShortName", ''))) AS "NormalizedShortName",
                    (
                        SELECT COUNT(*)
                        FROM "AdminUsers" u
                        WHERE u."OrganizationId" = o."Id"
                    ) AS "TotalUsers",
                    (
                        SELECT COUNT(*)
                        FROM "Members" m
                        WHERE m."OrganizationId" = o."Id"
                    ) AS "TotalMembers",
                    (
                        SELECT COUNT(*)
                        FROM "Payments" p
                        WHERE p."OrganizationId" = o."Id"
                    ) AS "TotalPayments",
                    (
                        SELECT COUNT(*)
                        FROM "Obligations" ob
                        WHERE ob."OrganizationId" = o."Id"
                    ) AS "TotalObligations"
                FROM "Organizations" o
                WHERE COALESCE(o."IsArchived", FALSE) = FALSE
            ),
            "SameName" AS
            (
                SELECT
                    'SAME_NAME' AS "MatchType",
                    "NormalizedName" AS "DuplicateKey",
                    *
                FROM "OrganizationStats"
                WHERE "NormalizedName" IN
                (
                    SELECT "NormalizedName"
                    FROM "OrganizationStats"
                    WHERE "NormalizedName" <> ''
                    GROUP BY "NormalizedName"
                    HAVING COUNT(*) > 1
                )
            ),
            "SameShortName" AS
            (
                SELECT
                    'SAME_SHORT_NAME' AS "MatchType",
                    "NormalizedShortName" AS "DuplicateKey",
                    *
                FROM "OrganizationStats"
                WHERE "NormalizedShortName" <> ''
                  AND "NormalizedShortName" IN
                (
                    SELECT "NormalizedShortName"
                    FROM "OrganizationStats"
                    WHERE "NormalizedShortName" <> ''
                    GROUP BY "NormalizedShortName"
                    HAVING COUNT(*) > 1
                )
            )
            SELECT
                "MatchType",
                "DuplicateKey",
                "Id",
                "Name",
                "ShortName",
                "OrganizationType",
                "Phone",
                "Email",
                "Address",
                "CreatedAt",
                "TotalUsers",
                "TotalMembers",
                "TotalPayments",
                "TotalObligations"
            FROM "SameName"

            UNION ALL

            SELECT
                "MatchType",
                "DuplicateKey",
                "Id",
                "Name",
                "ShortName",
                "OrganizationType",
                "Phone",
                "Email",
                "Address",
                "CreatedAt",
                "TotalUsers",
                "TotalMembers",
                "TotalPayments",
                "TotalObligations"
            FROM "SameShortName"

            ORDER BY
                "MatchType",
                "DuplicateKey",
                "TotalMembers" DESC,
                "TotalUsers" DESC,
                "CreatedAt" ASC
        `);

        const groups = new Map();

        result.rows.forEach(row => {
            const key = `${row.MatchType}:${row.DuplicateKey}`;

            if (!groups.has(key)) {
                groups.set(key, {
                    MatchType:row.MatchType,
                    DuplicateKey:row.DuplicateKey,
                    Organizations:[]
                });
            }

            groups.get(key).Organizations.push(publicOrganization(row));
        });

        res.json({ success:true, data:Array.from(groups.values()) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to inspect duplicate organizations' });
    }
});

router.post('/:id/archive-empty-duplicate', authMiddleware, authorizeRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const organizationId = req.params.id;

        if (!isUuid(organizationId)) {
            return res.status(400).json({ success:false, message:'Invalid organization ID' });
        }

        const confirmation = String(req.body?.confirmation || '').trim();
        const expectedConfirmation = `ARCHIVE EMPTY ${organizationId}`;

        if (confirmation !== expectedConfirmation) {
            return res.status(400).json({
                success:false,
                message:`Confirmation must be exactly: ${expectedConfirmation}`
            });
        }

        const reason = normalizeText(
            req.body?.reason || 'Archived empty duplicate organization',
            500
        );

        const status = await db.query(`
            SELECT
                o."Id",
                o."Name",
                o."ShortName",
                COALESCE(o."IsArchived", FALSE) AS "IsArchived",
                (
                    SELECT COUNT(*) FROM "AdminUsers" u WHERE u."OrganizationId" = o."Id"
                ) AS "TotalUsers",
                (
                    SELECT COUNT(*) FROM "Members" m WHERE m."OrganizationId" = o."Id"
                ) AS "TotalMembers",
                (
                    SELECT COUNT(*) FROM "Payments" p WHERE p."OrganizationId" = o."Id"
                ) AS "TotalPayments",
                (
                    SELECT COUNT(*) FROM "Obligations" ob WHERE ob."OrganizationId" = o."Id"
                ) AS "TotalObligations",
                (
                    SELECT COUNT(*) FROM "FinancialTransactions" ft WHERE ft."OrganizationId" = o."Id"
                ) AS "TotalCashbookEntries",
                (
                    SELECT COUNT(*) FROM "Campaigns" c WHERE c."OrganizationId" = o."Id"
                ) AS "TotalCampaigns",
                (
                    SELECT COUNT(*) FROM "AssociationSettings" s WHERE s."OrganizationId" = o."Id"
                ) AS "TotalSettings",
                (
                    SELECT COUNT(*) FROM "OrganizationSubscriptions" os WHERE os."OrganizationId" = o."Id"
                ) AS "TotalSubscriptions",
                (
                    SELECT COUNT(*) FROM "ExportRecords" er WHERE er."OrganizationId" = o."Id"
                ) AS "TotalExports",
                (
                    SELECT COUNT(*) FROM "BankReconciliations" b WHERE b."OrganizationId" = o."Id"
                ) AS "TotalReconciliations",
                (
                    SELECT COUNT(*)
                    FROM "Organizations" other
                    WHERE other."Id" <> o."Id"
                      AND COALESCE(other."IsArchived", FALSE) = FALSE
                      AND
                      (
                        LOWER(TRIM(COALESCE(other."Name", ''))) =
                        LOWER(TRIM(COALESCE(o."Name", '')))
                        OR
                        (
                            TRIM(COALESCE(o."ShortName", '')) <> ''
                            AND LOWER(TRIM(COALESCE(other."ShortName", ''))) =
                                LOWER(TRIM(COALESCE(o."ShortName", '')))
                        )
                      )
                ) AS "DuplicatePeerCount"
            FROM "Organizations" o
            WHERE o."Id" = $1
            LIMIT 1
        `, [organizationId]);

        if (status.rows.length === 0) {
            return res.status(404).json({ success:false, message:'Organization not found' });
        }

        const row = status.rows[0];

        if (row.IsArchived) {
            return res.status(409).json({ success:false, message:'Organization is already archived' });
        }

        const blockingCounts = {
            users:Number(row.TotalUsers || 0),
            members:Number(row.TotalMembers || 0),
            payments:Number(row.TotalPayments || 0),
            obligations:Number(row.TotalObligations || 0),
            cashbookEntries:Number(row.TotalCashbookEntries || 0),
            campaigns:Number(row.TotalCampaigns || 0),
            settings:Number(row.TotalSettings || 0),
            subscriptions:Number(row.TotalSubscriptions || 0),
            exports:Number(row.TotalExports || 0),
            reconciliations:Number(row.TotalReconciliations || 0)
        };

        const hasData = Object.values(blockingCounts).some(value => value > 0);

        if (hasData) {
            return res.status(409).json({
                success:false,
                message:'This organization is not empty and cannot be archived by this tool',
                data:blockingCounts
            });
        }

        if (Number(row.DuplicatePeerCount || 0) === 0) {
            return res.status(409).json({
                success:false,
                message:'This organization is not currently detected as a duplicate'
            });
        }

        await db.query(`
            UPDATE "Organizations"
            SET
                "IsArchived" = TRUE,
                "ArchivedAt" = CURRENT_TIMESTAMP,
                "ArchivedBy" = $2,
                "ArchiveReason" = $3,
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Id" = $1
              AND COALESCE("IsArchived", FALSE) = FALSE
        `, [organizationId, req.user?.id || null, reason]);

        await writeAuditEvent({
            req,
            organizationId,
            action:'ARCHIVE',
            entityType:'ORGANIZATION',
            entityId:organizationId,
            summary:`Empty duplicate organization ${row.Name} archived`,
            beforeData:row,
            afterData:{ id:organizationId, isArchived:true, reason }
        });

        res.json({ success:true, message:'Empty duplicate organization archived successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to archive empty duplicate organization' });
    }
});

router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const role = normalizeRole(req.user?.role);
        const organizationId = req.params.id;

        if (!isUuid(organizationId)) {
            return res.status(400).json({ success:false, message:'Invalid organization ID' });
        }

        if (role !== 'SUPER_ADMIN' && String(req.user?.organizationId).toLowerCase() !== String(organizationId).toLowerCase()) {
            return res.status(403).json({ success:false, message:'You can only view your organization' });
        }

        const result = await db.query(`
            SELECT
                o."Id",
                o."Name",
                o."ShortName",
                o."OrganizationType",
                o."Phone",
                o."Email",
                o."Address",
                o."CreatedAt",
                COALESCE(o."IsArchived", FALSE) AS "IsArchived",
                o."ArchivedAt",
                o."ArchiveReason",
                (
                    SELECT COUNT(*) FROM "AdminUsers" u WHERE u."OrganizationId" = o."Id"
                ) AS "TotalUsers",
                (
                    SELECT COUNT(*) FROM "Members" m WHERE m."OrganizationId" = o."Id"
                ) AS "TotalMembers",
                (
                    SELECT p."PlanName"
                    FROM "OrganizationSubscriptions" s
                    INNER JOIN "SubscriptionPlans" p ON p."Id" = s."PlanId"
                    WHERE s."OrganizationId" = o."Id"
                      AND s."Status" IN ('ACTIVE', 'TRIAL', 'GRACE')
                    ORDER BY s."EndDate" DESC NULLS FIRST
                    LIMIT 1
                ) AS "ActiveSubscription"
            FROM "Organizations" o
            WHERE o."Id" = $1
            LIMIT 1
        `, [organizationId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success:false, message:'Organization not found' });
        }

        res.json({ success:true, data:publicOrganization(result.rows[0]) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to load organization' });
    }
});

router.post('/', authMiddleware, authorizeRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const name = normalizeText(req.body.Name || req.body.name, 255);

        if (!name) {
            return res.status(400).json({ success:false, message:'Organization name is required' });
        }

        const shortName = normalizeText(req.body.ShortName || req.body.shortName, 100);
        const organizationType = normalizeText(req.body.OrganizationType || req.body.organizationType, 100);
        const phone = normalizeText(req.body.Phone || req.body.phone, 100);
        const email = normalizeText(req.body.Email || req.body.email, 255);
        const address = normalizeText(req.body.Address || req.body.address, 500);

        const duplicate = await db.query(`
            SELECT "Id"
            FROM "Organizations"
            WHERE LOWER("Name") = LOWER($1)
              AND COALESCE("IsArchived", FALSE) = FALSE
            LIMIT 1
        `, [name]);

        if (duplicate.rows.length > 0) {
            return res.status(409).json({ success:false, message:'Organization name already exists' });
        }

        const result = await db.query(`
            INSERT INTO "Organizations"
            (
                "Name",
                "ShortName",
                "OrganizationType",
                "Phone",
                "Email",
                "Address",
                "CreatedAt"
            )
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            RETURNING "Id"
        `, [name, shortName, organizationType, phone, email, address]);

        const organizationId = result.rows[0].Id;

        await writeAuditEvent({
            req,
            organizationId:req.user.organizationId || organizationId,
            action:'CREATE',
            entityType:'ORGANIZATION',
            entityId:organizationId,
            summary:`Organization ${name} created`,
            afterData:{ id:organizationId, name }
        });

        res.status(201).json({
            success:true,
            message:'Organization created successfully',
            data:{ Id:organizationId }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to create organization' });
    }
});

router.put('/:id', authMiddleware, authorizeRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const organizationId = req.params.id;

        if (!isUuid(organizationId)) {
            return res.status(400).json({ success:false, message:'Invalid organization ID' });
        }

        const name = normalizeText(req.body.Name || req.body.name, 255);

        if (!name) {
            return res.status(400).json({ success:false, message:'Organization name is required' });
        }

        const shortName = normalizeText(req.body.ShortName || req.body.shortName, 100);
        const organizationType = normalizeText(req.body.OrganizationType || req.body.organizationType, 100);
        const phone = normalizeText(req.body.Phone || req.body.phone, 100);
        const email = normalizeText(req.body.Email || req.body.email, 255);
        const address = normalizeText(req.body.Address || req.body.address, 500);

        const before = await db.query(`
            SELECT *
            FROM "Organizations"
            WHERE "Id" = $1
            LIMIT 1
        `, [organizationId]);

        if (before.rows.length === 0) {
            return res.status(404).json({ success:false, message:'Organization not found' });
        }

        const duplicate = await db.query(`
            SELECT "Id"
            FROM "Organizations"
            WHERE LOWER("Name") = LOWER($1)
              AND "Id" <> $2
              AND COALESCE("IsArchived", FALSE) = FALSE
            LIMIT 1
        `, [name, organizationId]);

        if (duplicate.rows.length > 0) {
            return res.status(409).json({ success:false, message:'Organization name already exists' });
        }

        await db.query(`
            UPDATE "Organizations"
            SET
                "Name" = $1,
                "ShortName" = $2,
                "OrganizationType" = $3,
                "Phone" = $4,
                "Email" = $5,
                "Address" = $6,
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Id" = $7
        `, [name, shortName, organizationType, phone, email, address, organizationId]);

        await writeAuditEvent({
            req,
            organizationId,
            action:'UPDATE',
            entityType:'ORGANIZATION',
            entityId:organizationId,
            summary:`Organization ${name} updated`,
            beforeData:before.rows[0],
            afterData:{ id:organizationId, name }
        });

        res.json({ success:true, message:'Organization updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to update organization' });
    }
});

module.exports = router;

const db = require('../db');

function cleanJson(value) {
    if (value === undefined) {
        return null;
    }

    return value;
}

function safeText(value, maxLength) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maxLength) : null;
}

async function writeAuditEvent({
    dbClient,
    transaction,
    req,
    organizationId,
    actorUserId,
    actorName,
    actorEmail,
    actorRole,
    action,
    entityType,
    entityId,
    summary,
    beforeData,
    afterData,
    metadata,
    ipAddress
}) {
    const user = req?.user || {};

    const effectiveOrganizationId =
        organizationId ||
        req?.organizationId ||
        user.organizationId;

    if (!effectiveOrganizationId) {
        return null;
    }

    const runner = dbClient || transaction || db;

    const result = await runner.query(
        `
            INSERT INTO "AuditEvents"
            (
                "OrganizationId",
                "ActorUserId",
                "ActorName",
                "ActorEmail",
                "ActorRole",
                "Action",
                "EntityType",
                "EntityId",
                "Summary",
                "BeforeData",
                "AfterData",
                "Metadata",
                "IpAddress"
            )
            VALUES
            (
                $1, $2, $3, $4, $5, $6, $7, $8,
                $9, $10::jsonb, $11::jsonb, $12::jsonb, $13
            )
            RETURNING "Id"
        `,
        [
            effectiveOrganizationId,
            actorUserId || user.id || null,
            safeText(actorName || user.fullName, 255),
            safeText(actorEmail || user.email, 255),
            safeText(actorRole || user.role, 50),
            safeText(action, 100),
            safeText(entityType, 100),
            entityId ? String(entityId).slice(0, 100) : null,
            safeText(summary, 1000) || 'Audit event recorded',
            JSON.stringify(cleanJson(beforeData)),
            JSON.stringify(cleanJson(afterData)),
            JSON.stringify(cleanJson(metadata)),
            safeText(
                ipAddress ||
                req?.ip ||
                req?.headers?.['x-forwarded-for'],
                100
            )
        ]
    );

    return result.rows[0]?.Id || null;
}

module.exports = {
    writeAuditEvent
};

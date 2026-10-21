const db = require('../db');

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
let schemaReadyPromise = null;

async function ensureAuthSessionSchema() {
    if (!schemaReadyPromise) {
        schemaReadyPromise = db.query(`
            CREATE TABLE IF NOT EXISTS "UserSessions" (
                "UserId" UUID PRIMARY KEY REFERENCES "AdminUsers"("Id") ON DELETE CASCADE,
                "SessionId" UUID NOT NULL UNIQUE,
                "LastActivityAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "UpdatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `).catch(error => {
            schemaReadyPromise = null;
            throw error;
        });
    }

    await schemaReadyPromise;
}

async function createSession(tx, userId, sessionId) {
    await tx.query(`
        INSERT INTO "UserSessions"
        (
            "UserId",
            "SessionId",
            "LastActivityAt",
            "CreatedAt",
            "UpdatedAt"
        )
        VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT ("UserId")
        DO UPDATE SET
            "SessionId" = EXCLUDED."SessionId",
            "LastActivityAt" = CURRENT_TIMESTAMP,
            "UpdatedAt" = CURRENT_TIMESTAMP
    `, [userId, sessionId]);
}

async function validateAndTouchSession(userId, sessionId) {
    const result = await db.query(`
        UPDATE "UserSessions"
        SET
            "LastActivityAt" = CURRENT_TIMESTAMP,
            "UpdatedAt" = CURRENT_TIMESTAMP
        WHERE "UserId" = $1
          AND "SessionId" = $2
          AND "LastActivityAt" > CURRENT_TIMESTAMP - ($3 * INTERVAL '1 millisecond')
        RETURNING "UserId"
    `, [userId, sessionId, IDLE_TIMEOUT_MS]);

    return result.rows.length > 0;
}

async function endSession(userId, sessionId) {
    await db.query(`
        DELETE FROM "UserSessions"
        WHERE "UserId" = $1
          AND "SessionId" = $2
    `, [userId, sessionId]);
}

module.exports = {
    IDLE_TIMEOUT_MS,
    ensureAuthSessionSchema,
    createSession,
    validateAndTouchSession,
    endSession
};


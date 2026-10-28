const db = require('../db');

let schemaReadyPromise = null;

async function ensureObligationReferenceSchema() {
    if (!schemaReadyPromise) {
        schemaReadyPromise = db.query(`
            ALTER TABLE "Obligations"
            ADD COLUMN IF NOT EXISTS "Reference" VARCHAR(500)
        `).then(() => db.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UX_Obligations_Organization_Member_Reference"
            ON "Obligations" ("OrganizationId", "MemberId", "Reference")
            WHERE "Reference" IS NOT NULL AND "Reference" <> ''
        `)).catch(error => {
            schemaReadyPromise = null;
            throw error;
        });
    }

    await schemaReadyPromise;
}

module.exports = { ensureObligationReferenceSchema };

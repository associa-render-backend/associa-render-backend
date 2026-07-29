const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const root = path.join(__dirname, '..');
const schemaPath = path.join(root, 'postgres', 'schema.sql');
const seedPath = path.join(root, 'postgres', 'seed.sql');

const requiredTables = [
    'Organizations',
    'AdminUsers',
    'AssociationSettings',
    'Members',
    'Campaigns',
    'Obligations',
    'Payments',
    'PaymentAllocations',
    'FinancialTransactions',
    'AuditEvents',
    'SubscriptionPlans',
    'OrganizationSubscriptions',
    'FeatureEntitlements',
    'LicenseKeys',
    'BankReconciliations',
    'BankReconciliationItems',
    'ExportRecords'
];

function readSql(filePath) {
    return fs
        .readFileSync(filePath, 'utf8')
        .replace(/^\uFEFF/, '');
}

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required. Use your Neon connection string.');
    }

    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl:
            process.env.PGSSLMODE === 'disable'
                ? false
                : {
                    rejectUnauthorized:
                        process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true'
                }
    });

    await client.connect();

    try {
        console.log('Connected to PostgreSQL.');

        await client.query(readSql(schemaPath));
        console.log('Schema applied successfully.');

        await client.query(readSql(seedPath));
        console.log('Seed applied successfully.');

        const tableResult = await client.query(
            `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = ANY($1::text[])
            ORDER BY table_name
            `,
            [requiredTables]
        );

        const existingTables = new Set(
            tableResult.rows.map(row => row.table_name)
        );

        const missingTables = requiredTables.filter(
            tableName => !existingTables.has(tableName)
        );

        if (missingTables.length > 0) {
            throw new Error(
                `Missing required tables: ${missingTables.join(', ')}`
            );
        }

        const planResult = await client.query(
            `SELECT COUNT(*)::int AS count FROM "SubscriptionPlans"`
        );

        const featureResult = await client.query(
            `SELECT COUNT(*)::int AS count FROM "FeatureEntitlements"`
        );

        console.log(`Required tables verified: ${requiredTables.length}.`);
        console.log(`Subscription plans: ${planResult.rows[0].count}.`);
        console.log(`Feature entitlements: ${featureResult.rows[0].count}.`);
        console.log('Neon schema + seed verification completed successfully.');
    } finally {
        await client.end();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});

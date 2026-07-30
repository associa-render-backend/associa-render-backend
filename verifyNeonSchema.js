const { Client } = require('pg');
const bcrypt = require('bcryptjs');

function getArg(name, fallback = '') {
    const index = process.argv.indexOf(`--${name}`);

    if (index >= 0 && process.argv[index + 1]) {
        return process.argv[index + 1];
    }

    return process.env[name.toUpperCase().replace(/-/g, '_')] || fallback;
}

async function main() {
    const databaseUrl = process.env.DATABASE_URL;
    const email = getArg('email', 'admin@associa.com').trim().toLowerCase();
    const password = getArg('password');
    const fullName = getArg('full-name', 'System Administrator').trim();
    const organizationName = getArg('organization-name', 'Associa Default Organization').trim();
    const organizationShortName = getArg('organization-short-name', 'ASSOCIA').trim();

    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required. Set it to your Neon connection string before running this script.');
    }

    if (!password || password.length < 8) {
        throw new Error('A password of at least 8 characters is required. Use --password "your-new-password".');
    }

    const client = new Client({
        connectionString: databaseUrl,
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
        await client.query('BEGIN');

        let organizationResult = await client.query(`
            SELECT "Id"
            FROM "Organizations"
            WHERE "Status" = 'ACTIVE'
              AND COALESCE("IsArchived", FALSE) = FALSE
            ORDER BY "CreatedAt" ASC
            LIMIT 1
        `);

        let organizationId;

        if (organizationResult.rowCount > 0) {
            organizationId = organizationResult.rows[0].Id;
        } else {
            const createdOrganization = await client.query(`
                INSERT INTO "Organizations"
                (
                    "Name",
                    "ShortName",
                    "OrganizationType",
                    "Status",
                    "CreatedAt",
                    "UpdatedAt"
                )
                VALUES
                ($1, $2, 'Association', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                RETURNING "Id"
            `, [organizationName, organizationShortName]);

            organizationId = createdOrganization.rows[0].Id;
        }

        await client.query(`
            INSERT INTO "AssociationSettings"
            (
                "OrganizationId",
                "AssociationName",
                "DashboardTitle",
                "DashboardMessage",
                "CreatedAt",
                "UpdatedAt"
            )
            VALUES
            (
                $1,
                $2,
                $3,
                'Welcome to Associa',
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            )
            ON CONFLICT ("OrganizationId") DO UPDATE SET
                "AssociationName" = COALESCE("AssociationSettings"."AssociationName", EXCLUDED."AssociationName"),
                "UpdatedAt" = CURRENT_TIMESTAMP
        `, [organizationId, organizationName, `${organizationName} Dashboard`]);

        const planResult = await client.query(`
            SELECT "Id"
            FROM "SubscriptionPlans"
            WHERE "PlanCode" = 'FULL_ACCESS'
            ORDER BY "CreatedAt" ASC
            LIMIT 1
        `);

        if (planResult.rowCount > 0) {
            await client.query(`
                INSERT INTO "OrganizationSubscriptions"
                (
                    "OrganizationId",
                    "PlanId",
                    "Status",
                    "StartDate",
                    "EndDate",
                    "CreatedAt",
                    "UpdatedAt"
                )
                SELECT
                    $1,
                    $2,
                    'ACTIVE',
                    CURRENT_DATE,
                    CURRENT_DATE + INTERVAL '10 years',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                WHERE NOT EXISTS
                (
                    SELECT 1
                    FROM "OrganizationSubscriptions"
                    WHERE "OrganizationId" = $1
                      AND "Status" IN ('ACTIVE', 'TRIAL', 'GRACE')
                )
            `, [organizationId, planResult.rows[0].Id]);
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const existingUser = await client.query(`
            SELECT "Id"
            FROM "AdminUsers"
            WHERE LOWER("Email") = LOWER($1)
            LIMIT 1
        `, [email]);

        if (existingUser.rowCount > 0) {
            await client.query(`
                UPDATE "AdminUsers"
                SET
                    "OrganizationId" = $1,
                    "FullName" = $2,
                    "PasswordHash" = $3,
                    "Role" = 'SUPER_ADMIN',
                    "Status" = 'ACTIVE',
                    "UpdatedAt" = CURRENT_TIMESTAMP
                WHERE "Id" = $4
            `, [organizationId, fullName, passwordHash, existingUser.rows[0].Id]);
        } else {
            await client.query(`
                INSERT INTO "AdminUsers"
                (
                    "OrganizationId",
                    "FullName",
                    "Email",
                    "PasswordHash",
                    "Role",
                    "Status",
                    "CreatedAt",
                    "UpdatedAt"
                )
                VALUES
                ($1, $2, $3, $4, 'SUPER_ADMIN', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `, [organizationId, fullName, email, passwordHash]);
        }

        await client.query('COMMIT');

        console.log('Cloud admin reset completed successfully.');
        console.log(`Email: ${email}`);
        console.log('Role: SUPER_ADMIN');
        console.log('Status: ACTIVE');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        await client.end();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});

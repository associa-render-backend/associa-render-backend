require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { sql } = require('../src/config/database');

async function main() {
    const fileName = process.argv[2];

    if (!fileName) {
        throw new Error('Provide a SQL file name, for example: node scripts/runSqlFile.js sql/20260802_add_subscription_purchases.sql');
    }

    const filePath = path.resolve(process.cwd(), fileName);
    const script = fs.readFileSync(filePath, 'utf8');

    await sql.connect({
        server: process.env.DB_SERVER,
        port: parseInt(process.env.DB_PORT || '1433', 10),
        database: process.env.DB_DATABASE,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        connectionTimeout: 15000,
        requestTimeout: 30000,
        options: {
            trustServerCertificate: true
        }
    });

    await sql.query(script);
    await sql.close();

    console.log(`Applied SQL file: ${fileName}`);
}

main().catch(async err => {
    console.error(err.message || err);

    try {
        await sql.close();
    } catch (_) {}

    process.exit(1);
});

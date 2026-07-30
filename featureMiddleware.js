const { Pool } = require('pg');

const isProduction =
    process.env.NODE_ENV === 'production';

const connectionString =
    process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error(
        'DATABASE_URL is required for the Associa cloud PostgreSQL adapter.'
    );
}

const pool = new Pool({
    connectionString,
    ssl:
        process.env.PGSSLMODE === 'disable'
            ? false
            : {
                rejectUnauthorized:
                    process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true'
            },
    max:
        Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis:
        Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis:
        Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000)
});

function normalizeResult(result) {
    return {
        rows: result.rows,
        rowCount: result.rowCount,
        // Legacy result shape support for converted route handlers.
        recordset: result.rows,
        rowsAffected: [result.rowCount]
    };
}

async function query(text, params = []) {
    const result = await pool.query(text, params);
    return normalizeResult(result);
}

async function getClient() {
    const client = await pool.connect();

    return {
        query: async (text, params = []) => {
            const result = await client.query(text, params);
            return normalizeResult(result);
        },
        release: () => client.release(),
        raw: client
    };
}

async function transaction(work) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const tx = {
            query: async (text, params = []) => {
                const result = await client.query(text, params);
                return normalizeResult(result);
            },
            raw: client
        };

        const output = await work(tx);

        await client.query('COMMIT');

        return output;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function connectDB() {
    const result = await query('SELECT NOW() AS "connectedAt"');
    console.log(
        `PostgreSQL connected at ${result.rows[0].connectedAt.toISOString()}`
    );
}

async function closeDB() {
    await pool.end();
}

module.exports = {
    pool,
    query,
    getClient,
    transaction,
    connectDB,
    closeDB
};


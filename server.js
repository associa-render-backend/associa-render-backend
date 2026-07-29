require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { connectDB, query, closeDB } = require('./src/db');

const authRoutes = require('./src/routes/authRoutes');
const memberRoutes = require('./src/routes/memberRoutes');
const organizationRoutes = require('./src/routes/organizationRoutes');
const campaignRoutes = require('./src/routes/campaignRoutes');
const obligationRoutes = require('./src/routes/obligationRoutes');
const memberObligationRoutes = require('./src/routes/memberObligationRoutes');
const paymentRoutes = require('./src/routes/paymentRoutes');
const dashboardRoutes = require('./src/routes/dashboardRoutes');
const bulkUploadRoutes = require('./src/routes/bulkUploadRoutes');
const settingsRoutes = require('./src/routes/settingsRoutes');
const memberStatementRoutes = require('./src/routes/memberStatementRoutes');
const financialTransactionRoutes = require('./src/routes/financialTransactionRoutes');
const treasurerReportRoutes = require('./src/routes/treasurerReportRoutes');
const auditTrailRoutes = require('./src/routes/auditTrailRoutes');
const backupRoutes = require('./src/routes/backupRoutes');
const subscriptionRoutes = require('./src/routes/subscriptionRoutes');
const bankReconciliationRoutes = require('./src/routes/bankReconciliationRoutes');

const app = express();

const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || '0.0.0.0';
const SERVICE_NAME = process.env.SERVICE_NAME || 'Associa Cloud API';

const allowedOrigins = (
    process.env.FRONTEND_ORIGINS ||
    process.env.FRONTEND_ORIGIN ||
    ''
)
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

const uploadsRoot = path.join(__dirname, 'uploads');
const logoUploadPath = path.join(uploadsRoot, 'logo');

fs.mkdirSync(logoUploadPath, { recursive: true });

app.set('trust proxy', 1);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.length === 0) {
            return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(
            new Error('This frontend is not allowed to access Associa Cloud API.')
        );
    },
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/uploads', express.static(uploadsRoot));

app.get('/', (req, res) => {
    res.json({
        success: true,
        service: SERVICE_NAME,
        status: 'ONLINE',
        message: 'Associa cloud backend is running.'
    });
});

app.get('/api/health', async (req, res) => {
    const databaseCheck = await query('SELECT NOW() AS "checkedAt"');

    res.json({
        success: true,
        service: SERVICE_NAME,
        status: 'ONLINE',
        database: 'POSTGRESQL',
        checkedAt: databaseCheck.rows[0].checkedAt
    });
});

app.use('/api/auth', authRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/obligations', obligationRoutes);
app.use('/api/member-obligations', memberObligationRoutes);
app.use('/api/bulk-upload', bulkUploadRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/member-statement', memberStatementRoutes);
app.use('/api/financial-transactions', financialTransactionRoutes);
app.use('/api/treasurer-reports', treasurerReportRoutes);
app.use('/api/audit-trail', auditTrailRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/bank-reconciliation', bankReconciliationRoutes);

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'The requested Associa cloud service was not found.'
    });
});

app.use((err, req, res, next) => {
    console.error(err);

    res.status(500).json({
        success: false,
        message:
            process.env.NODE_ENV === 'production'
                ? 'Associa encountered a server error. Please try again.'
                : err.message
    });
});

async function startServer() {
    await connectDB();

    app.listen(PORT, HOST, () => {
        console.log(`${SERVICE_NAME} listening on ${HOST}:${PORT}`);
    });
}

process.on('SIGTERM', async () => {
    await closeDB();
    process.exit(0);
});

process.on('SIGINT', async () => {
    await closeDB();
    process.exit(0);
});

startServer().catch(error => {
    console.error('Unable to start Associa cloud backend:', error);
    process.exit(1);
});

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const { connectDB } =
require('./src/config/database');

const memberRoutes =
require('./src/routes/memberRoutes');

const organizationRoutes =
require('./src/routes/organizationRoutes');

const campaignRoutes =
require('./src/routes/campaignRoutes');

const obligationRoutes =
require('./src/routes/obligationRoutes');

const paymentRoutes =
require('./src/routes/paymentRoutes');

const dashboardRoutes =
require('./src/routes/dashboardRoutes');

const authRoutes =
require('./src/routes/authRoutes');

const memberObligationRoutes =
require('./src/routes/memberObligationRoutes');

const bulkUploadRoutes =
require('./src/routes/bulkUploadRoutes');

const app = express();

const settingsRoutes =
require('./src/routes/settingsRoutes');

const memberStatementRoutes =
require('./src/routes/memberStatementRoutes');

const financialTransactionRoutes =
require('./src/routes/financialTransactionRoutes');

const treasurerReportRoutes =
require('./src/routes/treasurerReportRoutes');

const auditTrailRoutes =
require('./src/routes/auditTrailRoutes');

const backupRoutes =
require('./src/routes/backupRoutes');

const subscriptionRoutes =
require('./src/routes/subscriptionRoutes');

const bankReconciliationRoutes =
require('./src/routes/bankReconciliationRoutes');

app.use(cors());

app.use(
    '/api/subscriptions/webhooks/paystack',
    express.raw({
        type: 'application/json'
    })
);

app.use(express.json());

app.use(
    '/uploads',
    express.static('uploads')
);

app.use(
'/api/settings',
settingsRoutes
);

app.use(
'/api/member-statement',
memberStatementRoutes
);

app.use(
    '/api/financial-transactions',
    financialTransactionRoutes
);


app.use(
    '/api/treasurer-reports',
    treasurerReportRoutes
);

app.use(
    '/api/audit-trail',
    auditTrailRoutes
);

app.use(
    '/api/backups',
    backupRoutes
);

app.use(
'/api/subscriptions',
subscriptionRoutes
);

app.use(
'/api/bank-reconciliation',
bankReconciliationRoutes
);

connectDB();

app.get('/', (req, res) => {


res.redirect('/login.html');


});

app.get('/api/health', (req, res) => {

    res.json({
        success:true,
        status:'ONLINE',
        service:'Associa API',
        port:PORT,
        checkedAt:
            new Date().toISOString()
    });

});

// ======================================
// API ROUTES
// ======================================

app.use(
'/api/auth',
authRoutes
);

app.use(
'/api/members',
memberRoutes
);

app.use(
'/api/organizations',
organizationRoutes
);

app.use(
'/api/campaigns',
campaignRoutes
);

app.use(
'/api/obligations',
obligationRoutes
);

app.use(
'/api/member-obligations',
memberObligationRoutes
);

app.use(
'/api/bulk-upload',
bulkUploadRoutes
);

app.use(
'/api/payments',
paymentRoutes
);

app.use(
'/api/dashboard',
dashboardRoutes
);

// ======================================

app.use(
    express.static(
        path.join(
            __dirname,
            '..',
            'frontend'
        )
    )
);

app.use((req, res) => {

    res.status(404).json({
        success:false,
        message:
            'The requested Associa service was not found.'
    });

});

app.use((err, req, res, next) => {

    console.error(err);

    res.status(500).json({
        success:false,
        message:
            'Associa encountered a server error. Please try again or contact the system administrator.'
    });

});

const PORT =
process.env.PORT || 5000;

app.listen(PORT, () => {


console.log(
    `🚀 Server running on port ${PORT}`
);


});

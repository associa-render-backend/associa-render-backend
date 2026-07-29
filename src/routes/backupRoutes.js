const express = require('express');
const router = express.Router();

const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');
const { authorizeRoles, requireOrganization } = require('../middleware/authorizationMiddleware');
const checkSubscription = require('../middleware/subscriptionMiddleware');
const requireFeature = require('../middleware/featureMiddleware');
const FEATURES = require('../config/features');
const { writeAuditEvent } = require('../services/auditService');

router.use(
    authMiddleware,
    requireOrganization,
    checkSubscription,
    requireFeature(FEATURES.BACKUP_RESTORE),
    authorizeRoles('SUPER_ADMIN')
);

function cloudBackupMessage() {
    return 'Cloud PostgreSQL backups are managed by the hosting database provider. Use the Neon dashboard for restore points/branching, and use Associa export records for downloadable app-level exports.';
}

router.get('/health', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                COUNT(*) AS "TotalExports",
                SUM(CASE WHEN "Status" IN ('CREATED', 'COMPLETED') THEN 1 ELSE 0 END) AS "CompletedExports",
                MAX("CreatedAt") AS "LastExportAt",
                MAX("CompletedAt") AS "LastCompletedAt"
            FROM "ExportRecords"
            WHERE "OrganizationId" = $1 OR "OrganizationId" IS NULL
        `, [req.organizationId]);
        const row = result.rows[0] || {};
        res.json({
            success:true,
            data:{
                databaseName:'Neon PostgreSQL',
                backupPath:'Provider-managed cloud backups',
                totalBackups:Number(row.TotalExports || 0),
                verifiedBackups:Number(row.CompletedExports || 0),
                lastBackupAt:row.LastExportAt || null,
                lastVerifiedAt:row.LastCompletedAt || null,
                cloudManaged:true,
                note:cloudBackupMessage()
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:err.message || 'Unable to check backup health' });
    }
});

router.get('/', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT "Id", "OrganizationId", "ExportType", "Status", "FileName", "FileSizeBytes", "CreatedBy", "CreatedAt", "CompletedAt", "Notes"
            FROM "ExportRecords"
            WHERE "OrganizationId" = $1 OR "OrganizationId" IS NULL
            ORDER BY "CreatedAt" DESC, "Id" DESC
        `, [req.organizationId]);
        res.json({ success:true, data:result.rows, cloudManaged:true, note:cloudBackupMessage() });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to load backups/exports' });
    }
});

router.post('/', async (req, res) => {
    try {
        await writeAuditEvent({
            req,
            organizationId:req.organizationId,
            action:'BACKUP_REQUESTED_CLOUD',
            entityType:'DATABASE_BACKUP',
            summary:'Cloud database backup request redirected to provider-managed backup policy',
            metadata:{ provider:'Neon PostgreSQL' }
        });
        res.status(409).json({
            success:false,
            cloudManaged:true,
            message:cloudBackupMessage(),
            recommendedAction:'Use Neon dashboard restore points/branching for database backup and recovery.'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to process cloud backup request' });
    }
});

router.post('/:id/verify', async (req, res) => {
    res.status(409).json({ success:false, cloudManaged:true, message:cloudBackupMessage() });
});

router.get('/:id/download', async (req, res) => {
    res.status(404).json({ success:false, message:'Cloud provider-managed database backups are not downloadable through Associa.' });
});

router.get('/:id/restore-instructions', async (req, res) => {
    res.json({
        success:true,
        message:'Cloud restore is performed in the database provider dashboard, not through a local SQL Server restore script.',
        provider:'Neon PostgreSQL',
        requirements:[
            'Open the Neon project dashboard.',
            'Use restore points or database branching according to the selected Neon plan.',
            'Test restore into a separate branch before replacing production connection settings.',
            'Update Koyeb DATABASE_URL only after the restored branch is verified.'
        ]
    });
});

module.exports = router;

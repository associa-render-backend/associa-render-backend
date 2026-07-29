const express = require('express');
const router = express.Router();

const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');
const { authorizeRoles, requireOrganization } = require('../middleware/authorizationMiddleware');
const checkSubscription = require('../middleware/subscriptionMiddleware');
const requireFeature = require('../middleware/featureMiddleware');
const FEATURES = require('../config/features');

router.use(
    authMiddleware,
    requireOrganization,
    checkSubscription,
    requireFeature(FEATURES.AUDIT_TRAIL),
    authorizeRoles('SUPER_ADMIN', 'ADMIN', 'TREASURER', 'AUDITOR')
);

function addDateFilter(filters, params, column, value, name, inclusiveEnd = false) {
    if (!value) return;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const error = new Error(`${name} must use YYYY-MM-DD`);
        error.statusCode = 400;
        throw error;
    }

    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        const error = new Error(`${name} is invalid`);
        error.statusCode = 400;
        throw error;
    }

    params.push(value);
    filters.push(inclusiveEnd
        ? `${column} < ($${params.length}::date + INTERVAL '1 day')`
        : `${column} >= $${params.length}::date`);
}

router.get('/', async (req, res) => {
    try {
        if (req.query.fromDate && req.query.toDate && req.query.fromDate > req.query.toDate) {
            return res.status(400).json({ success:false, message:'From date cannot be later than to date' });
        }

        const params = [req.organizationId];
        const filters = ['"OrganizationId" = $1'];

        addDateFilter(filters, params, '"CreatedAt"', req.query.fromDate, 'fromDate');
        addDateFilter(filters, params, '"CreatedAt"', req.query.toDate, 'toDate', true);

        if (req.query.action) {
            params.push(String(req.query.action));
            filters.push(`"Action" = $${params.length}`);
        }

        if (req.query.entityType) {
            params.push(String(req.query.entityType));
            filters.push(`"EntityType" = $${params.length}`);
        }

        if (req.query.search) {
            params.push(`%${String(req.query.search).trim()}%`);
            filters.push(`("Summary" ILIKE $${params.length} OR "ActorName" ILIKE $${params.length} OR "ActorEmail" ILIKE $${params.length} OR "EntityId" ILIKE $${params.length})`);
        }

        const requestedLimit = Number(req.query.limit || 200);
        const limit = Number.isInteger(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 200;
        params.push(limit);

        const result = await db.query(`
            SELECT "Id", "ActorName", "ActorEmail", "ActorRole", "Action", "EntityType", "EntityId",
                   "Summary", "BeforeData", "AfterData", "Metadata", "IpAddress", "CreatedAt"
            FROM "AuditEvents"
            WHERE ${filters.join(' AND ')}
            ORDER BY "CreatedAt" DESC, "Id" DESC
            LIMIT $${params.length}
        `, params);

        const options = await db.query(`
            SELECT DISTINCT "Action", "EntityType"
            FROM "AuditEvents"
            WHERE "OrganizationId" = $1
            ORDER BY "EntityType", "Action"
        `, [req.organizationId]);

        res.json({ success:true, data:result.rows, filterOptions:options.rows, limit });
    } catch (err) {
        console.error(err);
        res.status(err.statusCode || 500).json({ success:false, message:err.statusCode ? err.message : 'Unable to load audit events' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT * FROM "AuditEvents"
            WHERE "Id" = $1 AND "OrganizationId" = $2
            LIMIT 1
        `, [req.params.id, req.organizationId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success:false, message:'Audit event not found' });
        }

        res.json({ success:true, data:result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(400).json({ success:false, message:'Invalid audit event ID' });
    }
});

module.exports = router;

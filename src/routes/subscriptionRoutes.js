const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');
const { authorizeRoles, normalizeRole } = require('../middleware/authorizationMiddleware');
const { writeAuditEvent } = require('../services/auditService');

function toDateOrNull(value) { return value ? value : null; }
function actorOrganization(req) { return req.user?.organizationId || null; }
function getTargetOrganizationId(req) {
    const role = normalizeRole(req.user?.role);
    return role === 'SUPER_ADMIN' && req.body?.OrganizationId ? req.body.OrganizationId : req.user?.organizationId;
}
async function safeAudit(payload) { try { await writeAuditEvent(payload); } catch (err) { console.warn('Subscription audit event skipped:', err.message); } }
function makeLicenseKey(planCode) {
    const cleanCode = String(planCode || 'FULL').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 12);
    return ['ASSOCIA', cleanCode || 'FULL', crypto.randomBytes(3).toString('hex').toUpperCase(), crypto.randomBytes(3).toString('hex').toUpperCase()].join('-');
}
function invalidUuidError(err) { return /invalid input syntax for type uuid/i.test(err.message || ''); }

router.get('/plans', authMiddleware, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT "Id", "PlanCode", "PlanName", "Description", "MonthlyPrice", "AnnualPrice", "MaxMembers", "MaxUsers", "MaxOrganizations", "IsActive"
            FROM "SubscriptionPlans"
            WHERE "IsActive" = TRUE
            ORDER BY "MonthlyPrice", "PlanName"
        `);
        res.json({ success:true, data:result.rows });
    } catch (err) { console.error(err); res.status(500).json({ success:false, message:'Unable to load subscription plans. Please confirm the subscription database setup has been applied.' }); }
});

router.get('/current', authMiddleware, async (req, res) => {
    try {
        const organizationId = req.user?.organizationId;
        if (!organizationId) return res.status(403).json({ success:false, message:'Your account is not assigned to an organization' });
        const result = await db.query(`
            SELECT s."Id", s."OrganizationId", s."PlanId", s."Status", s."StartDate", s."EndDate", s."TrialEndsAt", s."GraceEndsAt", s."CreatedAt",
                   p."PlanCode", p."PlanName", p."Description", p."MonthlyPrice", p."AnnualPrice", p."MaxMembers", p."MaxUsers", p."MaxOrganizations"
            FROM "OrganizationSubscriptions" s
            INNER JOIN "SubscriptionPlans" p ON s."PlanId" = p."Id"
            WHERE s."OrganizationId" = $1
            ORDER BY CASE WHEN s."Status" IN ('ACTIVE','TRIAL','GRACE') THEN 0 ELSE 1 END, s."EndDate" DESC, s."CreatedAt" DESC
            LIMIT 1
        `, [organizationId]);
        if (result.rows.length === 0) return res.json({ success:true, subscribed:false });
        const subscription = result.rows[0];
        const entitlements = await db.query(`
            SELECT "FeatureCode", "FeatureName", "IsEnabled"
            FROM "FeatureEntitlements"
            WHERE "PlanId" = $1
            ORDER BY "FeatureCode"
        `, [subscription.PlanId]);
        res.json({ success:true, subscribed:true, data:{ ...subscription, Entitlements:entitlements.rows } });
    } catch (err) { console.error(err); res.status(500).json({ success:false, message:'Unable to load current subscription' }); }
});

router.get('/all', authMiddleware, authorizeRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const result = await db.query(`
            SELECT o."Name" AS "OrganizationName", p."PlanName", p."MonthlyPrice", p."AnnualPrice",
                   s."Id", s."OrganizationId", s."PlanId", s."StartDate", s."EndDate", s."TrialEndsAt", s."GraceEndsAt",
                   CASE WHEN s."Status" IN ('ACTIVE','TRIAL','GRACE') AND s."EndDate" IS NOT NULL AND s."EndDate" < CURRENT_DATE THEN 'EXPIRED' ELSE s."Status" END AS "Status",
                   CASE WHEN s."EndDate" IS NULL THEN NULL ELSE (s."EndDate" - CURRENT_DATE) END AS "DaysRemaining"
            FROM "OrganizationSubscriptions" s
            INNER JOIN "Organizations" o ON s."OrganizationId" = o."Id"
            INNER JOIN "SubscriptionPlans" p ON s."PlanId" = p."Id"
            ORDER BY o."Name", s."EndDate" DESC
        `);
        res.json({ success:true, data:result.rows });
    } catch (err) { console.error(err); res.status(500).json({ success:false, message:'Unable to load organization subscriptions' }); }
});

router.post('/assign-plan', authMiddleware, authorizeRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const { OrganizationId, PlanId, StartDate, EndDate, Status } = req.body;
        if (!OrganizationId || !PlanId || !EndDate) return res.status(400).json({ success:false, message:'Organization, plan and end date are required' });
        const subscriptionId = await db.transaction(async tx => {
            await tx.query(`UPDATE "OrganizationSubscriptions" SET "Status" = 'REPLACED', "UpdatedAt" = CURRENT_TIMESTAMP WHERE "OrganizationId" = $1 AND "Status" IN ('ACTIVE','TRIAL','GRACE')`, [OrganizationId]);
            const insert = await tx.query(`
                INSERT INTO "OrganizationSubscriptions" ("OrganizationId", "PlanId", "StartDate", "EndDate", "Status", "CreatedAt", "UpdatedAt")
                VALUES ($1,$2,COALESCE($3::date,CURRENT_DATE),$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
                RETURNING "Id"
            `, [OrganizationId, PlanId, toDateOrNull(StartDate), toDateOrNull(EndDate), Status || 'ACTIVE']);
            return insert.rows[0].Id;
        });
        await safeAudit({ req, organizationId:OrganizationId, action:'SUBSCRIPTION_ASSIGNED', entityType:'SUBSCRIPTION', entityId:subscriptionId, summary:'Subscription plan assigned to organization', afterData:req.body });
        res.json({ success:true, message:'Subscription assigned successfully', subscriptionId });
    } catch (err) { console.error(err); res.status(invalidUuidError(err) ? 400 : 500).json({ success:false, message:invalidUuidError(err) ? 'Invalid organization or plan ID' : 'Unable to assign subscription' }); }
});

router.post('/renew', authMiddleware, authorizeRoles('SUPER_ADMIN', 'ADMIN'), async (req, res) => {
    try {
        const { SubscriptionId, NewEndDate } = req.body;
        if (!SubscriptionId || !NewEndDate) return res.status(400).json({ success:false, message:'Subscription and new end date are required' });
        const organizationId = normalizeRole(req.user?.role) === 'SUPER_ADMIN' ? null : actorOrganization(req);
        const result = await db.query(`
            UPDATE "OrganizationSubscriptions"
            SET "EndDate" = $1, "Status" = 'ACTIVE', "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Id" = $2 AND ($3::uuid IS NULL OR "OrganizationId" = $3::uuid)
            RETURNING "OrganizationId", "Id", "EndDate"
        `, [NewEndDate, SubscriptionId, organizationId]);
        if (result.rows.length === 0) return res.status(404).json({ success:false, message:'Subscription not found' });
        await safeAudit({ req, organizationId:result.rows[0].OrganizationId, action:'SUBSCRIPTION_RENEWED', entityType:'SUBSCRIPTION', entityId:SubscriptionId, summary:'Subscription renewed', afterData:{ NewEndDate } });
        res.json({ success:true, message:'Subscription renewed' });
    } catch (err) { console.error(err); res.status(invalidUuidError(err) ? 400 : 500).json({ success:false, message:invalidUuidError(err) ? 'Invalid subscription ID' : 'Unable to renew subscription' }); }
});

router.post('/suspend', authMiddleware, authorizeRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const { SubscriptionId } = req.body;
        if (!SubscriptionId) return res.status(400).json({ success:false, message:'Subscription is required' });
        const result = await db.query(`UPDATE "OrganizationSubscriptions" SET "Status" = 'SUSPENDED', "UpdatedAt" = CURRENT_TIMESTAMP WHERE "Id" = $1 RETURNING "OrganizationId"`, [SubscriptionId]);
        if (result.rows.length === 0) return res.status(404).json({ success:false, message:'Subscription not found' });
        await safeAudit({ req, organizationId:result.rows[0].OrganizationId, action:'SUBSCRIPTION_SUSPENDED', entityType:'SUBSCRIPTION', entityId:SubscriptionId, summary:'Subscription suspended' });
        res.json({ success:true, message:'Subscription suspended' });
    } catch (err) { console.error(err); res.status(invalidUuidError(err) ? 400 : 500).json({ success:false, message:invalidUuidError(err) ? 'Invalid subscription ID' : 'Unable to suspend subscription' }); }
});

router.post('/activate-license', authMiddleware, authorizeRoles('SUPER_ADMIN', 'ADMIN'), async (req, res) => {
    try {
        const { LicenseKey } = req.body;
        const organizationId = getTargetOrganizationId(req);
        if (!LicenseKey) return res.status(400).json({ success:false, message:'License key is required' });
        if (!organizationId) return res.status(400).json({ success:false, message:'Select an organization for this license' });
        const output = await db.transaction(async tx => {
            const licenseResult = await tx.query(`SELECT * FROM "LicenseKeys" WHERE "LicenseKey" = $1 LIMIT 1 FOR UPDATE`, [LicenseKey.trim()]);
            if (licenseResult.rows.length === 0) { const e = new Error('Invalid license key'); e.statusCode = 404; throw e; }
            const license = licenseResult.rows[0];
            if (license.Status !== 'UNUSED') { const e = new Error('This license key has already been used'); e.statusCode = 409; throw e; }
            if (license.ExpiresAt && new Date(license.ExpiresAt) < new Date()) { const e = new Error('This license key has expired'); e.statusCode = 409; throw e; }
            await tx.query(`UPDATE "OrganizationSubscriptions" SET "Status" = 'REPLACED', "UpdatedAt" = CURRENT_TIMESTAMP WHERE "OrganizationId" = $1 AND "Status" IN ('ACTIVE','TRIAL','GRACE')`, [organizationId]);
            const endDate = license.ExpiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
            const subscription = await tx.query(`
                INSERT INTO "OrganizationSubscriptions" ("OrganizationId", "PlanId", "LicenseKeyId", "Status", "StartDate", "EndDate", "CreatedAt", "UpdatedAt")
                VALUES ($1,$2,$3,'ACTIVE',CURRENT_DATE,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
                RETURNING "Id"
            `, [organizationId, license.PlanId, license.Id, endDate]);
            await tx.query(`UPDATE "LicenseKeys" SET "OrganizationId" = $1, "Status" = 'ACTIVATED', "ActivatedAt" = CURRENT_TIMESTAMP, "UpdatedAt" = CURRENT_TIMESTAMP WHERE "LicenseKey" = $2`, [organizationId, LicenseKey.trim()]);
            return { license, subscriptionId:subscription.rows[0].Id };
        });
        await safeAudit({ req, organizationId, action:'LICENSE_ACTIVATED', entityType:'LICENSE', entityId:output.license.Id, summary:'License activated and subscription assigned', metadata:{ subscriptionId:output.subscriptionId, licenseKey:LicenseKey.trim() } });
        res.json({ success:true, message:'License activated and subscription assigned', subscriptionId:output.subscriptionId });
    } catch (err) { console.error(err); res.status(err.statusCode || 500).json({ success:false, message:err.statusCode ? err.message : 'License activation failed' }); }
});

router.post('/licenses/generate', authMiddleware, authorizeRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const { PlanId, Quantity, ExpiresAt } = req.body;
        const quantity = Math.min(Math.max(Number(Quantity || 1), 1), 100);
        if (!PlanId) return res.status(400).json({ success:false, message:'Plan is required' });
        const planResult = await db.query(`SELECT "PlanCode" FROM "SubscriptionPlans" WHERE "Id" = $1 AND "IsActive" = TRUE LIMIT 1`, [PlanId]);
        if (planResult.rows.length === 0) return res.status(404).json({ success:false, message:'Plan not found' });
        const generated = [];
        for (let index = 0; index < quantity; index += 1) {
            const licenseKey = makeLicenseKey(planResult.rows[0].PlanCode);
            await db.query(`
                INSERT INTO "LicenseKeys" ("LicenseKey", "PlanId", "Status", "IssuedAt", "ExpiresAt", "CreatedAt", "UpdatedAt")
                VALUES ($1,$2,'UNUSED',CURRENT_TIMESTAMP,$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
            `, [licenseKey, PlanId, toDateOrNull(ExpiresAt)]);
            generated.push(licenseKey);
        }
        await safeAudit({ req, organizationId:actorOrganization(req), action:'LICENSE_KEYS_GENERATED', entityType:'LICENSE', summary:`${quantity} license key(s) generated`, metadata:{ PlanId, Quantity:quantity } });
        res.json({ success:true, message:'License key(s) generated', data:generated });
    } catch (err) { console.error(err); res.status(invalidUuidError(err) ? 400 : 500).json({ success:false, message:invalidUuidError(err) ? 'Invalid plan ID' : 'Unable to generate license keys' }); }
});

router.get('/licenses', authMiddleware, authorizeRoles('SUPER_ADMIN'), async (req, res) => {
    try {
        const result = await db.query(`
            SELECT l."Id", l."LicenseKey", l."Status", l."ExpiresAt", l."ActivatedAt", l."CreatedAt", p."PlanName", o."Name" AS "OrganizationName"
            FROM "LicenseKeys" l
            INNER JOIN "SubscriptionPlans" p ON l."PlanId" = p."Id"
            LEFT JOIN "Organizations" o ON l."OrganizationId" = o."Id"
            ORDER BY l."CreatedAt" DESC
        `);
        res.json({ success:true, data:result.rows });
    } catch (err) { console.error(err); res.status(500).json({ success:false, message:'Unable to load licenses' }); }
});

module.exports = router;

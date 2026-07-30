const express = require('express');
const router = express.Router();

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('../db');

const authMiddleware = require('../middleware/authMiddleware');

const {
    authorizeRoles,
    normalizeRole
} = require('../middleware/authorizationMiddleware');

const {
    ROLE_ORDER,
    ROLE_LABELS,
    ROLE_DESCRIPTIONS,
    ROLE_PERMISSIONS,
    isKnownRole,
    canAssignRole,
    getAssignableRoles,
    getRolePermissions
} = require('../config/rolePermissions');

const {
    writeAuditEvent
} = require('../services/auditService');

function sameId(left, right) {
    return String(left || '').toLowerCase() ===
        String(right || '').toLowerCase();
}

function cleanText(value, maxLength) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maxLength) : null;
}

function userSummary(user) {
    return {
        id:user.Id,
        organizationId:user.OrganizationId,
        fullName:user.FullName,
        email:user.Email,
        role:normalizeRole(user.Role),
        status:user.Status
    };
}

async function getSetupSummary() {
    const result = await db.query(`
        SELECT
            (SELECT COUNT(*) FROM "Organizations") AS "OrganizationCount",
            (SELECT COUNT(*) FROM "AdminUsers") AS "UserCount",
            (
                SELECT COUNT(*)
                FROM "AdminUsers"
                WHERE "Status" = 'ACTIVE'
            ) AS "ActiveUserCount"
    `);

    const row = result.rows[0] || {};
    const organizationCount = Number(row.OrganizationCount || 0);
    const userCount = Number(row.UserCount || 0);
    const activeUserCount = Number(row.ActiveUserCount || 0);

    return {
        organizationCount,
        userCount,
        activeUserCount,
        setupRequired:userCount === 0
    };
}

router.get('/setup-status', async (req, res) => {
    try {
        const summary = await getSetupSummary();

        res.json({
            success:true,
            data:{
                ...summary,
                message: summary.setupRequired
                    ? 'First-run setup is required'
                    : 'Associa setup is already complete'
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success:false,
            message:'Unable to check setup status'
        });
    }
});

router.post('/bootstrap', async (req, res) => {
    try {
        const summary = await getSetupSummary();

        if (!summary.setupRequired) {
            return res.status(409).json({
                success:false,
                message:'Associa setup is already complete. Please login instead.'
            });
        }

        const organizationName = cleanText(req.body.OrganizationName || req.body.organizationName, 255);
        const shortName = cleanText(req.body.ShortName || req.body.shortName, 100);
        const organizationType = cleanText(req.body.OrganizationType || req.body.organizationType, 100) || 'Association';
        const fullName = cleanText(req.body.FullName || req.body.fullName, 200);
        const email = String(req.body.Email || req.body.email || '').trim().toLowerCase();
        const password = String(req.body.Password || req.body.password || '');

        if (!organizationName || !fullName || !email || !password) {
            return res.status(400).json({
                success:false,
                message:'Organization name, full name, email and password are required'
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success:false,
                message:'Password must contain at least 8 characters'
            });
        }

        const output = await db.transaction(async tx => {
            const guard = await tx.query(`
                SELECT COUNT(*) AS "UserCount"
                FROM "AdminUsers"
                FOR UPDATE
            `);

            if (Number(guard.rows[0]?.UserCount || 0) > 0) {
                const error = new Error('Associa setup is already complete. Please login instead.');
                error.statusCode = 409;
                throw error;
            }

            const passwordHash = await bcrypt.hash(password, 12);

            const orgResult = await tx.query(`
                INSERT INTO "Organizations"
                (
                    "Name",
                    "ShortName",
                    "OrganizationType",
                    "CreatedAt"
                )
                VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                RETURNING "Id"
            `, [organizationName, shortName, organizationType]);

            const organizationId = orgResult.rows[0].Id;

            const userResult = await tx.query(`
                INSERT INTO "AdminUsers"
                (
                    "OrganizationId",
                    "FullName",
                    "Email",
                    "PasswordHash",
                    "Role",
                    "Status",
                    "CreatedAt"
                )
                VALUES ($1, $2, $3, $4, 'SUPER_ADMIN', 'ACTIVE', CURRENT_TIMESTAMP)
                RETURNING "Id"
            `, [organizationId, fullName, email, passwordHash]);

            return {
                organizationId,
                userId:userResult.rows[0].Id
            };
        });

        res.status(201).json({
            success:true,
            message:'First-run setup completed successfully. You can now login.',
            data:{
                organizationId:output.organizationId,
                userId:output.userId
            }
        });
    } catch (err) {
        console.error(err);
        res.status(err.statusCode || 500).json({
            success:false,
            message:err.message || 'Unable to complete first-run setup'
        });
    }
});

router.post('/login', async (req, res) => {
    try {
        const email = String(req.body.Email || req.body.email || '').trim().toLowerCase();
        const password = String(req.body.Password || req.body.password || '');

        if (!email || !password) {
            return res.status(400).json({
                success:false,
                message:'Email and password are required'
            });
        }

        const result = await db.query(`
            SELECT
                "Id",
                "OrganizationId",
                "FullName",
                "Email",
                "PasswordHash",
                "Role",
                "Status"
            FROM "AdminUsers"
            WHERE LOWER("Email") = $1
              AND "Status" = 'ACTIVE'
            LIMIT 1
        `, [email]);

        if (result.rows.length === 0) {
            return res.status(401).json({
                success:false,
                message:'Invalid email or password'
            });
        }

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.PasswordHash);

        if (!validPassword) {
            return res.status(401).json({
                success:false,
                message:'Invalid email or password'
            });
        }

        const token = jwt.sign(
            {
                id:user.Id,
                fullName:user.FullName,
                email:user.Email,
                role:normalizeRole(user.Role),
                organizationId:user.OrganizationId
            },
            process.env.JWT_SECRET,
            { expiresIn:'24h' }
        );

        res.json({
            success:true,
            token,
            user:{
                id:user.Id,
                fullName:user.FullName,
                email:user.Email,
                role:normalizeRole(user.Role),
                organizationId:user.OrganizationId
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success:false,
            message:'Unable to sign in'
        });
    }
});

router.get('/me', authMiddleware, async (req, res) => {
    res.json({
        success:true,
        user:{
            ...req.user,
            permissions:getRolePermissions(req.user?.role)
        }
    });
});

router.get('/roles', authMiddleware, authorizeRoles('SUPER_ADMIN', 'ADMIN'), async (req, res) => {
    const currentRole = normalizeRole(req.user?.role);

    res.json({
        success:true,
        data:{
            roles: ROLE_ORDER.map(role => ({
                Role:role,
                Label:ROLE_LABELS[role],
                Description:ROLE_DESCRIPTIONS[role],
                Permissions:ROLE_PERMISSIONS[role] || [],
                Assignable:canAssignRole(currentRole, role)
            })),
            assignableRoles:getAssignableRoles(currentRole),
            currentRole
        }
    });
});

router.post('/register', authMiddleware, authorizeRoles('SUPER_ADMIN', 'ADMIN'), async (req, res) => {
    try {
        const fullName = String(req.body.FullName || req.body.fullName || '').trim();
        const email = String(req.body.Email || req.body.email || '').trim().toLowerCase();
        const password = String(req.body.Password || req.body.password || '');
        const role = normalizeRole(req.body.Role || req.body.role);
        const requestingRole = normalizeRole(req.user.role);
        const requestedOrganizationId =
            req.body.OrganizationId ||
            req.body.organizationId ||
            req.headers['x-organization-id'] ||
            req.user.organizationId;
        const organizationId = requestingRole === 'SUPER_ADMIN'
            ? requestedOrganizationId
            : req.user.organizationId;

        if (!fullName || !email || !password || !role || !organizationId) {
            return res.status(400).json({
                success:false,
                message:'Full name, email, password, role and organization are required'
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success:false,
                message:'Password must contain at least 8 characters'
            });
        }

        if (!isKnownRole(role)) {
            return res.status(400).json({ success:false, message:'Invalid user role' });
        }

        if (!canAssignRole(requestingRole, role)) {
            return res.status(403).json({ success:false, message:'You cannot assign this role' });
        }

        const existing = await db.query(`
            SELECT "Id"
            FROM "AdminUsers"
            WHERE LOWER("Email") = $1
            LIMIT 1
        `, [email]);

        if (existing.rows.length > 0) {
            return res.status(409).json({ success:false, message:'Email already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const insertResult = await db.query(`
            INSERT INTO "AdminUsers"
            (
                "OrganizationId",
                "FullName",
                "Email",
                "PasswordHash",
                "Role",
                "Status",
                "CreatedAt"
            )
            VALUES ($1, $2, $3, $4, $5, 'ACTIVE', CURRENT_TIMESTAMP)
            RETURNING "Id"
        `, [organizationId, fullName, email, passwordHash, role]);

        const userId = insertResult.rows[0].Id;

        await writeAuditEvent({
            req,
            organizationId,
            action:'CREATE',
            entityType:'USER',
            entityId:userId,
            summary:`User ${email} created with role ${role}`,
            afterData:{ id:userId, organizationId, fullName, email, role, status:'ACTIVE' }
        });

        res.status(201).json({ success:true, message:'User created successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to create user' });
    }
});

router.get('/users', authMiddleware, authorizeRoles('SUPER_ADMIN', 'ADMIN'), async (req, res) => {
    try {
        const role = normalizeRole(req.user.role);
        const selectedOrganizationId = req.headers['x-organization-id'];
        const params = [];
        let where = '';

        if (role === 'SUPER_ADMIN' && selectedOrganizationId) {
            params.push(selectedOrganizationId);
            where = 'WHERE "OrganizationId" = $1';
        } else if (role !== 'SUPER_ADMIN') {
            params.push(req.user.organizationId);
            where = 'WHERE "OrganizationId" = $1';
        }

        const result = await db.query(`
            SELECT
                "Id",
                "OrganizationId",
                "FullName",
                "Email",
                "Role",
                "Status",
                "CreatedAt"
            FROM "AdminUsers"
            ${where}
            ORDER BY "FullName" ASC
        `, params);

        res.json({ success:true, data:result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to load users' });
    }
});

router.put('/users/:id', authMiddleware, authorizeRoles('SUPER_ADMIN', 'ADMIN'), async (req, res) => {
    try {
        const userId = req.params.id;
        const fullName = String(req.body.FullName || '').trim();
        const email = String(req.body.Email || '').trim().toLowerCase();
        const role = normalizeRole(req.body.Role);
        const actorRole = normalizeRole(req.user?.role);

        if (!fullName || !email || !role) {
            return res.status(400).json({ success:false, message:'Full name, email and role are required' });
        }

        if (!isKnownRole(role)) {
            return res.status(400).json({ success:false, message:'Invalid user role' });
        }

        if (!canAssignRole(actorRole, role)) {
            return res.status(403).json({ success:false, message:'You cannot assign this role' });
        }

        const beforeResult = await db.query(`
            SELECT "Id", "OrganizationId", "FullName", "Email", "Role", "Status"
            FROM "AdminUsers"
            WHERE "Id" = $1
            LIMIT 1
        `, [userId]);

        if (beforeResult.rows.length === 0) {
            return res.status(404).json({ success:false, message:'User not found' });
        }

        const beforeUser = beforeResult.rows[0];

        if (actorRole !== 'SUPER_ADMIN' && !sameId(beforeUser.OrganizationId, req.user.organizationId)) {
            return res.status(403).json({ success:false, message:'You can only manage users in your organization' });
        }

        if (actorRole === 'ADMIN' && ['SUPER_ADMIN', 'ADMIN'].includes(normalizeRole(beforeUser.Role))) {
            return res.status(403).json({ success:false, message:'Organization administrators cannot edit administrator accounts' });
        }

        const duplicateResult = await db.query(`
            SELECT "Id"
            FROM "AdminUsers"
            WHERE LOWER("Email") = $1
              AND "Id" <> $2
            LIMIT 1
        `, [email, userId]);

        if (duplicateResult.rows.length > 0) {
            return res.status(409).json({ success:false, message:'Email already exists' });
        }

        await db.query(`
            UPDATE "AdminUsers"
            SET
                "FullName" = $1,
                "Email" = $2,
                "Role" = $3,
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Id" = $4
        `, [fullName, email, role, userId]);

        await writeAuditEvent({
            req,
            organizationId:beforeUser.OrganizationId,
            action:'UPDATE',
            entityType:'USER',
            entityId:userId,
            summary:`User ${beforeUser.Email} updated`,
            beforeData:userSummary(beforeUser),
            afterData:{ id:userId, organizationId:beforeUser.OrganizationId, fullName, email, role, status:beforeUser.Status }
        });

        res.json({ success:true, message:'User updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to update user' });
    }
});

router.put('/users/:id/status', authMiddleware, authorizeRoles('SUPER_ADMIN', 'ADMIN'), async (req, res) => {
    try {
        const userId = req.params.id;
        const status = String(req.body.Status || '').trim().toUpperCase();

        if (!['ACTIVE', 'INACTIVE'].includes(status)) {
            return res.status(400).json({ success:false, message:'Invalid status' });
        }

        const beforeResult = await db.query(`
            SELECT "Id", "OrganizationId", "FullName", "Email", "Role", "Status"
            FROM "AdminUsers"
            WHERE "Id" = $1
            LIMIT 1
        `, [userId]);

        if (beforeResult.rows.length === 0) {
            return res.status(404).json({ success:false, message:'User not found' });
        }

        const beforeUser = beforeResult.rows[0];
        const actorRole = normalizeRole(req.user?.role);

        if (sameId(userId, req.user?.id) && status === 'INACTIVE') {
            return res.status(400).json({ success:false, message:'You cannot deactivate your own account' });
        }

        if (actorRole !== 'SUPER_ADMIN' && !sameId(beforeUser.OrganizationId, req.user.organizationId)) {
            return res.status(403).json({ success:false, message:'You can only manage users in your organization' });
        }

        if (actorRole === 'ADMIN' && ['SUPER_ADMIN', 'ADMIN'].includes(normalizeRole(beforeUser.Role))) {
            return res.status(403).json({ success:false, message:'Organization administrators cannot change administrator account status' });
        }

        await db.query(`
            UPDATE "AdminUsers"
            SET "Status" = $1,
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Id" = $2
        `, [status, userId]);

        await writeAuditEvent({
            req,
            organizationId:beforeUser.OrganizationId,
            action:'UPDATE',
            entityType:'USER',
            entityId:userId,
            summary:`User ${beforeUser.Email} status changed to ${status}`,
            beforeData:userSummary(beforeUser),
            afterData:{ ...userSummary(beforeUser), status }
        });

        res.json({ success:true, message:'Status updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to update status' });
    }
});

router.put('/users/:id/reset-password', authMiddleware, authorizeRoles('SUPER_ADMIN', 'ADMIN'), async (req, res) => {
    try {
        const userId = req.params.id;
        const password = String(req.body.Password || '');

        if (password.length < 8) {
            return res.status(400).json({ success:false, message:'Password must be at least 8 characters' });
        }

        const beforeResult = await db.query(`
            SELECT "Id", "OrganizationId", "FullName", "Email", "Role", "Status"
            FROM "AdminUsers"
            WHERE "Id" = $1
            LIMIT 1
        `, [userId]);

        if (beforeResult.rows.length === 0) {
            return res.status(404).json({ success:false, message:'User not found' });
        }

        const beforeUser = beforeResult.rows[0];
        const actorRole = normalizeRole(req.user?.role);

        if (actorRole !== 'SUPER_ADMIN' && !sameId(beforeUser.OrganizationId, req.user.organizationId)) {
            return res.status(403).json({ success:false, message:'You can only reset passwords for users in your organization' });
        }

        if (actorRole === 'ADMIN' && ['SUPER_ADMIN', 'ADMIN'].includes(normalizeRole(beforeUser.Role))) {
            return res.status(403).json({ success:false, message:'Organization administrators cannot reset administrator passwords' });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        await db.query(`
            UPDATE "AdminUsers"
            SET "PasswordHash" = $1,
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Id" = $2
        `, [passwordHash, userId]);

        await writeAuditEvent({
            req,
            organizationId:beforeUser.OrganizationId,
            action:'UPDATE',
            entityType:'USER',
            entityId:userId,
            summary:`Password reset for ${beforeUser.Email}`,
            metadata:{ targetUser:beforeUser.Email }
        });

        res.json({ success:true, message:'Password reset successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Unable to reset password' });
    }
});

module.exports = router;

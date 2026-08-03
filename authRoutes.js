const express = require('express');
const router = express.Router();

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { sql } =
require('../config/database');

const authMiddleware =
require('../middleware/authMiddleware');

const {
    authorizeRoles,
    normalizeRole
} =
require('../middleware/authorizationMiddleware');

const {
    ROLE_ORDER,
    ROLE_LABELS,
    ROLE_DESCRIPTIONS,
    ROLE_PERMISSIONS,
    isKnownRole,
    canAssignRole,
    getAssignableRoles,
    getRolePermissions
} =
require('../config/rolePermissions');

const {
    writeAuditEvent
} =
require('../services/auditService');

function sameId(left, right) {
    return String(left || '').toLowerCase() ===
        String(right || '').toLowerCase();
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

function cleanText(value, maxLength) {

    const text =
        String(value || '')
        .trim();

    return text
        ? text.slice(0, maxLength)
        : null;

}

async function getSetupSummary() {

    const result =
        await sql.query(`

            SELECT
                (
                    SELECT COUNT(*)
                    FROM Organizations
                ) AS OrganizationCount,
                (
                    SELECT COUNT(*)
                    FROM AdminUsers
                ) AS UserCount,
                (
                    SELECT COUNT(*)
                    FROM AdminUsers
                    WHERE Status = 'ACTIVE'
                ) AS ActiveUserCount

        `);

    const row =
        result.recordset[0] || {};

    const organizationCount =
        Number(row.OrganizationCount || 0);

    const userCount =
        Number(row.UserCount || 0);

    const activeUserCount =
        Number(row.ActiveUserCount || 0);

    return {
        organizationCount,
        userCount,
        activeUserCount,
        setupRequired:
            userCount === 0
    };

}

// =====================================================
// FIRST-RUN SETUP STATUS
// =====================================================

router.get(
'/setup-status',
async (req, res) => {

try {

    const summary =
        await getSetupSummary();

    res.json({
        success:true,
        data:{
            ...summary,
            message:
                summary.setupRequired
                    ? 'First-run setup is required'
                    : 'Associa setup is already complete'
        }
    });

} catch(err) {

    console.error(err);

    res.status(500).json({
        success:false,
        message:
            'Unable to check setup status'
    });

}

}
);

// =====================================================
// FIRST-RUN BOOTSTRAP
// =====================================================

router.post(
'/bootstrap',
async (req, res) => {

try {

    const summary =
        await getSetupSummary();

    if (!summary.setupRequired) {

        return res.status(409).json({
            success:false,
            message:
                'Associa setup is already complete. Please login instead.'
        });

    }

    const organizationName =
        cleanText(
            req.body.OrganizationName ||
            req.body.organizationName,
            255
        );

    const shortName =
        cleanText(
            req.body.ShortName ||
            req.body.shortName,
            100
        );

    const organizationType =
        cleanText(
            req.body.OrganizationType ||
            req.body.organizationType,
            100
        ) || 'Association';

    const fullName =
        cleanText(
            req.body.FullName ||
            req.body.fullName,
            200
        );

    const email =
        String(
            req.body.Email ||
            req.body.email ||
            ''
        )
        .trim()
        .toLowerCase();

    const password =
        String(
            req.body.Password ||
            req.body.password ||
            ''
        );

    if (
        !organizationName ||
        !fullName ||
        !email ||
        !password
    ) {

        return res.status(400).json({
            success:false,
            message:
                'Organization name, full name, email and password are required'
        });

    }

    if (password.length < 8) {

        return res.status(400).json({
            success:false,
            message:
                'Password must contain at least 8 characters'
        });

    }

    const transaction =
        new sql.Transaction();

    await transaction.begin();

    try {

        const guardRequest =
            new sql.Request(transaction);

        const guard =
            await guardRequest.query(`

                SELECT TOP 1 Id
                FROM AdminUsers WITH (UPDLOCK, HOLDLOCK)

            `);

        if (
            guard.recordset.length > 0
        ) {

            await transaction.rollback();

            return res.status(409).json({
                success:false,
                message:
                    'Associa setup is already complete. Please login instead.'
            });

        }

        const passwordHash =
            await bcrypt.hash(
                password,
                12
            );

        const request =
            new sql.Request(transaction);

        request.input(
            'OrganizationName',
            sql.NVarChar(255),
            organizationName
        );

        request.input(
            'ShortName',
            sql.NVarChar(100),
            shortName
        );

        request.input(
            'OrganizationType',
            sql.NVarChar(100),
            organizationType
        );

        request.input(
            'FullName',
            sql.NVarChar(200),
            fullName
        );

        request.input(
            'Email',
            sql.NVarChar(255),
            email
        );

        request.input(
            'PasswordHash',
            sql.NVarChar(255),
            passwordHash
        );

        const result =
            await request.query(`

                DECLARE @OrganizationId UNIQUEIDENTIFIER = NEWID();
                DECLARE @UserId UNIQUEIDENTIFIER = NEWID();

                INSERT INTO Organizations
                (
                    Id,
                    Name,
                    ShortName,
                    OrganizationType,
                    CreatedAt
                )
                VALUES
                (
                    @OrganizationId,
                    @OrganizationName,
                    @ShortName,
                    @OrganizationType,
                    GETDATE()
                );

                INSERT INTO AdminUsers
                (
                    Id,
                    OrganizationId,
                    FullName,
                    Email,
                    PasswordHash,
                    Role,
                    Status,
                    CreatedAt
                )
                VALUES
                (
                    @UserId,
                    @OrganizationId,
                    @FullName,
                    @Email,
                    @PasswordHash,
                    'SUPER_ADMIN',
                    'ACTIVE',
                    GETDATE()
                );

                SELECT
                    @OrganizationId AS OrganizationId,
                    @UserId AS UserId;

            `);

        await transaction.commit();

        res.status(201).json({
            success:true,
            message:
                'First-run setup completed successfully. You can now login.',
            data:{
                organizationId:
                    result.recordset[0]
                    ?.OrganizationId,
                userId:
                    result.recordset[0]
                    ?.UserId
            }
        });

    } catch(error) {

        await transaction.rollback();
        throw error;

    }

} catch(err) {

    console.error(err);

    res.status(500).json({
        success:false,
        message:
            err.message ||
            'Unable to complete first-run setup'
    });

}

}
);

// =====================================================
// LOGIN
// =====================================================

router.post(
'/login',
async (req, res) => {

try {

    const email =
        String(
            req.body.Email ||
            req.body.email ||
            ''
        )
        .trim()
        .toLowerCase();

    const password =
        String(
            req.body.Password ||
            req.body.password ||
            ''
        );

    if (!email || !password) {

        return res.status(400).json({
            success:false,
            message:
                'Email and password are required'
        });

    }

    const request =
        new sql.Request();

    request.input(
        'Email',
        sql.NVarChar(255),
        email
    );

    const result =
        await request.query(`

            SELECT TOP 1
                Id,
                OrganizationId,
                FullName,
                Email,
                PasswordHash,
                Role,
                Status
            FROM AdminUsers
            WHERE
                LOWER(Email) = @Email
                AND Status = 'ACTIVE'

        `);

    if (
        result.recordset.length === 0
    ) {

        return res.status(401).json({
            success:false,
            message:
                'Invalid email or password'
        });

    }

    const user =
        result.recordset[0];

    const validPassword =
        await bcrypt.compare(
            password,
            user.PasswordHash
        );

    if (!validPassword) {

        return res.status(401).json({
            success:false,
            message:
                'Invalid email or password'
        });

    }

    const token =
        jwt.sign(
            {
                id:user.Id,
                fullName:user.FullName,
                email:user.Email,
                role:
                    normalizeRole(
                        user.Role
                    ),
                organizationId:
                    user.OrganizationId
            },
            process.env.JWT_SECRET,
            {
                expiresIn:'24h'
            }
        );

    res.json({
        success:true,
        token,
        user:{
            id:user.Id,
            fullName:user.FullName,
            email:user.Email,
            role:
                normalizeRole(
                    user.Role
                ),
            organizationId:
                user.OrganizationId
        }
    });

} catch(err) {

    console.error(err);

    res.status(500).json({
        success:false,
        message:'Unable to sign in'
    });

}

});

// =====================================================
// CURRENT USER
// =====================================================

router.get(
'/me',
authMiddleware,
async (req, res) => {

    res.json({
        success:true,
        user:{
            ...req.user,
            permissions:
                getRolePermissions(
                    req.user?.role
                )
        }
    });

}
);

// =====================================================
// ROLE MATRIX
// =====================================================

router.get(
'/roles',
authMiddleware,
authorizeRoles(
    'SUPER_ADMIN',
    'ADMIN'
),
async (req, res) => {

    const currentRole =
        normalizeRole(
            req.user?.role
        );

    res.json({
        success:true,
        data:{
            roles:
                ROLE_ORDER.map(role => ({
                    Role:role,
                    Label:
                        ROLE_LABELS[role],
                    Description:
                        ROLE_DESCRIPTIONS[role],
                    Permissions:
                        ROLE_PERMISSIONS[role] || [],
                    Assignable:
                        canAssignRole(
                            currentRole,
                            role
                        )
                })),
            assignableRoles:
                getAssignableRoles(
                    currentRole
                ),
            currentRole
        }
    });

}
);

// =====================================================
// CREATE USER
// =====================================================

router.post(
'/register',
authMiddleware,
authorizeRoles(
    'SUPER_ADMIN',
    'ADMIN'
),
async (req, res) => {

try {

    const fullName =
        String(
            req.body.FullName ||
            req.body.fullName ||
            ''
        ).trim();

    const email =
        String(
            req.body.Email ||
            req.body.email ||
            ''
        )
        .trim()
        .toLowerCase();

    const password =
        String(
            req.body.Password ||
            req.body.password ||
            ''
        );

    const role =
        normalizeRole(
            req.body.Role ||
            req.body.role
        );

    const requestingRole =
        normalizeRole(
            req.user.role
        );

    const requestedOrganizationId =
        req.body.OrganizationId ||
        req.body.organizationId ||
        req.headers['x-organization-id'] ||
        req.user.organizationId;

    const organizationId =
        requestingRole ===
        'SUPER_ADMIN'
            ? requestedOrganizationId
            : req.user.organizationId;

    if (
        !fullName ||
        !email ||
        !password ||
        !role ||
        !organizationId
    ) {

        return res.status(400).json({
            success:false,
            message:
                'Full name, email, password, role and organization are required'
        });

    }

    if (password.length < 8) {

        return res.status(400).json({
            success:false,
            message:
                'Password must contain at least 8 characters'
        });

    }

    if (!isKnownRole(role)) {

        return res.status(400).json({
            success:false,
            message:'Invalid user role'
        });

    }

    if (!canAssignRole(
        requestingRole,
        role
    )) {

        return res.status(403).json({
            success:false,
            message:
                'You cannot assign this role'
        });

    }

    const existingRequest =
        new sql.Request();

    existingRequest.input(
        'Email',
        sql.NVarChar(255),
        email
    );

    const existing =
        await existingRequest.query(`

            SELECT TOP 1 Id
            FROM AdminUsers
            WHERE LOWER(Email) = @Email

        `);

    if (
        existing.recordset.length > 0
    ) {

        return res.status(409).json({
            success:false,
            message:'Email already exists'
        });

    }

    const passwordHash =
        await bcrypt.hash(
            password,
            12
        );

    const insertRequest =
        new sql.Request();

    insertRequest.input(
        'OrganizationId',
        sql.UniqueIdentifier,
        organizationId
    );

    insertRequest.input(
        'FullName',
        sql.NVarChar(200),
        fullName
    );

    insertRequest.input(
        'Email',
        sql.NVarChar(255),
        email
    );

    insertRequest.input(
        'PasswordHash',
        sql.NVarChar(255),
        passwordHash
    );

    insertRequest.input(
        'Role',
        sql.NVarChar(50),
        role
    );

    const insertResult =
        await insertRequest.query(`

        DECLARE @UserId
            UNIQUEIDENTIFIER =
            NEWID();

        INSERT INTO AdminUsers
        (
            Id,
            OrganizationId,
            FullName,
            Email,
            PasswordHash,
            Role,
            Status,
            CreatedAt
        )
        VALUES
        (
            @UserId,
            @OrganizationId,
            @FullName,
            @Email,
            @PasswordHash,
            @Role,
            'ACTIVE',
            GETDATE()
        )

        SELECT @UserId
            AS UserId;

    `);

    const userId =
        insertResult.recordset[0]
        .UserId;

    await writeAuditEvent({
        req,
        organizationId,
        action:'CREATE',
        entityType:'USER',
        entityId:userId,
        summary:
            `User ${email} created with role ${role}`,
        afterData:{
            id:userId,
            organizationId,
            fullName,
            email,
            role,
            status:'ACTIVE'
        }
    });

    res.status(201).json({
        success:true,
        message:
            'User created successfully'
    });

} catch(err) {

    console.error(err);

    res.status(500).json({
        success:false,
        message:'Unable to create user'
    });

}

}
);
// =====================================================
// GET USERS
// =====================================================

router.get(
'/users',
authMiddleware,
authorizeRoles(
    'SUPER_ADMIN',
    'ADMIN'
),
async (req, res) => {

try {

    const role =
        normalizeRole(
            req.user.role
        );

    const request =
        new sql.Request();

    let query = `

        SELECT
            Id,
            OrganizationId,
            FullName,
            Email,
            Role,
            Status,
            CreatedAt
        FROM AdminUsers

    `;

    const selectedOrganizationId =
        req.headers['x-organization-id'];

    if (
        role === 'SUPER_ADMIN' &&
        selectedOrganizationId
    ) {

        request.input(
            'OrganizationId',
            sql.UniqueIdentifier,
            selectedOrganizationId
        );

        query += `
            WHERE OrganizationId =
            @OrganizationId
        `;

    } else if (role !== 'SUPER_ADMIN') {

        request.input(
            'OrganizationId',
            sql.UniqueIdentifier,
            req.user.organizationId
        );

        query += `
            WHERE OrganizationId =
            @OrganizationId
        `;

    }

    query += `
        ORDER BY
        FullName ASC
    `;

    const result =
        await request.query(
            query
        );

    res.json({
        success:true,
        data:
            result.recordset
    });

}
catch(err) {

    console.error(err);

    res.status(500).json({
        success:false,
        message:
            'Unable to load users'
    });

}

}
);
// =====================================================
// UPDATE USER
// =====================================================

router.put(
'/users/:id',
authMiddleware,
authorizeRoles(
    'SUPER_ADMIN',
    'ADMIN'
),
async (req, res) => {

try {

    const userId =
        req.params.id;

    const fullName =
        String(
            req.body.FullName || ''
        ).trim();

    const email =
        String(
            req.body.Email || ''
        )
        .trim()
        .toLowerCase();

    const role =
        normalizeRole(
            req.body.Role
        );

    const actorRole =
        normalizeRole(
            req.user?.role
        );

    if (
        !fullName ||
        !email ||
        !role
    ) {

        return res.status(400).json({
            success:false,
            message:
                'Full name, email and role are required'
        });

    }

    if (!isKnownRole(role)) {

        return res.status(400).json({
            success:false,
            message:'Invalid user role'
        });

    }

    if (!canAssignRole(
        actorRole,
        role
    )) {

        return res.status(403).json({
            success:false,
            message:
                'You cannot assign this role'
        });

    }

    const request =
        new sql.Request();

    request.input(
        'UserId',
        sql.UniqueIdentifier,
        userId
    );

    request.input(
        'FullName',
        sql.NVarChar(200),
        fullName
    );

    request.input(
        'Email',
        sql.NVarChar(255),
        email
    );

    request.input(
        'Role',
        sql.NVarChar(50),
        role
    );

    const beforeResult =
        await request.query(`

        SELECT TOP 1
            Id,
            OrganizationId,
            FullName,
            Email,
            Role,
            Status
        FROM AdminUsers
        WHERE Id = @UserId

    `);

    if (
        beforeResult.recordset.length === 0
    ) {

        return res.status(404).json({
            success:false,
            message:'User not found'
        });

    }

    const beforeUser =
        beforeResult.recordset[0];

    if (
        actorRole !== 'SUPER_ADMIN' &&
        !sameId(
            beforeUser.OrganizationId,
            req.user.organizationId
        )
    ) {

        return res.status(403).json({
            success:false,
            message:
                'You can only manage users in your organization'
        });

    }

    if (
        actorRole === 'ADMIN' &&
        [
            'SUPER_ADMIN',
            'ADMIN'
        ].includes(
            normalizeRole(
                beforeUser.Role
            )
        )
    ) {

        return res.status(403).json({
            success:false,
            message:
                'Organization administrators cannot edit administrator accounts'
        });

    }

    const duplicateRequest =
        new sql.Request();

    duplicateRequest.input(
        'UserId',
        sql.UniqueIdentifier,
        userId
    );

    duplicateRequest.input(
        'Email',
        sql.NVarChar(255),
        email
    );

    const duplicateResult =
        await duplicateRequest.query(`

        SELECT TOP 1 Id
        FROM AdminUsers
        WHERE LOWER(Email) = @Email
          AND Id <> @UserId

    `);

    if (
        duplicateResult.recordset.length > 0
    ) {

        return res.status(409).json({
            success:false,
            message:'Email already exists'
        });

    }

    await request.query(`

        UPDATE AdminUsers
        SET
            FullName =
                @FullName,
            Email =
                @Email,
            Role =
                @Role
        WHERE
            Id = @UserId

    `);

    await writeAuditEvent({
        req,
        organizationId:
            beforeUser.OrganizationId,
        action:'UPDATE',
        entityType:'USER',
        entityId:userId,
        summary:
            `User ${beforeUser.Email} updated`,
        beforeData:
            userSummary(
                beforeUser
            ),
        afterData:{
            id:userId,
            organizationId:
                beforeUser.OrganizationId,
            fullName,
            email,
            role,
            status:
                beforeUser.Status
        }
    });

    res.json({
        success:true,
        message:
            'User updated successfully'
    });

}
catch(err) {

    console.error(err);

    res.status(500).json({
        success:false,
        message:
            'Unable to update user'
    });

}

}
);
// =====================================================
// USER STATUS
// =====================================================

router.put(
'/users/:id/status',
authMiddleware,
authorizeRoles(
    'SUPER_ADMIN',
    'ADMIN'
),
async (req, res) => {

try {

    const userId =
        req.params.id;

    const status =
        String(
            req.body.Status || ''
        )
        .trim()
        .toUpperCase();

    if (
        status !== 'ACTIVE' &&
        status !== 'INACTIVE'
    ) {

        return res.status(400)
        .json({
            success:false,
            message:
                'Invalid status'
        });

    }

    const request =
        new sql.Request();

    request.input(
        'UserId',
        sql.UniqueIdentifier,
        userId
    );

    request.input(
        'Status',
        sql.NVarChar(20),
        status
    );

    const beforeResult =
        await request.query(`

        SELECT TOP 1
            Id,
            OrganizationId,
            FullName,
            Email,
            Role,
            Status
        FROM AdminUsers
        WHERE Id = @UserId

    `);

    if (
        beforeResult.recordset.length === 0
    ) {

        return res.status(404).json({
            success:false,
            message:'User not found'
        });

    }

    const beforeUser =
        beforeResult.recordset[0];

    const actorRole =
        normalizeRole(
            req.user?.role
        );

    if (
        sameId(
            userId,
            req.user?.id
        ) &&
        status === 'INACTIVE'
    ) {

        return res.status(400).json({
            success:false,
            message:
                'You cannot deactivate your own account'
        });

    }

    if (
        actorRole !== 'SUPER_ADMIN' &&
        !sameId(
            beforeUser.OrganizationId,
            req.user.organizationId
        )
    ) {

        return res.status(403).json({
            success:false,
            message:
                'You can only manage users in your organization'
        });

    }

    if (
        actorRole === 'ADMIN' &&
        [
            'SUPER_ADMIN',
            'ADMIN'
        ].includes(
            normalizeRole(
                beforeUser.Role
            )
        )
    ) {

        return res.status(403).json({
            success:false,
            message:
                'Organization administrators cannot change administrator account status'
        });

    }

    await request.query(`

        UPDATE AdminUsers
        SET
            Status =
                @Status
        WHERE
            Id = @UserId

    `);

    await writeAuditEvent({
        req,
        organizationId:
            beforeUser.OrganizationId,
        action:'UPDATE',
        entityType:'USER',
        entityId:userId,
        summary:
            `User ${beforeUser.Email} status changed to ${status}`,
        beforeData:
            userSummary(
                beforeUser
            ),
        afterData:{
            ...userSummary(
                beforeUser
            ),
            status
        }
    });

    res.json({
        success:true,
        message:
            'Status updated'
    });

}
catch(err) {

    console.error(err);

    res.status(500).json({
        success:false,
        message:
            'Unable to update status'
    });

}

}
);
// =====================================================
// RESET PASSWORD
// =====================================================

router.put(
'/users/:id/reset-password',
authMiddleware,
authorizeRoles(
    'SUPER_ADMIN',
    'ADMIN'
),
async (req, res) => {

try {

    const userId =
        req.params.id;

    const password =
        String(
            req.body.Password || ''
        );

    if (
        password.length < 8
    ) {

        return res.status(400)
        .json({
            success:false,
            message:
                'Password must be at least 8 characters'
        });

    }

    const passwordHash =
        await bcrypt.hash(
            password,
            12
        );

    const request =
        new sql.Request();

    request.input(
        'UserId',
        sql.UniqueIdentifier,
        userId
    );

    request.input(
        'PasswordHash',
        sql.NVarChar(255),
        passwordHash
    );

    const beforeResult =
        await request.query(`

        SELECT TOP 1
            Id,
            OrganizationId,
            FullName,
            Email,
            Role,
            Status
        FROM AdminUsers
        WHERE Id = @UserId

    `);

    if (
        beforeResult.recordset.length === 0
    ) {

        return res.status(404).json({
            success:false,
            message:'User not found'
        });

    }

    const beforeUser =
        beforeResult.recordset[0];

    const actorRole =
        normalizeRole(
            req.user?.role
        );

    if (
        actorRole !== 'SUPER_ADMIN' &&
        !sameId(
            beforeUser.OrganizationId,
            req.user.organizationId
        )
    ) {

        return res.status(403).json({
            success:false,
            message:
                'You can only reset passwords for users in your organization'
        });

    }

    if (
        actorRole === 'ADMIN' &&
        [
            'SUPER_ADMIN',
            'ADMIN'
        ].includes(
            normalizeRole(
                beforeUser.Role
            )
        )
    ) {

        return res.status(403).json({
            success:false,
            message:
                'Organization administrators cannot reset administrator passwords'
        });

    }

    await request.query(`

        UPDATE AdminUsers
        SET
            PasswordHash =
                @PasswordHash
        WHERE
            Id = @UserId

    `);

    await writeAuditEvent({
        req,
        organizationId:
            beforeUser.OrganizationId,
        action:'UPDATE',
        entityType:'USER',
        entityId:userId,
        summary:
            `Password reset for ${beforeUser.Email}`,
        metadata:{
            targetUser:
                beforeUser.Email
        }
    });

    res.json({
        success:true,
        message:
            'Password reset successfully'
    });

}
catch(err) {

    console.error(err);

    res.status(500).json({
        success:false,
        message:
            'Unable to reset password'
    });

}

}
);
module.exports = router;

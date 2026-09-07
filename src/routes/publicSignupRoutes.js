const express = require('express');
const bcrypt = require('bcryptjs');

const router = express.Router();
const db = require('../db');

function cleanText(value, maxLength) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maxLength) : null;
}

router.post('/organization-signup', async (req, res) => {
    const organizationName = cleanText(
        req.body.OrganizationName || req.body.organizationName,
        255
    );
    const shortName = cleanText(
        req.body.ShortName || req.body.shortName,
        100
    );
    const organizationType = cleanText(
        req.body.OrganizationType || req.body.organizationType,
        100
    ) || 'Association';
    const fullName = cleanText(
        req.body.FullName || req.body.fullName,
        200
    );
    const email = String(
        req.body.Email || req.body.email || ''
    ).trim().toLowerCase();
    const password = String(
        req.body.Password || req.body.password || ''
    );

    if (!organizationName || !fullName || !email || !password) {
        return res.status(400).json({
            success: false,
            message: 'Organization name, full name, email and password are required'
        });
    }

    if (password.length < 8) {
        return res.status(400).json({
            success: false,
            message: 'Password must contain at least 8 characters'
        });
    }

    await db.query('BEGIN');

    try {
        const existingUser = await db.query(`
            SELECT "Id"
            FROM "AdminUsers"
            WHERE LOWER("Email") = $1
            LIMIT 1
        `, [email]);

        if (existingUser.rows.length > 0) {
            await db.query('ROLLBACK');

            return res.status(409).json({
                success: false,
                message: 'An account already exists with this email address'
            });
        }

        const existingOrganization = await db.query(`
            SELECT "Id"
            FROM "Organizations"
            WHERE LOWER(TRIM("Name")) = LOWER(TRIM($1))
               OR (
                    COALESCE(TRIM($2), '') <> ''
                    AND LOWER(TRIM(COALESCE("ShortName", ''))) = LOWER(TRIM($2))
               )
            LIMIT 1
        `, [organizationName, shortName]);

        if (existingOrganization.rows.length > 0) {
            await db.query('ROLLBACK');

            return res.status(409).json({
                success: false,
                message: 'An organization with this name or short name already exists'
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const organizationResult = await db.query(`
            INSERT INTO "Organizations"
            (
                "Id",
                "Name",
                "ShortName",
                "OrganizationType",
                "CreatedAt"
            )
            VALUES
            (
                gen_random_uuid(),
                $1,
                $2,
                $3,
                CURRENT_TIMESTAMP
            )
            RETURNING "Id"
        `, [
            organizationName,
            shortName,
            organizationType
        ]);

        const organizationId = organizationResult.rows[0].Id;

        const userResult = await db.query(`
            INSERT INTO "AdminUsers"
            (
                "Id",
                "OrganizationId",
                "FullName",
                "Email",
                "PasswordHash",
                "Role",
                "Status",
                "CreatedAt"
            )
            VALUES
            (
                gen_random_uuid(),
                $1,
                $2,
                $3,
                $4,
                'ADMIN',
                'ACTIVE',
                CURRENT_TIMESTAMP
            )
            RETURNING "Id"
        `, [
            organizationId,
            fullName,
            email,
            passwordHash
        ]);

        await db.query('COMMIT');

        return res.status(201).json({
            success: true,
            message: 'Organization account created successfully. You can now login and choose a subscription plan.',
            data: {
                organizationId,
                userId: userResult.rows[0].Id
            }
        });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error(err);

        return res.status(500).json({
            success: false,
            message: err.message || 'Unable to create organization account'
        });
    }
});

module.exports = router;

const express = require('express');
const router = express.Router();

const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const db = require('../db');

const authMiddleware = require('../middleware/authMiddleware');

const {
    authorizeRoles,
    requireOrganization
} = require('../middleware/authorizationMiddleware');

const {
    writeAuditEvent
} = require('../services/auditService');

const storage = multer.diskStorage({
    destination:function(req, file, cb) {
        cb(null, 'uploads/logo');
    },
    filename:function(req, file, cb) {
        const extension = path.extname(file.originalname).toLowerCase();

        cb(
            null,
            `${req.organizationId}-${crypto.randomUUID()}${extension}`
        );
    }
});

const upload = multer({
    storage,
    limits:{
        fileSize:2 * 1024 * 1024
    },
    fileFilter:function(req, file, cb) {
        const allowedTypes = new Set([
            'image/png',
            'image/jpeg',
            'image/webp'
        ]);

        if (!allowedTypes.has(file.mimetype)) {
            return cb(
                new Error('Logo must be a PNG, JPEG or WebP image')
            );
        }

        cb(null, true);
    }
});

function cleanText(value, maxLength, fallback = '') {
    const text = String(value ?? fallback).trim();
    return text.slice(0, maxLength);
}

router.get(
    '/',
    authMiddleware,
    requireOrganization,
    async (req, res) => {
        try {
            const result = await db.query(`
                SELECT *
                FROM "AssociationSettings"
                WHERE "OrganizationId" = $1
                LIMIT 1
            `, [req.organizationId]);

            res.json({
                success:true,
                data:result.rows[0] || null
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success:false,
                message:'Unable to load settings'
            });
        }
    }
);

router.post(
    '/upload-logo',
    authMiddleware,
    requireOrganization,
    authorizeRoles('SUPER_ADMIN', 'ADMIN'),
    upload.single('logo'),
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                success:false,
                message:'Logo file is required'
            });
        }

        res.json({
            success:true,
            logoPath:req.file.path.replace(/\\/g, '/')
        });
    }
);

router.post(
    '/',
    authMiddleware,
    requireOrganization,
    authorizeRoles('SUPER_ADMIN', 'ADMIN'),
    async (req, res) => {
        try {
            const values = {
                associationName:cleanText(req.body.associationName, 255),
                slogan:cleanText(req.body.slogan, 500),
                address:cleanText(req.body.address, 1000),
                phone:cleanText(req.body.phone, 100),
                email:cleanText(req.body.email, 255),
                website:cleanText(req.body.website, 500),
                logoPath:cleanText(req.body.logoPath, 1000),
                dashboardTitle:cleanText(req.body.dashboardTitle, 255),
                dashboardMessage:cleanText(req.body.dashboardMessage, 1000),
                dashboardNotice:cleanText(req.body.dashboardNotice, 2000),
                primaryColor:cleanText(req.body.primaryColor, 50, '#0d4f8b') || '#0d4f8b',
                accentColor:cleanText(req.body.accentColor, 50, '#2ecc71') || '#2ecc71'
            };

            if (!values.associationName) {
                return res.status(400).json({
                    success:false,
                    message:'Association name is required'
                });
            }

            const output = await db.transaction(async tx => {
                const beforeResult = await tx.query(`
                    SELECT *
                    FROM "AssociationSettings"
                    WHERE "OrganizationId" = $1
                    LIMIT 1
                `, [req.organizationId]);

                await tx.query(`
                    INSERT INTO "AssociationSettings"
                    (
                        "OrganizationId",
                        "AssociationName",
                        "Slogan",
                        "Address",
                        "Phone",
                        "Email",
                        "Website",
                        "LogoPath",
                        "DashboardTitle",
                        "DashboardMessage",
                        "DashboardNotice",
                        "PrimaryColor",
                        "AccentColor",
                        "CreatedAt",
                        "UpdatedAt"
                    )
                    VALUES
                    (
                        $1, $2, $3, $4, $5, $6, $7,
                        $8, $9, $10, $11, $12, $13,
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                    )
                    ON CONFLICT ("OrganizationId")
                    DO UPDATE SET
                        "AssociationName" = EXCLUDED."AssociationName",
                        "Slogan" = EXCLUDED."Slogan",
                        "Address" = EXCLUDED."Address",
                        "Phone" = EXCLUDED."Phone",
                        "Email" = EXCLUDED."Email",
                        "Website" = EXCLUDED."Website",
                        "LogoPath" = CASE
                            WHEN EXCLUDED."LogoPath" = ''
                            THEN "AssociationSettings"."LogoPath"
                            ELSE EXCLUDED."LogoPath"
                        END,
                        "DashboardTitle" = EXCLUDED."DashboardTitle",
                        "DashboardMessage" = EXCLUDED."DashboardMessage",
                        "DashboardNotice" = EXCLUDED."DashboardNotice",
                        "PrimaryColor" = EXCLUDED."PrimaryColor",
                        "AccentColor" = EXCLUDED."AccentColor",
                        "UpdatedAt" = CURRENT_TIMESTAMP
                `, [
                    req.organizationId,
                    values.associationName,
                    values.slogan,
                    values.address,
                    values.phone,
                    values.email,
                    values.website,
                    values.logoPath,
                    values.dashboardTitle,
                    values.dashboardMessage,
                    values.dashboardNotice,
                    values.primaryColor,
                    values.accentColor
                ]);

                await tx.query(`
                    UPDATE "Organizations"
                    SET
                        "Name" = $1,
                        "Phone" = $2,
                        "Email" = $3,
                        "Address" = $4,
                        "UpdatedAt" = CURRENT_TIMESTAMP
                    WHERE "Id" = $5
                `, [
                    values.associationName,
                    values.phone,
                    values.email,
                    values.address,
                    req.organizationId
                ]);

                return {
                    before:beforeResult.rows[0] || null
                };
            });

            await writeAuditEvent({
                req,
                organizationId:req.organizationId,
                action:output.before ? 'UPDATE' : 'CREATE',
                entityType:'ASSOCIATION_SETTINGS',
                entityId:req.organizationId,
                summary:'Association settings saved',
                beforeData:output.before,
                afterData:values
            });

            res.json({
                success:true,
                message:'Settings saved successfully'
            });
        } catch (err) {
            console.error(err);

            res.status(500).json({
                success:false,
                message:'Unable to save settings'
            });
        }
    }
);

router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            success:false,
            message:err.code === 'LIMIT_FILE_SIZE'
                ? 'Logo must not exceed 2 MB'
                : err.message
        });
    }

    if (err) {
        return res.status(400).json({
            success:false,
            message:err.message
        });
    }

    next();
});

module.exports = router;

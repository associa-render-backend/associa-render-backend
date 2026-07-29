-- Associa PostgreSQL foundation seed data
-- Date: 28 July 2026

WITH full_access AS (
    INSERT INTO "SubscriptionPlans"
    (
        "PlanCode",
        "PlanName",
        "Description",
        "MonthlyPrice",
        "AnnualPrice",
        "MaxMembers",
        "MaxUsers",
        "MaxOrganizations",
        "IsActive",
        "CreatedAt",
        "UpdatedAt"
    )
    VALUES
    (
        'FULL_ACCESS',
        'Full Access',
        'Default full-access plan for Associa cloud migration and early pilot accounts.',
        0,
        0,
        NULL,
        NULL,
        NULL,
        TRUE,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    )
    ON CONFLICT ("PlanCode") DO UPDATE SET
        "PlanName" = EXCLUDED."PlanName",
        "Description" = EXCLUDED."Description",
        "IsActive" = TRUE,
        "UpdatedAt" = CURRENT_TIMESTAMP
    RETURNING "Id"
), features("FeatureCode", "FeatureName") AS (
    VALUES
        ('MEMBERS', 'Members'),
        ('CAMPAIGNS', 'Financial Obligations'),
        ('PAYMENTS', 'Payments'),
        ('MEMBER_STATEMENTS', 'Member Statements'),
        ('TREASURER_REPORTS', 'Treasurer Reports'),
        ('USER_MANAGEMENT', 'User Management'),
        ('AUDIT_TRAIL', 'Audit Trail'),
        ('BACKUP_RESTORE', 'Backup and Restore'),
        ('BULK_UPLOAD', 'Bulk Upload'),
        ('MULTI_ORG', 'Multi-Organization'),
        ('CASHBOOK', 'Cashbook'),
        ('SETTINGS', 'Settings'),
        ('DASHBOARD', 'Dashboard'),
        ('MEMBER_OBLIGATIONS', 'Member Obligations'),
        ('BANK_RECONCILIATION', 'Bank Reconciliation')
)
INSERT INTO "FeatureEntitlements"
(
    "PlanId",
    "FeatureCode",
    "FeatureName",
    "IsEnabled",
    "CreatedAt",
    "UpdatedAt"
)
SELECT
    full_access."Id",
    features."FeatureCode",
    features."FeatureName",
    TRUE,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM full_access
CROSS JOIN features
ON CONFLICT ("PlanId", "FeatureCode") DO UPDATE SET
    "FeatureName" = EXCLUDED."FeatureName",
    "IsEnabled" = TRUE,
    "UpdatedAt" = CURRENT_TIMESTAMP;

-- Associa Neon verification query
-- Run this after schema.sql and seed.sql if you prefer using Neon SQL Editor manually.

WITH required_tables(table_name) AS (
    VALUES
        ('Organizations'),
        ('AdminUsers'),
        ('AssociationSettings'),
        ('Members'),
        ('Campaigns'),
        ('Obligations'),
        ('Payments'),
        ('PaymentAllocations'),
        ('FinancialTransactions'),
        ('AuditEvents'),
        ('SubscriptionPlans'),
        ('OrganizationSubscriptions'),
        ('FeatureEntitlements'),
        ('LicenseKeys'),
        ('BankReconciliations'),
        ('BankReconciliationItems'),
        ('ExportRecords')
), existing_tables AS (
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
)
SELECT
    required_tables.table_name,
    CASE
        WHEN existing_tables.table_name IS NULL THEN 'MISSING'
        ELSE 'OK'
    END AS status
FROM required_tables
LEFT JOIN existing_tables
    ON existing_tables.table_name = required_tables.table_name
ORDER BY required_tables.table_name;

SELECT
    'SubscriptionPlans' AS item,
    COUNT(*) AS count
FROM "SubscriptionPlans"
UNION ALL
SELECT
    'FeatureEntitlements' AS item,
    COUNT(*) AS count
FROM "FeatureEntitlements";

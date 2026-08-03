/*
    Associa automated subscription purchase support.

    Adds a provider-backed purchase ledger so online payments can activate
    subscriptions without manual license-key generation.
*/

SET NOCOUNT ON;

IF OBJECT_ID('dbo.SubscriptionPurchases', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SubscriptionPurchases
    (
        Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_SubscriptionPurchases PRIMARY KEY,
        OrganizationId UNIQUEIDENTIFIER NOT NULL,
        PlanId UNIQUEIDENTIFIER NOT NULL,
        Provider NVARCHAR(50) NOT NULL,
        ProviderReference NVARCHAR(120) NOT NULL,
        ProviderAuthorizationUrl NVARCHAR(1000) NULL,
        Amount DECIMAL(18, 2) NOT NULL,
        Currency NVARCHAR(10) NOT NULL CONSTRAINT DF_SubscriptionPurchases_Currency DEFAULT ('NGN'),
        BillingCycle NVARCHAR(20) NOT NULL CONSTRAINT DF_SubscriptionPurchases_BillingCycle DEFAULT ('ANNUAL'),
        Status NVARCHAR(30) NOT NULL CONSTRAINT DF_SubscriptionPurchases_Status DEFAULT ('PENDING'),
        PaidAt DATETIME2 NULL,
        VerifiedAt DATETIME2 NULL,
        RawProviderPayload NVARCHAR(MAX) NULL,
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_SubscriptionPurchases_CreatedAt DEFAULT (SYSUTCDATETIME()),
        UpdatedAt DATETIME2 NULL
    );
END;

IF COL_LENGTH('dbo.SubscriptionPurchases', 'ProviderAuthorizationUrl') IS NULL
    ALTER TABLE dbo.SubscriptionPurchases ADD ProviderAuthorizationUrl NVARCHAR(1000) NULL;

IF COL_LENGTH('dbo.SubscriptionPurchases', 'BillingCycle') IS NULL
    ALTER TABLE dbo.SubscriptionPurchases ADD BillingCycle NVARCHAR(20) NOT NULL CONSTRAINT DF_SubscriptionPurchases_BillingCycle_Added DEFAULT ('ANNUAL');

IF COL_LENGTH('dbo.SubscriptionPurchases', 'RawProviderPayload') IS NULL
    ALTER TABLE dbo.SubscriptionPurchases ADD RawProviderPayload NVARCHAR(MAX) NULL;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'UX_SubscriptionPurchases_ProviderReference'
      AND object_id = OBJECT_ID('dbo.SubscriptionPurchases')
)
BEGIN
    CREATE UNIQUE INDEX UX_SubscriptionPurchases_ProviderReference
    ON dbo.SubscriptionPurchases (Provider, ProviderReference);
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'IX_SubscriptionPurchases_OrganizationCreatedAt'
      AND object_id = OBJECT_ID('dbo.SubscriptionPurchases')
)
BEGIN
    CREATE INDEX IX_SubscriptionPurchases_OrganizationCreatedAt
    ON dbo.SubscriptionPurchases (OrganizationId, CreatedAt DESC);
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.foreign_keys
    WHERE name = 'FK_SubscriptionPurchases_Organizations'
)
BEGIN
    ALTER TABLE dbo.SubscriptionPurchases WITH NOCHECK
    ADD CONSTRAINT FK_SubscriptionPurchases_Organizations
    FOREIGN KEY (OrganizationId) REFERENCES dbo.Organizations(Id);
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.foreign_keys
    WHERE name = 'FK_SubscriptionPurchases_SubscriptionPlans'
)
BEGIN
    ALTER TABLE dbo.SubscriptionPurchases WITH NOCHECK
    ADD CONSTRAINT FK_SubscriptionPurchases_SubscriptionPlans
    FOREIGN KEY (PlanId) REFERENCES dbo.SubscriptionPlans(Id);
END;

PRINT 'Subscription purchase ledger setup completed successfully.';

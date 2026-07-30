-- Associa PostgreSQL foundation schema
-- Date: 28 July 2026
-- Target: Neon Postgres / Koyeb backend
-- Status: Foundation draft. Review before applying to production.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "Organizations" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "Name" VARCHAR(255) NOT NULL,
    "ShortName" VARCHAR(100),
    "OrganizationType" VARCHAR(100),
    "Phone" VARCHAR(100),
    "Email" VARCHAR(255),
    "Address" TEXT,
    "Status" VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    "IsArchived" BOOLEAN NOT NULL DEFAULT FALSE,
    "ArchivedAt" TIMESTAMPTZ,
    "ArchivedBy" VARCHAR(255),
    "ArchiveReason" TEXT,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "AdminUsers" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID REFERENCES "Organizations"("Id"),
    "FullName" VARCHAR(200) NOT NULL,
    "Email" VARCHAR(255) NOT NULL UNIQUE,
    "PasswordHash" VARCHAR(255) NOT NULL,
    "Role" VARCHAR(50) NOT NULL,
    "Status" VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "AssociationSettings" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID NOT NULL UNIQUE REFERENCES "Organizations"("Id"),
    "AssociationName" VARCHAR(255) NOT NULL,
    "Slogan" VARCHAR(500),
    "Address" TEXT,
    "Phone" VARCHAR(100),
    "Email" VARCHAR(255),
    "Website" VARCHAR(500),
    "LogoPath" TEXT,
    "LogoData" TEXT,
    "LogoMimeType" VARCHAR(100),
    "DashboardTitle" VARCHAR(255),
    "DashboardMessage" TEXT,
    "DashboardNotice" TEXT,
    "PrimaryColor" VARCHAR(50) DEFAULT '#0d4f8b',
    "AccentColor" VARCHAR(50) DEFAULT '#2ecc71',
    "OpeningBalance" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "OpeningBalanceDate" DATE,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "Members" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID NOT NULL REFERENCES "Organizations"("Id"),
    "MemberNumber" VARCHAR(100) NOT NULL,
    "MemberNo" VARCHAR(100),
    "FullName" VARCHAR(200) NOT NULL,
    "Surname" VARCHAR(200),
    "FirstName" VARCHAR(200),
    "OtherName" VARCHAR(200),
    "Phone" VARCHAR(100),
    "Email" VARCHAR(255),
    "Address" TEXT,
    "Village" VARCHAR(200),
    "Branch" VARCHAR(200),
    "Zone" VARCHAR(200),
    "CreditBalance" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "Gender" VARCHAR(50),
    "Occupation" VARCHAR(150),
    "Status" VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    "TotalDue" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "TotalPaid" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "Balance" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ,
    UNIQUE ("OrganizationId", "MemberNumber")
);

CREATE TABLE IF NOT EXISTS "Campaigns" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID NOT NULL REFERENCES "Organizations"("Id"),
    "CampaignCode" VARCHAR(100),
    "CampaignName" VARCHAR(255) NOT NULL,
    "ContributionType" VARCHAR(100),
    "TargetScope" VARCHAR(100) DEFAULT 'ALL_MEMBERS',
    "StartDate" DATE,
    "Description" TEXT,
    "Amount" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "DueDate" DATE,
    "Status" VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "Obligations" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID NOT NULL REFERENCES "Organizations"("Id"),
    "MemberId" UUID NOT NULL REFERENCES "Members"("Id"),
    "CampaignId" UUID REFERENCES "Campaigns"("Id"),
    "AssignmentType" VARCHAR(50) NOT NULL DEFAULT 'INDIVIDUAL',
    "ObligationType" VARCHAR(100),
    "Description" VARCHAR(500) NOT NULL,
    "AmountDue" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "AmountPaid" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "WaivedAmount" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "CreditBalance" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "Balance" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "DueDate" DATE,
    "Status" VARCHAR(30) NOT NULL DEFAULT 'UNPAID',
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "Payments" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID NOT NULL REFERENCES "Organizations"("Id"),
    "MemberId" UUID NOT NULL REFERENCES "Members"("Id"),
    "Amount" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "AmountPaid" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "PaymentReference" VARCHAR(100),
    "Reference" VARCHAR(500),
    "Remarks" TEXT,
    "PaymentDate" DATE NOT NULL DEFAULT CURRENT_DATE,
    "PaymentMethod" VARCHAR(50),
    "Description" TEXT,
    "Status" VARCHAR(30) NOT NULL DEFAULT 'POSTED',
    "CreatedBy" VARCHAR(255),
    "ReversedAt" TIMESTAMPTZ,
    "ReversedBy" VARCHAR(255),
    "ReversalReason" TEXT,
    "ReversalTransactionId" UUID,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "PaymentAllocations" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID NOT NULL REFERENCES "Organizations"("Id"),
    "PaymentId" UUID NOT NULL REFERENCES "Payments"("Id"),
    "ObligationId" UUID NOT NULL REFERENCES "Obligations"("Id"),
    "Amount" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "AmountAllocated" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "AllocatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "AllocatedBy" VARCHAR(255),
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "FinancialTransactions" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID NOT NULL REFERENCES "Organizations"("Id"),
    "TransactionDate" DATE NOT NULL,
    "Reference" VARCHAR(255),
    "Description" TEXT NOT NULL,
    "TransactionType" VARCHAR(30) NOT NULL,
    "Amount" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "PaymentMethod" VARCHAR(50),
    "Category" VARCHAR(255),
    "Source" VARCHAR(100) NOT NULL DEFAULT 'MANUAL',
    "SourceId" UUID,
    "Status" VARCHAR(30) NOT NULL DEFAULT 'POSTED',
    "CreatedBy" VARCHAR(255),
    "ReversalOfId" UUID,
    "ReversedByTransactionId" UUID,
    "ReversedAt" TIMESTAMPTZ,
    "ReversedBy" VARCHAR(255),
    "ReversalReason" TEXT,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "AuditEvents" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID NOT NULL REFERENCES "Organizations"("Id"),
    "ActorUserId" UUID,
    "ActorName" VARCHAR(255),
    "ActorEmail" VARCHAR(255),
    "ActorRole" VARCHAR(50),
    "Action" VARCHAR(100) NOT NULL,
    "EntityType" VARCHAR(100) NOT NULL,
    "EntityId" VARCHAR(100),
    "Summary" TEXT NOT NULL,
    "BeforeData" JSONB,
    "AfterData" JSONB,
    "Metadata" JSONB,
    "IpAddress" VARCHAR(100),
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "SubscriptionPlans" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "PlanCode" VARCHAR(50) NOT NULL UNIQUE,
    "PlanName" VARCHAR(150) NOT NULL,
    "Description" TEXT,
    "MonthlyPrice" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "AnnualPrice" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "MaxMembers" INTEGER,
    "MaxUsers" INTEGER,
    "MaxOrganizations" INTEGER,
    "IsActive" BOOLEAN NOT NULL DEFAULT TRUE,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "OrganizationSubscriptions" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID NOT NULL REFERENCES "Organizations"("Id"),
    "PlanId" UUID NOT NULL REFERENCES "SubscriptionPlans"("Id"),
    "LicenseKeyId" UUID,
    "Status" VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    "StartDate" DATE NOT NULL DEFAULT CURRENT_DATE,
    "EndDate" DATE,
    "TrialEndsAt" TIMESTAMPTZ,
    "GraceEndsAt" TIMESTAMPTZ,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "FeatureEntitlements" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "PlanId" UUID NOT NULL REFERENCES "SubscriptionPlans"("Id"),
    "FeatureCode" VARCHAR(100) NOT NULL,
    "FeatureName" VARCHAR(150),
    "IsEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ,
    UNIQUE ("PlanId", "FeatureCode")
);

CREATE TABLE IF NOT EXISTS "LicenseKeys" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "LicenseKey" VARCHAR(100) NOT NULL UNIQUE,
    "PlanId" UUID NOT NULL REFERENCES "SubscriptionPlans"("Id"),
    "OrganizationId" UUID REFERENCES "Organizations"("Id"),
    "Status" VARCHAR(30) NOT NULL DEFAULT 'UNUSED',
    "IssuedAt" TIMESTAMPTZ,
    "ExpiresAt" TIMESTAMPTZ,
    "ActivatedAt" TIMESTAMPTZ,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'FK_OrganizationSubscriptions_LicenseKeys'
    ) THEN
        ALTER TABLE "OrganizationSubscriptions"
            ADD CONSTRAINT "FK_OrganizationSubscriptions_LicenseKeys"
            FOREIGN KEY ("LicenseKeyId") REFERENCES "LicenseKeys"("Id")
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "BankReconciliations" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID NOT NULL REFERENCES "Organizations"("Id"),
    "PeriodStart" DATE NOT NULL,
    "PeriodEnd" DATE NOT NULL,
    "BankStatementBalance" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "BookBalance" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "OutstandingDeposits" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "UnpresentedPayments" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "AdjustedBankBalance" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "Difference" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "Status" VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    "Notes" TEXT,
    "PreparedBy" VARCHAR(255),
    "FinalizedBy" VARCHAR(255),
    "FinalizedAt" TIMESTAMPTZ,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "BankReconciliationItems" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "ReconciliationId" UUID NOT NULL REFERENCES "BankReconciliations"("Id") ON DELETE CASCADE,
    "TransactionId" UUID NOT NULL REFERENCES "FinancialTransactions"("Id"),
    "ReconciliationStatus" VARCHAR(30) NOT NULL,
    "ClearedDate" DATE,
    "Notes" TEXT,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ,
    UNIQUE ("ReconciliationId", "TransactionId")
);

CREATE TABLE IF NOT EXISTS "ExportRecords" (
    "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "OrganizationId" UUID REFERENCES "Organizations"("Id"),
    "ExportType" VARCHAR(50) NOT NULL DEFAULT 'DATA_EXPORT',
    "Status" VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    "FileName" TEXT,
    "FileSizeBytes" BIGINT,
    "CreatedBy" VARCHAR(255),
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "CompletedAt" TIMESTAMPTZ,
    "Notes" TEXT
);

CREATE INDEX IF NOT EXISTS "IX_AdminUsers_Organization" ON "AdminUsers" ("OrganizationId", "Status");
CREATE INDEX IF NOT EXISTS "IX_Members_Organization_Status" ON "Members" ("OrganizationId", "Status");
CREATE INDEX IF NOT EXISTS "IX_Campaigns_Organization_Status" ON "Campaigns" ("OrganizationId", "Status");
CREATE INDEX IF NOT EXISTS "IX_Obligations_Organization_Member" ON "Obligations" ("OrganizationId", "MemberId", "Status");
CREATE INDEX IF NOT EXISTS "IX_Payments_Organization_Date" ON "Payments" ("OrganizationId", "PaymentDate" DESC);
CREATE INDEX IF NOT EXISTS "IX_FinancialTransactions_Organization_Date" ON "FinancialTransactions" ("OrganizationId", "TransactionDate", "CreatedAt");
CREATE INDEX IF NOT EXISTS "IX_AuditEvents_Organization_CreatedAt" ON "AuditEvents" ("OrganizationId", "CreatedAt" DESC);
CREATE INDEX IF NOT EXISTS "IX_BankReconciliations_Organization_Period" ON "BankReconciliations" ("OrganizationId", "PeriodEnd" DESC, "PeriodStart" DESC);
CREATE INDEX IF NOT EXISTS "IX_ExportRecords_Status_CreatedAt" ON "ExportRecords" ("Status", "CreatedAt" DESC);






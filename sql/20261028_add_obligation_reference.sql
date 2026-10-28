ALTER TABLE "Obligations"
ADD COLUMN IF NOT EXISTS "Reference" VARCHAR(500);

CREATE UNIQUE INDEX IF NOT EXISTS "UX_Obligations_Organization_Member_Reference"
    ON "Obligations" ("OrganizationId", "MemberId", "Reference")
    WHERE "Reference" IS NOT NULL AND "Reference" <> '';

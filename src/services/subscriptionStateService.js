const TRIAL_PLAN_CODE = 'TRIAL';

async function ensureTrialPlan(tx) {
    const existing = await tx.query(`
        SELECT "Id", "PlanCode", "PlanName"
        FROM "SubscriptionPlans"
        WHERE UPPER("PlanCode") = $1
        LIMIT 1
    `, [TRIAL_PLAN_CODE]);

    if (existing.rows[0]) return existing.rows[0];

    const created = await tx.query(`
        INSERT INTO "SubscriptionPlans"
        (
            "PlanCode", "PlanName", "Description", "MonthlyPrice",
            "AnnualPrice", "IsActive", "CreatedAt", "UpdatedAt"
        )
        VALUES
        (
            $1, 'Trial', 'Baseline access while choosing a paid subscription.',
            0, 0, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING "Id", "PlanCode", "PlanName"
    `, [TRIAL_PLAN_CODE]);

    return created.rows[0];
}

function selectSubscriptionSql() {
    return `
        SELECT
            s."Id", s."OrganizationId", s."PlanId", s."Status",
            s."StartDate", s."EndDate", s."TrialEndsAt", s."GraceEndsAt",
            s."CreatedAt", p."PlanCode", p."PlanName", p."Description",
            p."MonthlyPrice", p."AnnualPrice", p."MaxMembers", p."MaxUsers",
            p."MaxOrganizations"
        FROM "OrganizationSubscriptions" s
        INNER JOIN "SubscriptionPlans" p ON p."Id" = s."PlanId"
        WHERE s."OrganizationId" = $1
          AND (
                (s."Status" = 'ACTIVE'
                    AND (s."EndDate" IS NULL OR s."EndDate" >= CURRENT_DATE))
             OR (s."Status" = 'GRACE'
                    AND (s."GraceEndsAt" IS NULL OR s."GraceEndsAt" >= CURRENT_TIMESTAMP))
             OR (s."Status" = 'TRIAL'
                    AND (s."TrialEndsAt" IS NULL OR s."TrialEndsAt" >= CURRENT_TIMESTAMP))
          )
        ORDER BY
            CASE s."Status"
                WHEN 'ACTIVE' THEN 0
                WHEN 'GRACE' THEN 1
                WHEN 'TRIAL' THEN 2
                ELSE 3
            END,
            s."EndDate" DESC NULLS LAST,
            s."CreatedAt" DESC
        LIMIT 1
    `;
}

async function resolveSubscriptionState(db, organizationId) {
    return db.transaction(async tx => {
        await tx.query(`
            SELECT "Id"
            FROM "Organizations"
            WHERE "Id" = $1
            FOR UPDATE
        `, [organizationId]);

        await tx.query(`
            UPDATE "OrganizationSubscriptions"
            SET "Status" = 'EXPIRED', "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "OrganizationId" = $1
              AND (
                    ("Status" = 'ACTIVE'
                        AND "EndDate" IS NOT NULL
                        AND "EndDate" < CURRENT_DATE)
                 OR ("Status" = 'GRACE'
                        AND "GraceEndsAt" IS NOT NULL
                        AND "GraceEndsAt" < CURRENT_TIMESTAMP)
                 OR ("Status" = 'TRIAL'
                        AND "TrialEndsAt" IS NOT NULL
                        AND "TrialEndsAt" < CURRENT_TIMESTAMP)
              )
        `, [organizationId]);

        const current = await tx.query(selectSubscriptionSql(), [organizationId]);
        if (current.rows[0]) return current.rows[0];

        const trialPlan = await ensureTrialPlan(tx);
        await tx.query(`
            INSERT INTO "OrganizationSubscriptions"
            (
                "OrganizationId", "PlanId", "Status", "StartDate",
                "EndDate", "TrialEndsAt", "CreatedAt", "UpdatedAt"
            )
            VALUES
            (
                $1, $2, 'TRIAL', CURRENT_DATE,
                NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
        `, [organizationId, trialPlan.Id]);

        const trial = await tx.query(selectSubscriptionSql(), [organizationId]);
        if (!trial.rows[0]) {
            throw new Error('Unable to establish trial subscription access');
        }

        return trial.rows[0];
    });
}

function isPaidSubscription(subscription) {
    return ['ACTIVE', 'GRACE'].includes(
        String(subscription?.Status || '').toUpperCase()
    );
}

module.exports = { resolveSubscriptionState, isPaidSubscription };

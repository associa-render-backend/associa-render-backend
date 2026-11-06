function postedAllocationTotalSql(obligationAlias = 'o') {
    return `COALESCE((
        SELECT SUM(COALESCE(pa."Amount", pa."AmountAllocated", 0))
        FROM "PaymentAllocations" pa
        INNER JOIN "Payments" p
            ON p."Id" = pa."PaymentId"
            AND p."OrganizationId" = pa."OrganizationId"
        WHERE pa."OrganizationId" = ${obligationAlias}."OrganizationId"
          AND pa."ObligationId" = ${obligationAlias}."Id"
          AND COALESCE(p."Status", 'POSTED') = 'POSTED'
    ), 0)`;
}

function hasPostedAllocationSql(obligationAlias = 'o') {
    return `EXISTS(
        SELECT 1
        FROM "PaymentAllocations" pa
        INNER JOIN "Payments" p
            ON p."Id" = pa."PaymentId"
            AND p."OrganizationId" = pa."OrganizationId"
        WHERE pa."OrganizationId" = ${obligationAlias}."OrganizationId"
          AND pa."ObligationId" = ${obligationAlias}."Id"
          AND COALESCE(p."Status", 'POSTED') = 'POSTED'
    )`;
}

function liveAmountPaidSql(obligationAlias = 'o') {
    return `CASE
        WHEN ${hasPostedAllocationSql(obligationAlias)}
            THEN ${postedAllocationTotalSql(obligationAlias)}
        ELSE COALESCE(${obligationAlias}."AmountPaid", 0)
    END`;
}

function liveBalanceSql(obligationAlias = 'o') {
    return `GREATEST(
        0,
        COALESCE(${obligationAlias}."AmountDue", 0)
        - COALESCE(${obligationAlias}."WaivedAmount", 0)
        - ${liveAmountPaidSql(obligationAlias)}
    )`;
}

module.exports = {
    postedAllocationTotalSql,
    hasPostedAllocationSql,
    liveAmountPaidSql,
    liveBalanceSql
};
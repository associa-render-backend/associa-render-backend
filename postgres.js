const ROLE_ORDER = [
    'SUPER_ADMIN',
    'ADMIN',
    'TREASURER',
    'SECRETARY',
    'DATA_ENTRY',
    'AUDITOR',
    'VIEWER'
];

const ROLE_LABELS = {
    SUPER_ADMIN: 'System Administrator',
    ADMIN: 'Organization Administrator',
    TREASURER: 'Treasurer',
    SECRETARY: 'Secretary',
    DATA_ENTRY: 'Data Entry Officer',
    AUDITOR: 'Auditor',
    VIEWER: 'Viewer'
};

const ROLE_DESCRIPTIONS = {
    SUPER_ADMIN: 'Full system control across organizations, subscriptions, backups and security.',
    ADMIN: 'Manages organization setup, users and operational records within one organization.',
    TREASURER: 'Manages financial records, payments, cashbook, reports and reconciliation.',
    SECRETARY: 'Can view and support member/meeting administration without financial control.',
    DATA_ENTRY: 'Can enter operational and financial data but cannot approve or administer users.',
    AUDITOR: 'Read-only access to financial reports, audit trail and reconciliation records.',
    VIEWER: 'Read-only dashboard and basic record visibility.'
};

const ROLE_PERMISSIONS = {
    SUPER_ADMIN: [
        'dashboard.view',
        'members.view',
        'members.manage',
        'obligations.view',
        'obligations.manage',
        'payments.view',
        'payments.manage',
        'cashbook.view',
        'cashbook.manage',
        'statements.view',
        'treasurerReports.view',
        'bankReconciliation.view',
        'bankReconciliation.manage',
        'auditTrail.view',
        'backupRestore.manage',
        'settings.manage',
        'users.view',
        'users.manage',
        'subscriptions.manage',
        'bulkUpload.manage'
    ],
    ADMIN: [
        'dashboard.view',
        'members.view',
        'members.manage',
        'obligations.view',
        'obligations.manage',
        'payments.view',
        'payments.manage',
        'cashbook.view',
        'cashbook.manage',
        'statements.view',
        'treasurerReports.view',
        'bankReconciliation.view',
        'bankReconciliation.manage',
        'auditTrail.view',
        'settings.manage',
        'users.view',
        'users.manage',
        'bulkUpload.manage'
    ],
    TREASURER: [
        'dashboard.view',
        'members.view',
        'obligations.view',
        'payments.view',
        'payments.manage',
        'cashbook.view',
        'cashbook.manage',
        'statements.view',
        'treasurerReports.view',
        'bankReconciliation.view',
        'bankReconciliation.manage',
        'auditTrail.view',
        'bulkUpload.manage'
    ],
    SECRETARY: [
        'dashboard.view',
        'members.view',
        'members.manage',
        'obligations.view',
        'statements.view'
    ],
    DATA_ENTRY: [
        'dashboard.view',
        'members.view',
        'members.manage',
        'obligations.view',
        'payments.view',
        'payments.manage',
        'cashbook.view',
        'cashbook.manage',
        'bulkUpload.manage'
    ],
    AUDITOR: [
        'dashboard.view',
        'members.view',
        'obligations.view',
        'payments.view',
        'cashbook.view',
        'statements.view',
        'treasurerReports.view',
        'bankReconciliation.view',
        'auditTrail.view'
    ],
    VIEWER: [
        'dashboard.view',
        'members.view',
        'obligations.view',
        'payments.view',
        'cashbook.view',
        'statements.view',
        'treasurerReports.view'
    ]
};

function normalizeRole(value) {
    return String(value || '')
        .trim()
        .toUpperCase();
}

function isKnownRole(role) {
    return ROLE_ORDER.includes(
        normalizeRole(role)
    );
}

function getRolePermissions(role) {
    const normalized =
        normalizeRole(role);

    return ROLE_PERMISSIONS[normalized] || [];
}

function hasPermission(role, permission) {
    return getRolePermissions(role)
        .includes(permission);
}

function canAssignRole(actorRole, targetRole) {
    const actor =
        normalizeRole(actorRole);

    const target =
        normalizeRole(targetRole);

    if (!isKnownRole(target)) {
        return false;
    }

    if (actor === 'SUPER_ADMIN') {
        return true;
    }

    if (actor === 'ADMIN') {
        return ![
            'SUPER_ADMIN',
            'ADMIN'
        ].includes(target);
    }

    return false;
}

function getAssignableRoles(actorRole) {
    return ROLE_ORDER.filter(
        role => canAssignRole(
            actorRole,
            role
        )
    );
}

module.exports = {
    ROLE_ORDER,
    ROLE_LABELS,
    ROLE_DESCRIPTIONS,
    ROLE_PERMISSIONS,
    normalizeRole,
    isKnownRole,
    getRolePermissions,
    hasPermission,
    canAssignRole,
    getAssignableRoles
};

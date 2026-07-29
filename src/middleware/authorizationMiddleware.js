const {
    normalizeRole,
    hasPermission
} = require('../config/rolePermissions');

function authorizeRoles(...allowedRoles) {
    const allowed =
        new Set(
            allowedRoles.map(
                normalizeRole
            )
        );

    return (req, res, next) => {
        const role =
            normalizeRole(
                req.user?.role
            );

        if (!allowed.has(role)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to perform this action'
            });
        }

        next();
    };
}

function requirePermission(permission) {
    return (req, res, next) => {
        const role =
            normalizeRole(
                req.user?.role
            );

        if (!hasPermission(role, permission)) {
            return res.status(403).json({
                success: false,
                message: `Your role does not include ${permission.replace('.', ' / ')} permission`
            });
        }

        next();
    };
}

function requireOrganization(req, res, next) {
    const role =
        normalizeRole(
            req.user?.role
        );

    const selectedOrganizationId =
        req.headers['x-organization-id'];

    const organizationId =
        role === 'SUPER_ADMIN' &&
        selectedOrganizationId
            ? selectedOrganizationId
            : req.user?.organizationId;

    if (
        organizationId &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(String(organizationId))
    ) {
        return res.status(400).json({
            success:false,
            message:'Invalid organization context'
        });
    }

    if (!organizationId) {
        return res.status(403).json({
            success: false,
            message: 'Your account is not assigned to an organization'
        });
    }

    req.organizationId =
        organizationId;

    req.selectedOrganizationId =
        organizationId;

    next();
}

module.exports = {
    authorizeRoles,
    requirePermission,
    requireOrganization,
    normalizeRole
};

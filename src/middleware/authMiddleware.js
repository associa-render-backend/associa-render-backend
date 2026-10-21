const jwt = require('jsonwebtoken');
const {
    validateAndTouchSession
} = require('../services/authSessionService');

const authMiddleware = async (req, res, next) => {

try {

    const authHeader =
        req.headers.authorization;

    if (
        !authHeader ||
        !authHeader.startsWith('Bearer ')
    ) {

        return res.status(401).json({
            success: false,
            message:
                'Authentication required'
        });
    }

    const token =
        authHeader.slice(7).trim();

    const decoded =
        jwt.verify(
            token,
            process.env.JWT_SECRET
        );

    if (!decoded.sessionId) {
        return res.status(401).json({
            success:false,
            code:'SESSION_REPLACED',
            message:'Please sign in again to continue.'
        });
    }

    const sessionIsActive = await validateAndTouchSession(
        decoded.id,
        decoded.sessionId
    );

    if (!sessionIsActive) {
        return res.status(401).json({
            success:false,
            code:'SESSION_EXPIRED',
            message:'Your session has expired. Please sign in again.'
        });
    }

    req.user = decoded;

    next();

} catch (err) {

    return res.status(401).json({
        success: false,
        message:
            err.name === 'TokenExpiredError'
                ? 'Session expired'
                : 'Invalid token'
    });
}

};

module.exports = authMiddleware;



const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {

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

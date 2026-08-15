const crypto = require('crypto');
const https = require('https');

const PAYSTACK_HOST = 'api.paystack.co';

function getSecretKey() {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;

    if (!secretKey) {
        throw new Error('Paystack secret key is not configured on Render.');
    }

    return secretKey;
}

function requestPaystack(path, method, payload) {
    const body = payload ? JSON.stringify(payload) : null;

    const options = {
        hostname: PAYSTACK_HOST,
        path,
        method,
        headers: {
            Authorization: `Bearer ${getSecretKey()}`,
            'Content-Type': 'application/json'
        }
    };

    if (body) {
        options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    return new Promise((resolve, reject) => {
        const req = https.request(options, response => {
            let responseBody = '';

            response.on('data', chunk => {
                responseBody += chunk;
            });

            response.on('end', () => {
                try {
                    const parsed = JSON.parse(responseBody || '{}');

                    if (
                        response.statusCode < 200 ||
                        response.statusCode >= 300 ||
                        parsed.status === false
                    ) {
                        return reject(
                            new Error(parsed.message || 'Paystack request failed')
                        );
                    }

                    resolve(parsed);
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

function initializeTransaction(payload) {
    return requestPaystack('/transaction/initialize', 'POST', payload);
}

function verifyTransaction(reference) {
    return requestPaystack(
        `/transaction/verify/${encodeURIComponent(reference)}`,
        'GET'
    );
}

function verifyWebhookSignature(rawBody, signature) {
    if (!rawBody || !signature) {
        return false;
    }

    const expected = crypto
        .createHmac('sha512', getSecretKey())
        .update(rawBody)
        .digest('hex');

    return expected === signature;
}

module.exports = {
    initializeTransaction,
    verifyTransaction,
    verifyWebhookSignature
};

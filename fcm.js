const { GoogleAuth } = require("google-auth-library");
const axios = require('axios');
const db = require('./db');
const serviceAccount = require('./public/serviceAccountKey.json');

const SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"];

async function getAccessToken() {
    const auth = new GoogleAuth({
        credentials: serviceAccount,
        scopes: SCOPES,
    });

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    return accessToken.token;
}

function stringifyFcmData(data = {}) {
    const out = {};
    for (const [key, value] of Object.entries(data)) {
        if (value == null) {
            out[key] = '';
            continue;
        }
        if (typeof value === 'string') {
            out[key] = value;
            continue;
        }
        out[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return out;
}

function normalizeMessages(messageObject) {
    if (!messageObject) return [];
    if (Array.isArray(messageObject)) return messageObject.filter(Boolean);
    return [messageObject];
}

async function sendPushNotificationMessage(messageObject) {
    try {
        const messages = normalizeMessages(messageObject);
        if (messages.length === 0) {
            console.log('No tokens to send');
            return null;
        }

        const accessToken = await getAccessToken();
        const projectId = serviceAccount.project_id;
        const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

        let lastResponseData = null;
        let sent = 0;

        for (const element of messages) {
            let token = element.token;
            if (!token) continue;

            if (typeof token === 'string' && token.includes('%')) {
                try {
                    token = decodeURIComponent(token);
                } catch (e) {
                    console.error("Failed to decode token in sendPushNotificationMessage:", token);
                }
            }

            const message = {
                message: {
                    token: token,
                    data: stringifyFcmData(element.data || {}),
                },
            };

            if (element.notification) {
                message.message.notification = {
                    title: element.notification.title || '',
                    body: element.notification.body || '',
                };
            }

            try {
                const response = await axios.post(url, message, {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json",
                    },
                });

                console.log("FCM Sent Success:", token);
                lastResponseData = response.data;
                sent += 1;
            } catch (error) {
                const errorData = error.response?.data?.error;
                if (
                    errorData?.message === 'NotRegistered' ||
                    errorData?.status === 'INVALID_ARGUMENT' ||
                    errorData?.status === 'NOT_FOUND' ||
                    errorData?.status === 'UNREGISTERED'
                ) {
                    console.log(`Pruning invalid token: ${token}`);
                    try {
                        await db('fcmtoken').where({ token: element.token }).del();
                    } catch (dbErr) {
                        console.error('Failed pruning invalid token:', dbErr.message);
                    }
                }

                const networkCode = error.code || error.cause?.code;
                if (networkCode === 'EAI_AGAIN' || networkCode === 'ENOTFOUND' || networkCode === 'ETIMEDOUT') {
                    console.error(`FCM network error for token ${token}:`, networkCode, error.message);
                } else {
                    console.error(
                        `Error sending message to token ${token}:`,
                        error.response?.data || error.message
                    );
                }
            }
        }

        return { sent, data: lastResponseData };
    } catch (error) {
        console.error("Unexpected error in sendPushNotificationMessage:", error.message);
        // Soft-fail: do not crash chat/socket flows when FCM is down
        return { sent: 0, error: error.message };
    }
}

module.exports = {
    sendPushNotificationMessage,
};

const express = require('express');
const { sendPushNotificationMessage } = require('../fcm');

function createNotificationsRouter(io, db) {
    const router = express.Router();

    router.post('/user-notification', async (req, res) => {
        const { targetUserId, message, type, payload, from, to } = req.body || {};

        if (targetUserId === undefined || targetUserId === null || targetUserId === '') {
            return res.status(400).json({ status: false, message: 'targetUserId is required' });
        }

        const notification = {
            targetUserId,
            message: message || '',
            type: type || 'general',
            payload: payload || {},
            from: from || null,
            to: to || null,
            receivedAt: new Date().toISOString(),
        };

        try {
            io.emit(`user-notification-${targetUserId}`, notification);
        } catch (error) {
            console.error('user-notification emit failed:', error.message);
        }

        let fcmTokens = 0;
        try {
            const tokenRows = await db('fcmtoken').where('user_id', targetUserId).select('token');
            const tokenList = tokenRows.map((t) => t.token).filter(Boolean);

            if (tokenList.length > 0) {
                fcmTokens = tokenList.length;
                const title = payload && payload.title ? String(payload.title) : 'New notification';
                const body = notification.message || '';

                const messages = tokenList.map((token) => ({
                    token,
                    data: {
                        ACTION: String(notification.type),
                        title,
                        body,
                        ...Object.fromEntries(
                            Object.entries(notification.payload).map(([k, v]) => [
                                k,
                                v == null
                                    ? null
                                    : typeof v === 'object'
                                      ? JSON.stringify(v)
                                      : String(v),
                            ])
                        ),
                    },
                    notification: { title, body },
                }));

                await sendPushNotificationMessage(messages);
            }
        } catch (error) {
            console.error('user-notification fcm failed:', error.message);
        }

        return res.status(200).json({ status: true, delivered: true, fcm_tokens: fcmTokens });
    });

    return router;
}

module.exports = { createNotificationsRouter };

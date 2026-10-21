const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const serviceAccount = require('../public/serviceAccountKey.json');

// Initialize Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});


router.post('/send-notification', async (req, res) => {
    const { tokens, fromU, toU, ACTION, customData } = req.body;
    if (!Array.isArray(tokens) || tokens.some(token => typeof token !== 'string' || token.trim() === '')) {
        return res.status(400).json({ error: 'Tokens should be a valid array of non-empty strings' });
    }
    const messages = tokens.map(token => ({
        data: {
            fromU: String(fromU),
            toU: String(toU),
            ACTION: String(ACTION),
            customData: String(customData), // Stringify customData
        },
        token: token,
    }));

    try {
        const responses = await Promise.all(messages.map(message => admin.messaging().send(message)));
        console.log('FCM Responses:', responses);

        res.json({
            success: true,
            messageIds: responses,
        });
    } catch (error) {
        console.error('Error sending messages:', error);
        res.status(500).json({ error: 'Failed to send notifications' });
    }
});



module.exports = router;
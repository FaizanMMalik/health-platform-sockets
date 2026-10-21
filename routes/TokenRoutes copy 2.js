const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const serviceAccount = require('../public/serviceAccountKey.json');

// Initialize Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

router.post('/send-notification', async (req, res) => {
    console.log('Request Body:', req.body); // Log the entire request body

    const { tokens, fromU, toU, ACTION, customData } = req.body;

    // Check if tokens is an array and not empty
    if (!Array.isArray(tokens) || tokens.length === 0) {
        return res.status(400).json({ error: 'Tokens should be a non-empty array' });
    }

    console.log('Tokens:', tokens);

    // Prepare the messages
    const messages = tokens.map(token => ({
        data: {
            fromU: String(fromU),
            toU: String(toU),
            ACTION: String(ACTION),
            customData: JSON.stringify(customData), // Stringify customData
        },
        token: token,
    }));

    try {
        const response = await admin.messaging().sendAll(messages);
        console.log('FCM Response:', response);

        res.json({
            success: true,
            successCount: response.successCount,
            failureCount: response.failureCount,
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send notifications' });
    }
});

module.exports = router;
  
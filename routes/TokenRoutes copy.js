const express = require('express');
const router = express.Router();


const admin = require('firebase-admin');
const serviceAccount = require('../public/serviceAccountKey.json');

// Initialize Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});



// Define the endpoint to send notifications
router.post('/send-notification', (req, res) => {

    // const { tokens, patienr, doc_id, patient_id, customData, ACTION } = req.body;
    const tokens =[
        'fyUD2ZZ4cXqinjnFKSFtFd:APA91bHaKX3Cdri1LWeD7tzMzVuCWHDqbJpYHG12c0QdXJohyaK6pjun3L6jndTEvXJKoas_nIAob2AzPcrg_rpKWEdGFw-OyYsRXvp9zPvE7IxtZdDm1-NXhsjm2kPoRq9Kvkwla8rA'
    ]
    console.log(req.body);
    

    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
        return res.status(400).json({ error: 'No registration tokens provided' });
    }
  

    const message = {

        data: {
            ACTION: "TEST"
        },

        tokens: tokens,

    };

    admin.messaging().sendMulticast(message)
        .then((response) => {
            console.log(response);
            res.json({
                successCount: response.successCount,
                failureCount: response.failureCount,
                details: response.responses.map((resp, idx) => ({
                    token: tokens[idx],
                    success: resp.success ? true : false,
                })),
            });
        })
        .catch((error) => {
            console.error('Error sending message:', error);
            res.status(500).json({ error: 'Failed to send notification' });
        });
});

// Start the server
module.exports = router;

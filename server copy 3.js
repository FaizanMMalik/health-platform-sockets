require('dotenv').config();
const express = require('express');
const https = require('https');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors'); // Import CORS module
const app = express();
const db = require('./db'); // Path to your db.js file
const axios = require('axios');

// Load SSL certificate and key
const options = {
    key: fs.readFileSync('/etc/nginx/ssl/www_brightspace_health.key'),
    cert: fs.readFileSync('/etc/nginx/ssl/www_brightspace_health.crt'),
    ca: fs.readFileSync('/etc/nginx/ssl/www_brightspace_health.ca-bundle')
};

const server = https.createServer(options, app);

// Test database connection
db.raw('show tables')
    .then(() => {
        console.log('Database connected!');
    })
    .catch((err) => {
        console.error('Error connecting to database:', err);
    });

// Middleware
app.use(cors({
    origin: '*', // Allow requests from this origin
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true, // Allow credentials if necessary
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files
app.use('/public/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

db.raw('show tables')
    .then(() =>
    {
        console.log('Database connected!');
    })
    .catch((err) =>
    {
        console.error('Error connecting to database:', err);
    });

const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT'],
        allowedHeaders: ['Content-Type'],
        credentials: true,
    },
});
const roomsRouter = require('./routes/rooms');

// Body parser middleware

app.use(cors({
    origin: '*', // Allow requests from this origin
    methods: ['GET', 'POST', 'PUT'],
    allowedHeaders: ['Content-Type'],
    credentials: true
}));

app.use(bodyParser.json());

app.use('/public/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

app.use(bodyParser.urlencoded({ extended: true }));


const onlineUsers = new Set();




io.on('connection', (socket) => {
    socket.on('offer', (data) => {
        const { targetUserId, offerData, from, iceCandidates } = data;
        try {
            io.emit(`offer-${targetUserId}`, { "offerData": offerData, "from": from, "targetUserId": targetUserId, "iceCandidates": iceCandidates });
        } catch (e) {
            db('logs_sockets').insert({
                socket_name: `offer-${targetUserId}`,
                error: e.message, // Access the error message here
            });
        }
    });

    socket.on('make-offer', (data) => {
        const { targetUserId, from } = data;
        try {
            io.emit(`make-offer-${targetUserId}`, { "from": from, "targetUserId": targetUserId });
        } catch (e) {
            db('logs_sockets').insert({
                socket_name: `make-offer-${targetUserId}`,
                error: e,
            });
        }
    });;

    socket.on('offer-acknowledgment', (data) => {
        const { from, targetUserId, offerData } = data;
        try {
            io.emit(`offer-acknowledgment-${targetUserId}`, { "offer": offerData, "from": from, "targetUserId": targetUserId });
        } catch (e) {
            db('logs_sockets').insert({
                socket_name: `offer-acknowledgment-${targetUserId}`,
                error: e,
            });
        }

    });

    socket.on('answer', (data) => {
        const { targetUserId, answerData, from } = data;
        try {
            io.emit(`answer-${targetUserId}`, { "answerData": answerData, "from": from, "targetUserId": targetUserId });
        } catch (e) {
            db('logs_sockets').insert({
                socket_name: `answer-${targetUserId}`,
                error: e,
            });
        }
    });

    socket.on('ice-candidate', (data) => {
        const { from, targetUserId, iceCandidateData } = data;
        try {
            io.emit(`ice-candidate-${targetUserId}`, { iceCandidateData, from, targetUserId });
        } catch (e) {
            db('logs_sockets').insert({
                socket_name: `ice-candidate-${targetUserId}`,
                error: e,
            });
        }
    });
    socket.on('test', (data) => {
        console.log('====================================');
        console.log(data);
        console.log('====================================');
    });

    socket.on('message', async (data, ackCallback) => {
        try {
            const { from, to, message, messageType, attachment } = data;
            const localDate = new Date(); // Assume this is a local date and time
            const utcDateString = localDate.toISOString();

            const [fromU, toU] = await Promise.all([
                db('profile').where('user_id', from).first(),
                db('profile').where('user_id', to).first()
            ]);

            if (!fromU || !toU) {
                const errorMsg = !fromU ? 'From User not found' : 'To User not found';
                io.emit('notification-error', { status: false, message: errorMsg });
                return;
            }


            const chatNew = {
                from_id: from,
                to_id: to,
                message,
                created_time: utcDateString,
                attachment: attachment ? attachment[0] : null,
                messageType: messageType,
                iscaregiver: iscaregiver,
                type: messageType,
                is_read: "1",
                is_chat: "1",
            };

            [insertedMessage] = await db('chat').insert(chatNew);

            const id = insertedMessage;
            console.log(id);
            console.log(insertedMessage);
            ackCallback("{'msgId':" + id + "}");

            const userTokens = await db('fcmtoken').where('user_id', to).select('token');
            console.log(userTokens);


            // return
            // Extract just the tokens into an array
            const data1 = {
                data: {
                    fromUser: from,
                    toUser: to,
                    ACTION: "MESSAGE",
                    insertedMessage: parseInt(id),
                    messageType: messageType,
                    attachment: attachment && attachment.length > 0 ? attachment : null, // Allow null if no attachment
                    message: message
                }
            };

            // Prepare the token list and map the messages
            const tokenList = userTokens.map(tokenObject => tokenObject.token);
            const messages = tokenList.map(token => ({
                token,
                data: {
                    DocotorName: JSON.stringify(fromU.first_name + " " + fromU.last_name),
                    fromUser: JSON.stringify(data1?.data?.fromUser),
                    toUser: JSON.stringify(data1?.data.toUser),
                    ACTION: JSON.stringify(data1?.data.ACTION),
                    insertedMessage: JSON.stringify(data1?.data?.insertedMessage),  // FCM requires strings for numeric values
                    messageType: JSON.stringify(data1?.data?.messageType),
                    attachment: JSON.stringify(data1?.data?.attachment) ? JSON.stringify(data1.data.attachment) : null, // Serialize attachment if not null
                    message: JSON.stringify(data1.data.message)
                }
            }));

            console.log(tokenList);

            // Send the messages
            await sendMessages(messages);

            io.emit('notification-success', {
                message, from: fromU, to: toU, "ACTION": "MESSAGE", insertedMessage: parseInt(id), messageType: messageType, attachment: attachment,
            });

            io.emit(`offer-acknowledgment-${to}`, { insertedMessage: parseInt(insertedMessage) });

            io.emit('pushnotification', {
                data1: data1.data // Convert to a number

            });
            io.emit(`receive-message-${to}`, {
                message, from: fromU, to: toU, "ACTION": "MESSAGE", insertedMessage: parseInt(id), messageType: messageType, attachment: attachment,
            });


        } catch (error) {
            console.error('Error:', error);
            io.emit('notification-error', { status: false, message: 'Error processing request' });
        }
    });

    socket.on('call-status', (data) => {
        const { from, targetUserId, call_status } = data;
        try {
            io.emit(`call-status-${targetUserId}`, { call_status, from, targetUserId });
        } catch (e) {
            db('logs_sockets').insert({
                socket_name: `call-status-${targetUserId}`,
                error: e,
            });
        }
    });

    socket.on('message-status', async (data) => {
        try {
            const { message_status, from, to, msgId } = data;


            const [fromU, toU] = await Promise.all([
                db('profile').where('user_id', from).first(),
                db('profile').where('user_id', to).first()
            ]);

            if (!fromU || !toU) {
                const errorMsg = !fromU ? 'From User not found' : 'To User not found';
                io.emit('notification-error', { status: false, message: errorMsg });
                return;
            }
            const chatNew = {
                is_read: "0",
            };
            const condition = { id: msgId };

            const data1 = {
                data: {
                    fromUser: fromU,
                    toUser: toU,
                    ACTION: "MESSAGE_STATUS",
                    is_read: message_status,
                    msgId: msgId
                },
                registration_ids: [toU.token],
            };

            const response = await axios.post('https://fcm.googleapis.com/fcm/send', data1, {
                headers: {
                    Authorization: process.env.FCM_SERVER_KEY,
                    'Content-Type': 'application/json',
                },
            });

            console.log('====================================');
            console.log(response);
            console.log('====================================');

            io.emit('notification-success', {
                message, from: fromU, to: toU, msgId: msgId, "ACTION": "MESSAGE_STATUS"
            });

            io.emit('pushnotification', {
                data1: data1 // Convert to a number

            });
            await db('chat').where(condition).update(chatNew);

            io.emit(`message-status-${to}`, { "data": data });
        } catch (e) {
            console.error(`Error updating statuses in the database: ${error}`);
        }
    });

    socket.on('userStatus', async (data) => {
        const { userId } = data;
        try {
            onlineUsers.add(socket.id);
            await db('profile').where({ user_id: userId }).update({ socket_id: socket.id });
            await db('profile').where({ user_id: userId }).update({ status: 'isActive' });
            io.emit(`userOnline-${userId}`, { isActive: true, userId: userId });

        } catch (error) {
            console.error(`Error updating statuses in the database: ${error.message}`);
        }
    });

    socket.on('userStatusCheck', async (data, ackCallback) => {
        const { userId } = data;
        try {
            onlineUsers.add(socket.id);
            const statusCheck = await db('profile').where({ user_id: userId });
            ackCallback({ statusCheck: statusCheck })  // ye wala aesay
            io.emit(`statusCheck-${userId}`, { statusCheck: statusCheck });

        } catch (error) {
            console.error(`Error updating statuses in the database: ${error.message}`);
        }
    });

    socket.on(`chat-history`, async (data) => {
        const { from, to, msgId } = data;
        try {
            const condition = { id: msgId, from_id: from, to_id: to };
            const condition2 = { from_id: from, to_id: to };
            let history;
            if (msgId) {
                history = await db('chat').where(condition).orWhere('id', '>', msgId).select('*');
            } else {
                history = await db('chat').where(condition2).select('*');
            }

        } catch (e) {
            io.emit(`chat-history-${from}-${to}`, { message: "error in history", error: e });
        }
    });

    socket.on(`disconnect`, async () => {
        onlineUsers.delete(socket.id);
        const profileData = await db('profile').where({ socket_id: socket.id }).first();

        if (profileData && profileData.user_id) {
            const userId = profileData.user_id;

            await db('profile').where({ socket_id: socket.id }).update({ status: 'isDeactive' });
            const data = {
                data: {
                    "userId": userId,
                    ACTION: "DISCONNECTED",
                },
                registration_ids: [profileData.token],
            };

            axios.post('https://fcm.googleapis.com/fcm/send', data, {
                headers: {
                    Authorization: process.env.FCM_SERVER_KEY,
                    'Content-Type': 'application/json',
                },
            }).then((response) => {
                console.log('====================================');
                console.log(response);
                console.log('====================================');
                io.emit(`userOffline-${userId}`, { isActive: false, userId: userId });

                io.emit('notification-success', {
                    userId: userId, "ACTION": "MESSAGE_STATUS"
                });

                io.emit('pushnotification', {
                    data1: data // Convert to a number

                });
            }).catch((error) => {
                console.log('====================================');
                console.log(error);
                console.log('====================================');
                // return res.status(500).json({ status: false, data: error, message: 'To User not found' });
            });
        } else {
            console.log('No user found with the provided socket_id');
        }
    });

    socket.on('test', (data) => {

        io.emit('test-success', {
            data: data,
        });
    });

});
async function sendMessages(messages) {
    try {
        const responses = await Promise.all(messages.map(message => admin.messaging().send(message)));
        console.log('FCM Responses:', responses);
    } catch (error) {
        console.error('Error sending FCM messages:', error);
    }
}
async function sendMessages1(messages) {
    for (const message of messages) {
        try {
            await admin.messaging().send(message);
            console.log(`Message sent to token: ${message.token}`);
        } catch (error) {
            console.error('Error sending FCM message:', error);
        }
    }
}
app.use('/api/', roomsRouter);
app.use('/api/', imagesRouter);
app.use('/api/', VideosRouter);
app.use('/api/images/', ImageArray);



const port = process.env.PORT || 3000;
<<<<<<< HEAD
const ipAddress = '127.0.0.1';

server.listen(port/*, ipAddress*/, () =>
{
=======

server.listen(port, () => {
>>>>>>> 0939aeb2574a54cffe7b927104742392a5466f80
    console.log(`Server running on port ${port}`);
});

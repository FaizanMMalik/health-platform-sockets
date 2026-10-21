const express = require('express');
const router = express.Router();
const db = require('../db');
const Joi = require('joi');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { sendPushNotificationMessage } = require('../fcm');



const storage = multer.diskStorage({
    destination: async function (req, file, cb) {
        const userId = req.body.from; // Assuming 'from' is the user ID in the request body
        const userFolderPath = path.join('public/uploads', userId.toString() ?? "");

        try {
            // Check if the user folder exists, if not, create it
            await fs.mkdir(userFolderPath, { recursive: true }); // Create directory recursively if it doesn't exist
            cb(null, userFolderPath);
        } catch (err) {
            cb(err);
        }
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'attachment_' + uniqueSuffix + path.extname(file.originalname));
    }
});

// Initialize multer with storage options
const upload = multer({ storage: storage });


// Create Room for Call
router.post('/room-create', async (req, res) => {
    const { user_id, user_firstname, user_lastname, user_role_id, user_email, user_image, user_token, doctor_id, doctor_firstname, doctor_lastname, doctor_role_id, doctor_email, doctor_image, doctor_token, appoint_id } = req.body;

    try {
        const roomSchema = Joi.object({
            user_id: Joi.number().required(),
            user_firstname: Joi.string().required(),
            user_lastname: Joi.string().required(), // Add user_lastname
            user_role_id: Joi.number().required(),
            user_email: Joi.string().required(),
            user_image: Joi.string().required(),
            user_token: Joi.string().required(),

            doctor_id: Joi.number().required(),
            doctor_firstname: Joi.string().required(),
            doctor_lastname: Joi.string().required(), // Add doctor_lastname
            doctor_role_id: Joi.number().required(),
            doctor_email: Joi.string().required(),
            doctor_image: Joi.string().required(),
            doctor_token: Joi.string().required(),

            appoint_id: Joi.number().required() // Add appoint_id to the schema
        });
        const { error } = roomSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ status: false, message: error.details[0].message });
        }

        const userExists = await db('profile').where('user_id', user_id).first();
        const doctorExists = await db('profile').where('user_id', doctor_id).first();

        if (!userExists) {
            await db('profile').insert({
                user_id,
                first_name: user_firstname ?? "",
                last_name: user_lastname ?? "",
                role_id: user_role_id ?? "",
                email: user_email ?? "",
                image: user_image ?? "",
                token: user_token ?? ""
            });
        }

        if (!doctorExists) {
            await db('profile').insert({
                user_id: doctor_id ?? "",
                first_name: doctor_firstname ?? "",
                last_name: doctor_lastname ?? "",
                role_id: doctor_role_id ?? "",
                email: doctor_email ?? "",
                image: doctor_image ?? "",
                token: doctor_token ?? ""
            });
        }
        let chat = ""; // Declare as 'let' instead of 'const'

        const existingRoom = await db('rooms').where('appoint_id', appoint_id).where('staff_id', doctor_id).first();

        if (!existingRoom) {
            const roomName = `Room-${user_id}-${doctor_id}-${appoint_id}`;
            const [roomID] = await db('rooms').insert({ name: roomName, staff_id: doctor_id, appoint_id });

            const userRoomDetail = { user_id, room_id: roomID };
            const doctorRoomDetail = { user_id: doctor_id, room_id: roomID };

            await db('room_detail').insert(userRoomDetail);
            await db('room_detail').insert(doctorRoomDetail);

            chat = await db('chat').where('from_id', doctor_id).where('to_id', user_id).where('room_id', roomID).select('*');
        } else {
            const userRoomDetail = { user_id, room_id: existingRoom.id };
            const doctorRoomDetail = { user_id: doctor_id, room_id: existingRoom.id };

            chat = await db('chat').where('from_id', doctor_id).where('to_id', user_id).where('room_id', roomID).select('*');

            checkRoomJ = await db('room_detail').where('room_id', existingRoom.id).where('user_id', user_id).select('*');
            checkRoomD = await db('room_detail').where('room_id', existingRoom.id).where('user_id', doctor_id).select('*');
            if (!checkRoomJ) {
                await db('room_detail').insert(userRoomDetail);
            } else if (!checkRoomD) {
                await db('room_detail').insert(doctorRoomDetail);

            }
        }

        return res.status(200).json({ status: 200, message: "Room Created Successfully", data: chat });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Failed to create profile or room detail' });
    }
});

router.get('/rooms', async (req, res) => {
    const { doctor_id, user_id } = req.body;
    try {
        if (doctor_id) {
            const rooms = await db('rooms').where('staff_id', doctor_id).select('*');
            if (rooms.length > 0) {
                const roomIDs = rooms.map(room => room.id); // Extract room IDs

                // Fetch room details and user profiles based on room detail IDs
                const roomDetails = await db('room_detail').whereIn('room_id', roomIDs).select('*');
                const roomDetailIDs = roomDetails.map(roomDe => roomDe.user_id);

                const userProfiles = await db('profile').whereIn('user_id', roomDetailIDs).select('*');

                // Fetch chats based on room IDs
                const chats = await db('chat').whereIn('room_id', roomIDs).where('is_read', 0).orderBy('id', 'desc').first();
                const [unreadMessagesCount] = await db('chat').whereIn('room_id', roomIDs).where('is_read', 0).count('id as unread_count');

                // Map user profiles and chats to their corresponding rooms
                const roomsWithProfilesAndChats = rooms.map(room => {
                    const roomUsers = roomDetails
                        .filter(detail => detail.room_id === room.id)
                        .map(detail => userProfiles.find(profile => profile.user_id === detail.user_id));



                    return { ...room, users: roomUsers, chats: chats, unreadMessagesCount };
                });

                return res.status(200).json({
                    status: true,
                    data: roomsWithProfilesAndChats,
                    message: 'Room List with User Profiles and Chats',
                });
            }
        } else {
            return res.status(200).json({
                status: true,
                data: "user_id",
                message: 'user_id chat',
            });
        }

    } catch (error) {
        console.log(error);
        return res.status(500).json({ status: false, message: 'Internal server error' });
    }
});


router.get('/get-rooms', async (req, res) => {
    const { doc_id, patient_id } = req.params;

    const rooms = await db('room').select('*');
    if (rooms) {
        return res.status(200).json({ status: true, data: rooms, message: 'Room List' });
    }
    return res.status(404).json({ status: false, message: 'Not Found' });
});
router.post('/add-error-logs', async (req, res) => {
    const { error, socket_name, app_name } = req.body;
    const roomSchema = Joi.object({
        error: Joi.string().required(),
        socket_name: Joi.string().required(),
        app_name: Joi.string().required(),
    });
    try {
        const { errors } = roomSchema.validate(req.body);
        if (errors) {
            return res.status(400).json({ status: false, message: errors.details[0].message });
        }
        const logData = {
            error: error,
            socket_name: socket_name,
            app_name: app_name
        };
        const addLogs = await db('logs_sockets').insert(logData);

        if (addLogs) {
            return res.status(200).json({ status: true, data: addLogs, message: 'Error added to the database' });
        } else {
            return res.status(400).json({ status: false, message: 'Error adding to the database' });
        }
    } catch (e) {

        const errorLogData = {
            error: 'Exception ' + e,
            socket_name: socket_name,
            app_name: app_name
        };
        const logError = await db('logs_sockets').insert(errorLogData);

        return res.status(500).json({
            status: false,
            message: 'Error adding to the database',
            error: e.message,
            loggedError: logError // This will be either the ID of the logged error or another indication of success/failure
        });
    }
});

// Join Room
router.post('/:roomId/join', async (req, res) => {
    const { roomId } = req.params;
    const { from } = req.body;
    const roomSchema = Joi.object({
        from: Joi.number().required(),
    });
    try {
        const { error } = roomSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ status: false, message: error.details[0].message });
        }

        const Room = await db('room').where('id', roomId).first();
        const Calling = await db('calling')
            .where('room_name', Room.room_name)
            .where('room_id', roomId)
            .where('to', Room.doctor_id)
            .where('from', from)
            .first();
        if (!Room) {
            return res.status(409).json({ status: true, message: 'Not Found' });
        } else if (Calling) {
            return res.status(409).json({ status: true, message: 'Already Join' });
        }

        const joinRoom = {
            room_id: roomId,
            room_name: Room.room_name,
            from: from,
            to: Room.doctor_id,
        };

        await db('calling').insert(joinRoom);
        return res.status(200).json({ status: true, data: joinRoom, message: 'User Profile Create' });

    } catch (error) {
        console.error('Error checking email:', error);
        return res.status(500).json({ status: true, error: error });
    }
});


// check profile new
router.post('/profile', async (req, res) => {
    const { user_id, first_name, last_name, role, email, token } = req.body;

    try {
        await db.transaction(async trx => {
            const userTokens = await trx('fcmtoken').where('user_id', user_id);

            if (userTokens.length > 0 && role === 'patient'&& token) {
                // Filter out the token that matches the request token and also ignore empty tokens
                const filteredTokens = userTokens.filter(t => t.token && t.token !== token);

                if (filteredTokens.length > 0) {
                    const messages = filteredTokens.map(t => ({
                        token: t.token,
                        data: { ACTION: "LOGOUT" }
                    }));

                    await sendPushNotificationMessage(messages);

                    // Delete only filtered tokens from the DB
                    const tokensToDelete = filteredTokens.map(t => t.token);
                    await trx('fcmtoken').where('user_id', user_id).whereIn('token', tokensToDelete).del();

                    console.log(messages);
                } else {
                    console.log('No tokens to send notifications to after filtering.');
                }
            }
        });


        let user = await db('profile').where({ user_id, role }).first();
        const existingToken = await db('fcmtoken').where({ user_id }).first();

        // fetch all tokens if role == patient
        // remove the current token if any and send logout notification to remaining
        // if token is emty , don't add to fcm table

        if (!user) {
            console.log("🆕 Creating new user and token");
            const newUser = { user_id, first_name, last_name, role, email, status: 'isActive' };

            await db('profile').insert(newUser);
            console.log("Prrrrrrrofile create",token);
            
            if (token) {
                await db('fcmtoken').insert({ user_id, token });
            console.log("Prrrrrrrofile token create");

            }

            return res.status(200).json({
                status: true,
                data: newUser,
                message: 'User Profile Created'
            });
        }

        if (existingToken) {
            if (existingToken.token !== token) {
                console.log("✏️ Updating existing token");
                if (token) {
                    await db('fcmtoken').where({ user_id }).update({ token });
                }
            } else {
                console.log("🟡 Token unchanged, skipping update");
            }
        } else {
            console.log("➕ No token for user, inserting new one");
            if (token) {
                await db('fcmtoken').insert({ user_id, token });
            }
        }

        return res.status(200).json({
            status: true,
            data: user,
            message: 'User exists and token handled'
        });

    } catch (error) {
        console.error('❌ Error during /profile processing:', error);
        return res.status(500).json({
            status: false,
            error: error.message || error
        });
    }
});

router.delete('/profile/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await db.transaction(async trx => {
            // Delete all FCM tokens
            await trx('fcmtoken').where('user_id', id).del();
            // Delete user profile
            await trx('profile').where('user_id', id).del();
       });

        return res.status(200).json({
            status: true,
            message: `All records for user ${id} deleted successfully`
        });

    } catch (error) {
        console.error("❌ Delete Error:", error);
        return res.status(500).json({
            status: false,
            error: error.message || error
        });
    }
});



router.post('/chat', upload.array('attachment'), async (req, res) => {
    try {
        const { from, to, message, messagetype, metaData } = req.body;

        const baseUrl = req.protocol + '://' + req.get('host'); // Extracts the base URL dynamically

        const chatNew = {
            from_id: from,
            to_id: to,
            message: message,
            is_read: "1",
            messagetype: messagetype,
            metaData: metaData ?? "",
            is_chat: "1",
        };

        if (req.files && req.files.length > 0) {
            const userId = req.body.from; // Assuming 'from' is the user ID in the request body

            const attachments = req.files.map(file => {
                const filePath = `/public/uploads/${userId}/${file.filename}`;
                return baseUrl + filePath; // Prepends base URL to each file path
            });

            chatNew.attachment = attachments // Join attachments array with commas
        }

        // const [chatList] = await db('chat').insert(chatNew);
        // const insertedChat = await db('chat').where('id', chatList).first();
        return res.status(200).json({ status: true, data: chatNew, message: 'Chat Created' });
    } catch (error) {
        return res.status(500).json({ status: false, error: error.message });
    }
});


router.post('/fcm-token', async (req, res) => {
    try {
        const { tokens, from, to, ACTION, customData, message } = req.body;
        const fromU = await db('profile').where('user_id', from).first();
        const toU = await db('profile').where('user_id', to).first();

        if (!fromU || !toU) {
            if (!fromU) {
                return res.status(404).json({ status: false, data: fromU, message: 'From User not found' });
            } else if (!toU) {
                return res.status(404).json({ status: false, data: toU, message: 'To User not found' });
            }
        }

        const chatNew = {
            from_id: from,
            to_id: to,
            message,
            is_read: "1",
            is_chat: "1",
        };

        const existingMessage = await db('chat')
            .where('from_id', from)
            .where('to_id', to)
            .where('message', message)
            .first();

        let insertedMessage;
        if (!existingMessage) {
            [insertedMessage] = await db('chat').insert(chatNew);
        } else {
            insertedMessage = existingMessage;
        }

        const data = {
            data: {
                "patienr": fromU,
                "doc_id": fromU.id,
                "patient_id": toU.id,
                ACTION: ACTION,
                customData: customData,
                insertedMessage: parseInt(insertedMessage.id),
            },
            registration_ids: tokens,
        };

        const tokenList = Array.isArray(data.registration_ids) ? data.registration_ids.filter(Boolean) : [];
        let responseData = null;

        if (tokenList.length > 0) {
            const fcmResult = await sendPushNotificationMessage(
                tokenList.map((token) => ({
                    token,
                    data: data.data,
                }))
            );
            responseData = fcmResult?.data || null;
        } else {
            console.log('No tokens to send');
        }

        return res.status(200).json({
            status: true,
            customData: customData,
            message: message,
            from: fromU,
            ACTION: ACTION,
            to: toU,
            data: responseData,
            insertedMessage: parseInt(insertedMessage.id),
        });
    } catch (error) {
        return res.status(500).json({ status: false, data: error, message: 'To User not found' });
    }
});




router.post('/chat-by-doctor', async (req, res) => {
    try {
        const { doc_id } = req.body;

        if (!doc_id) {
            return res.status(400).json({ status: false, message: 'Doctor ID is required' });
        }

        // Verify doctor profile exists
        const fromU = await db('profile').where('user_id', doc_id).first();
        if (!fromU) {
            return res.status(404).json({ status: false, message: 'Doctor not found' });
        }

        // Subquery to get latest chat ID per user (other than doctor)
        const latestChatsSubquery = db('chat AS c')
            .select(
                db.raw(`
                    CASE
                        WHEN c.to_id = ? THEN c.from_id
                        ELSE c.to_id
                    END AS user_id
                `, [doc_id]),
                db.raw('MAX(c.id) AS latest_chat_id')
            )
            .where(function () {
                this.where('c.from_id', doc_id).orWhere('c.to_id', doc_id);
            })
            .groupBy(
                db.raw(`
                    CASE
                        WHEN c.to_id = ? THEN c.from_id
                        ELSE c.to_id
                    END
                `, [doc_id])
            );

        // Main query joining with subquery to get latest chat per user
        const result = await db('chat AS c')
            .join(
                latestChatsSubquery.as('LatestChat'),
                'LatestChat.latest_chat_id', 'c.id'
            )
            .join('profile AS p', 'p.user_id', 'LatestChat.user_id')
            .select(
                'p.user_id',
                'p.first_name',
                'p.email',
                'c.id AS chat_id',
                'c.from_id',
                'c.to_id',
                'c.message',
                'c.created_time'
            )
            .orderBy('c.id', 'desc');

        // Since the subquery groups by user_id, each user_id should be unique here.
        // But if you want to be extra sure, you can filter duplicates in JS:
        const uniqueResults = [];
        const seenUserIds = new Set();

        for (const chat of result) {
            if (!seenUserIds.has(chat.user_id)) {
                seenUserIds.add(chat.user_id);
                uniqueResults.push(chat);
            }
        }

        return res.status(200).json({ status: true, result: uniqueResults });

    } catch (error) {
        console.error('Error in /chat-by-doctor route:', error);
        return res.status(500).json({ status: false, error: 'An error occurred while processing the request.' });
    }
});

router.post('/v1/chat-by-doctor', async (req, res) => {
    try {
        const { doc_id } = req.body;

        if (!doc_id) {
            return res.status(400).json({ status: false, message: 'Doctor ID is required' });
        }

        const fromU = await db('profile').where('user_id', doc_id).first();

        if (!fromU) {
            return res.status(404).json({ status: false, message: 'Doctor not found' });
        }

        // Subquery: last chat id per patientId
        const lastChatSubquery = db('chat AS c')
            .select(
                'c.patientId',
                db.raw('MAX(c.id) AS last_chat_id')
            )
            .where(function () {
                this.where('c.from_id', doc_id).orWhere('c.to_id', doc_id);
            })
            .whereNotNull('c.patientId')
            .groupBy('c.patientId');

        const result = await db('chat AS c')
            .join(
                db.raw(`(${lastChatSubquery.toQuery()}) AS LastChat`),
                'LastChat.last_chat_id', 'c.id'
            )
            .join('profile AS p_from', 'p_from.user_id', 'c.from_id')
            .join('profile AS p_to', 'p_to.user_id', 'c.to_id')
            .leftJoin('profile AS p_patient', 'p_patient.user_id', 'c.patientId')
            .leftJoin('profile AS p_doctor', 'p_doctor.user_id', 'c.doctorId')
            .select(
                'c.*',
                'p_from.id AS pf_id',
                'p_from.user_id AS pf_user_id',
                'p_from.first_name AS pf_first_name',
                'p_from.last_name AS pf_last_name',
                'p_from.email AS pf_email',
                'p_from.image AS pf_image',
                'p_from.token AS pf_token',
                'p_from.role AS pf_role',
                'p_from.status AS pf_status',
                'p_from.socket_id AS pf_socket_id',
                'p_to.id AS pt_id',
                'p_to.user_id AS pt_user_id',
                'p_to.first_name AS pt_first_name',
                'p_to.last_name AS pt_last_name',
                'p_to.email AS pt_email',
                'p_to.image AS pt_image',
                'p_to.token AS pt_token',
                'p_to.role AS pt_role',
                'p_to.status AS pt_status',
                'p_to.socket_id AS pt_socket_id',
                'p_patient.id AS pp_id',
                'p_patient.user_id AS pp_user_id',
                'p_patient.first_name AS pp_first_name',
                'p_patient.last_name AS pp_last_name',
                'p_patient.email AS pp_email',
                'p_patient.image AS pp_image',
                'p_patient.token AS pp_token',
                'p_patient.role AS pp_role',
                'p_patient.status AS pp_status',
                'p_patient.socket_id AS pp_socket_id',
                'p_doctor.id AS pd_id',
                'p_doctor.user_id AS pd_user_id',
                'p_doctor.first_name AS pd_first_name',
                'p_doctor.last_name AS pd_last_name',
                'p_doctor.email AS pd_email',
                'p_doctor.image AS pd_image',
                'p_doctor.token AS pd_token',
                'p_doctor.role AS pd_role',
                'p_doctor.status AS pd_status',
                'p_doctor.socket_id AS pd_socket_id'
            )
            .whereNotNull('c.patientId')
            .whereNotNull('c.doctorId')
            .orderBy('c.created_time', 'desc');

        const usersMap = new Map();
        const seenPatientIds = new Set();
        const chatList = [];

        result.forEach(item => {
            const otherUserId = item.from_id == doc_id ? String(item.to_id) : String(item.from_id);

            const patientKey = item.patientId ? String(item.patientId) : otherUserId;
            if (seenPatientIds.has(patientKey)) return;
            seenPatientIds.add(patientKey);

            const profiles = [
                { id: item.pf_id, user_id: item.pf_user_id, first_name: item.pf_first_name, last_name: item.pf_last_name, email: item.pf_email, image: item.pf_image, token: item.pf_token, role: item.pf_role, status: item.pf_status, socket_id: item.pf_socket_id },
                { id: item.pt_id, user_id: item.pt_user_id, first_name: item.pt_first_name, last_name: item.pt_last_name, email: item.pt_email, image: item.pt_image, token: item.pt_token, role: item.pt_role, status: item.pt_status, socket_id: item.pt_socket_id },
                item.pp_id ? { id: item.pp_id, user_id: item.pp_user_id, first_name: item.pp_first_name, last_name: item.pp_last_name, email: item.pp_email, image: item.pp_image, token: item.pp_token, role: item.pp_role, status: item.pp_status, socket_id: item.pp_socket_id } : null,
                item.pd_id ? { id: item.pd_id, user_id: item.pd_user_id, first_name: item.pd_first_name, last_name: item.pd_last_name, email: item.pd_email, image: item.pd_image, token: item.pd_token, role: item.pd_role, status: item.pd_status, socket_id: item.pd_socket_id } : null,
            ].filter(Boolean);

            profiles.forEach(p => {
                if (p.user_id && p.user_id !== doc_id && !usersMap.has(p.user_id)) {
                    usersMap.set(p.user_id, p);
                }
            });

            chatList.push({
                id: item.id,
                from_id: item.from_id,
                to_id: item.to_id,
                patientId: item.patientId,
                doctorId: item.doctorId,
                message: item.message,
                created_time: item.created_time,
                messageType: item.messageType,
                attachment: item.attachment,
                type: item.type,
                is_read: item.is_read,
                is_chat: item.is_chat,
                status: item.status,
                iscaregiver: item.iscaregiver,
                metadata: item.metadata,
                role: item.role,
                chat_type: item.chat_type,
                appointment_id: item.appointment_id,
                chat_mode: item.chat_mode,
                clinic_id: item.clinic_id,
                department_id: item.department_id,
            });
        });

        const users = Array.from(usersMap.values());

        return res.status(200).json({ status: true, users: users, chatList: chatList });

    } catch (error) {
        console.error('Error in /chat-by-doctor route:', error);
        return res.status(500).json({ status: false, message: 'An error occurred while processing the request.' });
    }
});

router.post('/chat-by-patient-only', async (req, res) => {
    try {
        const { patient_id } = req.body; // Get the patient_id from the request body

        if (!patient_id) {
            return res.status(400).json({ status: false, message: 'Patient ID is required' });
        }

        // Verify the patient profile exists
        const fromU = await db('profile').where('user_id', patient_id).first();

        if (!fromU) {
            return res.status(404).json({ status: false, message: 'Patient not found' });
        }

        // Subquery to fetch the last chat message ID with each doctor
        const lastChatSubquery = db('chat AS c')
            .select(
                db.raw(`
                    CASE
                        WHEN c.to_id = ? THEN c.from_id
                        ELSE c.to_id
                    END AS doctor_id
                `, [patient_id]),
                'c.id AS chat_id',
                'c.created_time'
            )
            .where(function () {
                this.where('c.from_id', patient_id).orWhere('c.to_id', patient_id);
            })
            .orderBy('c.created_time', 'desc');  // Get the most recent chat

        // Main query to get the last chat with each doctor
        const query = db('chat AS c')
            .join(
                db.raw(`(${lastChatSubquery.toQuery()}) AS LastChat`),
                'LastChat.chat_id', 'c.id'
            )
            .join('profile AS p', 'p.user_id', 'LastChat.doctor_id')
            .select(
                'p.user_id AS doctor_id',
                'p.first_name AS doctor_name',
                'p.email AS doctor_email',
                'c.id AS chat_id',
                'c.from_id',
                'c.to_id',
                'c.message',
                'c.created_time',
                'c.type',
                'c.metadata',
                'c.status'
            )
            .orderBy('c.created_time', 'desc');  // Ensure the latest message is retrieved

        // Execute the query
        query
            .then(result => {
                // Group the results by doctor_id to ensure each doctor only appears once
                const groupedResults = [];
                const doctorIds = new Set();

                result.forEach(item => {
                    if (!doctorIds.has(item.doctor_id)) {
                        doctorIds.add(item.doctor_id);
                        groupedResults.push(item);
                    }
                });

                return res.status(200).json({ status: true, result: groupedResults });
            })
            .catch(error => {
                console.error('Error in /chat-by-patient-only route:', error);
                return res.status(500).json({ status: false, message: 'An error occurred while processing the request.' });
            });

    } catch (error) {
        console.error('Error in /chat-by-patient-only route:', error);
        return res.status(500).json({ status: false, message: 'An error occurred while processing the request.' });
    }
});

router.post('/v1/chat-by-patient-only', async (req, res) => {
    try {
        const { patient_id } = req.body;

        if (!patient_id) {
            return res.status(400).json({ status: false, message: 'Patient ID is required' });
        }

        const fromU = await db('profile').where('user_id', patient_id).first();

        if (!fromU) {
            return res.status(404).json({ status: false, message: 'Patient not found' });
        }

        // Subquery: last chat id per doctorId
        const lastChatSubquery = db('chat AS c')
            .select('c.doctorId', db.raw('MAX(c.id) AS last_chat_id'))
            .where('c.patientId', patient_id)
            .groupBy('c.doctorId');

        const result = await db('chat AS c')
            .join(
                db.raw(`(${lastChatSubquery.toQuery()}) AS LastChat`),
                'LastChat.last_chat_id', 'c.id'
            )
            .join('profile AS p_from', 'p_from.user_id', 'c.from_id')
            .join('profile AS p_to', 'p_to.user_id', 'c.to_id')
            .leftJoin('profile AS p_patient', 'p_patient.user_id', 'c.patientId')
            .leftJoin('profile AS p_doctor', 'p_doctor.user_id', 'c.doctorId')
            .select(
                'c.*',
                'p_from.id AS pf_id',
                'p_from.user_id AS pf_user_id',
                'p_from.first_name AS pf_first_name',
                'p_from.last_name AS pf_last_name',
                'p_from.email AS pf_email',
                'p_from.image AS pf_image',
                'p_from.token AS pf_token',
                'p_from.role AS pf_role',
                'p_from.status AS pf_status',
                'p_from.socket_id AS pf_socket_id',
                'p_to.id AS pt_id',
                'p_to.user_id AS pt_user_id',
                'p_to.first_name AS pt_first_name',
                'p_to.last_name AS pt_last_name',
                'p_to.email AS pt_email',
                'p_to.image AS pt_image',
                'p_to.token AS pt_token',
                'p_to.role AS pt_role',
                'p_to.status AS pt_status',
                'p_to.socket_id AS pt_socket_id',
                'p_patient.id AS pp_id',
                'p_patient.user_id AS pp_user_id',
                'p_patient.first_name AS pp_first_name',
                'p_patient.last_name AS pp_last_name',
                'p_patient.email AS pp_email',
                'p_patient.image AS pp_image',
                'p_patient.token AS pp_token',
                'p_patient.role AS pp_role',
                'p_patient.status AS pp_status',
                'p_patient.socket_id AS pp_socket_id',
                'p_doctor.id AS pd_id',
                'p_doctor.user_id AS pd_user_id',
                'p_doctor.first_name AS pd_first_name',
                'p_doctor.last_name AS pd_last_name',
                'p_doctor.email AS pd_email',
                'p_doctor.image AS pd_image',
                'p_doctor.token AS pd_token',
                'p_doctor.role AS pd_role',
                'p_doctor.status AS pd_status',
                'p_doctor.socket_id AS pd_socket_id'
            )
            .orderBy('c.created_time', 'desc');

        const usersMap = new Map();
        const seenDoctorIds = new Set();
        const chatList = [];

        result.forEach(item => {
            const docId = String(item.doctorId);
            if (seenDoctorIds.has(docId)) return;
            seenDoctorIds.add(docId);

            const profiles = [
                { id: item.pf_id, user_id: item.pf_user_id, first_name: item.pf_first_name, last_name: item.pf_last_name, email: item.pf_email, image: item.pf_image, token: item.pf_token, role: item.pf_role, status: item.pf_status, socket_id: item.pf_socket_id },
                { id: item.pt_id, user_id: item.pt_user_id, first_name: item.pt_first_name, last_name: item.pt_last_name, email: item.pt_email, image: item.pt_image, token: item.pt_token, role: item.pt_role, status: item.pt_status, socket_id: item.pt_socket_id },
                item.pp_id ? { id: item.pp_id, user_id: item.pp_user_id, first_name: item.pp_first_name, last_name: item.pp_last_name, email: item.pp_email, image: item.pp_image, token: item.pp_token, role: item.pp_role, status: item.pp_status, socket_id: item.pp_socket_id } : null,
                item.pd_id ? { id: item.pd_id, user_id: item.pd_user_id, first_name: item.pd_first_name, last_name: item.pd_last_name, email: item.pd_email, image: item.pd_image, token: item.pd_token, role: item.pd_role, status: item.pd_status, socket_id: item.pd_socket_id } : null,
            ].filter(Boolean);

            profiles.forEach(p => {
                if (p.user_id && !usersMap.has(p.user_id)) {
                    usersMap.set(p.user_id, p);
                }
            });

            chatList.push({
                id: item.id,
                from_id: item.from_id,
                to_id: item.to_id,
                patientId: item.patientId,
                doctorId: item.doctorId,
                message: item.message,
                created_time: item.created_time,
                messageType: item.messageType,
                attachment: item.attachment,
                type: item.type,
                is_read: item.is_read,
                is_chat: item.is_chat,
                status: item.status,
                iscaregiver: item.iscaregiver,
                metadata: item.metadata,
                role: item.role,
                chat_type: item.chat_type,
                appointment_id: item.appointment_id,
                chat_mode: item.chat_mode,
                clinic_id: item.clinic_id,
                department_id: item.department_id,
            });
        });

        const users = Array.from(usersMap.values());

        return res.status(200).json({ status: true, users: users, chatList: chatList });

    } catch (error) {
        console.error('Error in /v1/chat-by-patient-only route:', error);
        return res.status(500).json({ status: false, message: 'An error occurred while processing the request.' });
    }
});



router.post('/chat-by-patient', async (req, res) => {
    const { patient_id, doctor_id } = req.body;
    const fromU = await db('profile').where('user_id', patient_id).first();

    try {
        if (!fromU) {
            return res.status(404).json({ status: false, data: patient_id, message: 'Patient not found' });
        }

        const query = db('chat AS c')
            .join('profile AS p_from', 'c.from_id', 'p_from.user_id')
            .join('profile AS p_to', 'c.to_id', 'p_to.user_id')
            .where(function () {
                this.where(function () {
                    this.where('c.to_id', doctor_id).andWhere('c.from_id', patient_id)
                        .orWhere('c.to_id', patient_id).andWhere('c.from_id', doctor_id);
                });
            })

            .select(
                'c.id AS chat_id',
                'c.from_id',
                'c.to_id',
                'c.message',
                'c.created_time',
                'c.attachment',
                'c.messageType',
                'c.metadata',
                'p_from.user_id AS from_user_id',
                'p_from.first_name AS from_first_name',
                'p_from.last_name AS from_last_name',
                'p_to.user_id AS to_user_id',
                'p_to.first_name AS to_first_name',
                'p_to.last_name AS to_last_name'
            )
            .orderBy('c.id', 'desc');

        // Execute the query
        query
            .then(result => {
                return res.status(200).json({ status: true, result: result });
            })
            .catch(error => {
                console.error('Error in /chat-by-patient route:', error);
                return res.status(500).json({ status: false, error: 'An error occurred while processing the request.' });
            });

    } catch (error) {
        console.error('Error in /chat-by-patient route:', error);
        return res.status(500).json({ status: false, error: 'An error occurred while processing the request.' });
    }
});

router.post('/v1/chat-by-patient', async (req, res) => {
    try {
        const { patient_id, doctor_id } = req.body;

        if (!patient_id || !doctor_id) {
            return res.status(400).json({ status: false, message: 'Patient ID and Doctor ID are required' });
        }

        const fromU = await db('profile').where('user_id', patient_id).first();

        if (!fromU) {
            return res.status(404).json({ status: false, message: 'Patient not found' });
        }

        const result = await db('chat AS c')
            .join('profile AS p_from', 'p_from.user_id', 'c.from_id')
            .join('profile AS p_to', 'p_to.user_id', 'c.to_id')
            .leftJoin('profile AS p_patient', 'p_patient.user_id', 'c.patientId')
            .leftJoin('profile AS p_doctor', 'p_doctor.user_id', 'c.doctorId')
            .where(function () {
                this.where(function () {
                    this.where('c.from_id', patient_id).andWhere('c.to_id', doctor_id)
                        .orWhere('c.from_id', doctor_id).andWhere('c.to_id', patient_id);
                }).orWhere(function () {
                    this.where('c.patientId', patient_id).andWhere('c.doctorId', doctor_id)
                        .orWhere('c.patientId', doctor_id).andWhere('c.doctorId', patient_id);
                });
            })
            .whereNotNull('c.patientId')
            .whereNotNull('c.doctorId')
            .select(
                'c.*',
                'p_from.id AS pf_id',
                'p_from.user_id AS pf_user_id',
                'p_from.first_name AS pf_first_name',
                'p_from.last_name AS pf_last_name',
                'p_from.email AS pf_email',
                'p_from.image AS pf_image',
                'p_from.token AS pf_token',
                'p_from.role AS pf_role',
                'p_from.status AS pf_status',
                'p_from.socket_id AS pf_socket_id',
                'p_to.id AS pt_id',
                'p_to.user_id AS pt_user_id',
                'p_to.first_name AS pt_first_name',
                'p_to.last_name AS pt_last_name',
                'p_to.email AS pt_email',
                'p_to.image AS pt_image',
                'p_to.token AS pt_token',
                'p_to.role AS pt_role',
                'p_to.status AS pt_status',
                'p_to.socket_id AS pt_socket_id',
                'p_patient.id AS pp_id',
                'p_patient.user_id AS pp_user_id',
                'p_patient.first_name AS pp_first_name',
                'p_patient.last_name AS pp_last_name',
                'p_patient.email AS pp_email',
                'p_patient.image AS pp_image',
                'p_patient.token AS pp_token',
                'p_patient.role AS pp_role',
                'p_patient.status AS pp_status',
                'p_patient.socket_id AS pp_socket_id',
                'p_doctor.id AS pd_id',
                'p_doctor.user_id AS pd_user_id',
                'p_doctor.first_name AS pd_first_name',
                'p_doctor.last_name AS pd_last_name',
                'p_doctor.email AS pd_email',
                'p_doctor.image AS pd_image',
                'p_doctor.token AS pd_token',
                'p_doctor.role AS pd_role',
                'p_doctor.status AS pd_status',
                'p_doctor.socket_id AS pd_socket_id'
            )
            .orderBy('c.created_time', 'desc');

        const usersMap = new Map();
        const seenChatIds = new Set();
        const chatList = [];

        result.forEach(item => {
            const profiles = [
                { id: item.pf_id, user_id: item.pf_user_id, first_name: item.pf_first_name, last_name: item.pf_last_name, email: item.pf_email, image: item.pf_image, token: item.pf_token, role: item.pf_role, status: item.pf_status, socket_id: item.pf_socket_id },
                { id: item.pt_id, user_id: item.pt_user_id, first_name: item.pt_first_name, last_name: item.pt_last_name, email: item.pt_email, image: item.pt_image, token: item.pt_token, role: item.pt_role, status: item.pt_status, socket_id: item.pt_socket_id },
                item.pp_id ? { id: item.pp_id, user_id: item.pp_user_id, first_name: item.pp_first_name, last_name: item.pp_last_name, email: item.pp_email, image: item.pp_image, token: item.pp_token, role: item.pp_role, status: item.pp_status, socket_id: item.pp_socket_id } : null,
                item.pd_id ? { id: item.pd_id, user_id: item.pd_user_id, first_name: item.pd_first_name, last_name: item.pd_last_name, email: item.pd_email, image: item.pd_image, token: item.pd_token, role: item.pd_role, status: item.pd_status, socket_id: item.pd_socket_id } : null,
            ].filter(Boolean);

            profiles.forEach(p => {
                if (p.user_id && !usersMap.has(p.user_id)) {
                    usersMap.set(p.user_id, p);
                }
            });

            if (!seenChatIds.has(item.id)) {
                seenChatIds.add(item.id);
                chatList.push({
                    id: item.id,
                    from_id: item.from_id,
                    to_id: item.to_id,
                    patientId: item.patientId,
                    doctorId: item.doctorId,
                    message: item.message,
                    created_time: item.created_time,
                    messageType: item.messageType,
                    attachment: item.attachment,
                    type: item.type,
                    is_read: item.is_read,
                    is_chat: item.is_chat,
                    status: item.status,
                    iscaregiver: item.iscaregiver,
                    metadata: item.metadata,
                    role: item.role,
                    chat_type: item.chat_type,
                    appointment_id: item.appointment_id,
                    chat_mode: item.chat_mode,
                    clinic_id: item.clinic_id,
                    department_id: item.department_id,
                });
            }
        });

        const users = Array.from(usersMap.values());

        return res.status(200).json({ status: true, users: users, chatList: chatList });

    } catch (error) {
        console.error('Error in /chat-by-patient route:', error);
        return res.status(500).json({ status: false, message: 'An error occurred while processing the request.' });
    }
});



router.post('/v1/chat-by-staff', async (req, res) => {
    try {
        const { staff_id } = req.body;

        if (!staff_id) {
            return res.status(400).json({ status: false, message: 'Staff ID is required' });
        }

        const fromU = await db('profile').where('user_id', staff_id).first();

        if (!fromU) {
            return res.status(404).json({ status: false, message: 'Staff not found' });
        }

        const lastChatSubquery = db('chat AS c')
            .select(
                db.raw(`
                    CASE
                        WHEN c.to_id = ? THEN c.from_id
                        ELSE c.to_id
                    END AS other_user_id
                `, [staff_id]),
                db.raw('MAX(c.id) AS last_chat_id')
            )
            .where(function () {
                this.where('c.from_id', staff_id).orWhere('c.to_id', staff_id);
            })
            .whereRaw('c.from_id != c.to_id')
            .groupBy(
                db.raw(`
                    CASE
                        WHEN c.to_id = ? THEN c.from_id
                        ELSE c.to_id
                    END
                `, [staff_id])
            );

        const result = await db('chat AS c')
            .join(
                db.raw(`(${lastChatSubquery.toQuery()}) AS LastChat`),
                'LastChat.last_chat_id', 'c.id'
            )
            .join('profile AS p_from', 'p_from.user_id', 'c.from_id')
            .join('profile AS p_to', 'p_to.user_id', 'c.to_id')
            .leftJoin('profile AS p_patient', 'p_patient.user_id', 'c.patientId')
            .leftJoin('profile AS p_doctor', 'p_doctor.user_id', 'c.doctorId')
            .select(
                'c.*',
                'p_from.id AS pf_id',
                'p_from.user_id AS pf_user_id',
                'p_from.first_name AS pf_first_name',
                'p_from.last_name AS pf_last_name',
                'p_from.email AS pf_email',
                'p_from.image AS pf_image',
                'p_from.token AS pf_token',
                'p_from.role AS pf_role',
                'p_from.status AS pf_status',
                'p_from.socket_id AS pf_socket_id',
                'p_to.id AS pt_id',
                'p_to.user_id AS pt_user_id',
                'p_to.first_name AS pt_first_name',
                'p_to.last_name AS pt_last_name',
                'p_to.email AS pt_email',
                'p_to.image AS pt_image',
                'p_to.token AS pt_token',
                'p_to.role AS pt_role',
                'p_to.status AS pt_status',
                'p_to.socket_id AS pt_socket_id',
                'p_patient.id AS pp_id',
                'p_patient.user_id AS pp_user_id',
                'p_patient.first_name AS pp_first_name',
                'p_patient.last_name AS pp_last_name',
                'p_patient.email AS pp_email',
                'p_patient.image AS pp_image',
                'p_patient.token AS pp_token',
                'p_patient.role AS pp_role',
                'p_patient.status AS pp_status',
                'p_patient.socket_id AS pp_socket_id',
                'p_doctor.id AS pd_id',
                'p_doctor.user_id AS pd_user_id',
                'p_doctor.first_name AS pd_first_name',
                'p_doctor.last_name AS pd_last_name',
                'p_doctor.email AS pd_email',
                'p_doctor.image AS pd_image',
                'p_doctor.token AS pd_token',
                'p_doctor.role AS pd_role',
                'p_doctor.status AS pd_status',
                'p_doctor.socket_id AS pd_socket_id'
            )
            .orderBy('c.created_time', 'desc');

        const seenChatIds = new Set();
        const seenPatientDoctor = new Set();
        const usersMap = new Map();
        const chatList = [];

        result.forEach(item => {
            if (seenChatIds.has(item.id)) return;
            seenChatIds.add(item.id);

            const pdKey = `${item.patientId}_${item.doctorId}`;
            if (seenPatientDoctor.has(pdKey)) return;
            seenPatientDoctor.add(pdKey);

            const profiles = [
                { id: item.pf_id, user_id: item.pf_user_id, first_name: item.pf_first_name, last_name: item.pf_last_name, email: item.pf_email, image: item.pf_image, token: item.pf_token, role: item.pf_role, status: item.pf_status, socket_id: item.pf_socket_id },
                { id: item.pt_id, user_id: item.pt_user_id, first_name: item.pt_first_name, last_name: item.pt_last_name, email: item.pt_email, image: item.pt_image, token: item.pt_token, role: item.pt_role, status: item.pt_status, socket_id: item.pt_socket_id },
                item.pp_id ? { id: item.pp_id, user_id: item.pp_user_id, first_name: item.pp_first_name, last_name: item.pp_last_name, email: item.pp_email, image: item.pp_image, token: item.pp_token, role: item.pp_role, status: item.pp_status, socket_id: item.pp_socket_id } : null,
                item.pd_id ? { id: item.pd_id, user_id: item.pd_user_id, first_name: item.pd_first_name, last_name: item.pd_last_name, email: item.pd_email, image: item.pd_image, token: item.pd_token, role: item.pd_role, status: item.pd_status, socket_id: item.pd_socket_id } : null,
            ].filter(Boolean);

            profiles.forEach(p => {
                if (p.user_id && p.user_id !== staff_id && !usersMap.has(p.user_id)) {
                    usersMap.set(p.user_id, p);
                }
            });

            chatList.push({
                id: item.id,
                from_id: item.from_id,
                to_id: item.to_id,
                patientId: item.patientId,
                doctorId: item.doctorId,
                message: item.message,
                created_time: item.created_time,
                messageType: item.messageType,
                attachment: item.attachment,
                type: item.type,
                is_read: item.is_read,
                is_chat: item.is_chat,
                status: item.status,
                iscaregiver: item.iscaregiver,
                metadata: item.metadata,
                role: item.role,
                chat_type: item.chat_type,
                appointment_id: item.appointment_id,
                chat_mode: item.chat_mode,
                clinic_id: item.clinic_id,
                department_id: item.department_id,
            });
        });

        return res.status(200).json({ status: true, users: Array.from(usersMap.values()), chatList });

    } catch (error) {
        console.error('Error in /chat-by-staff route:', error);
        return res.status(500).json({ status: false, message: 'An error occurred while processing the request.' });
    }
});




router.post('/chat-get-count', async (req, res) => {
    // return res.status(400).json({ status: false, message: 'Doctor ID is required' });
    const { patient_id } = req.body; // Use req.query for GET requests
    try {
        if (!patient_id) {
            return res.status(400).json({ status: false, message: 'Doctor ID is required' });
        }

        const query = await db('chat AS c')
            .join('profile AS p_from', 'c.from_id', 'p_from.user_id')
            .join('profile AS p_to', 'c.to_id', 'p_to.user_id')
            // .distinct('c.to_id')  // Get distinct `to_id` (doctor_id)
            .where('c.to_id', patient_id) // Filter by `patient_id`
        // .orWhere('c.to_id', patient_id);  // Filter by `patient_id`

        return res.status(200).json({ status: true, result: query }); // Return count of distinct doctor_id

    } catch (error) {
        console.error('Error in /chat-by-doctor route:', error);
        return res.status(500).json({ status: false, error: 'An error occurred while processing the request.' });
    }

});



module.exports = router;

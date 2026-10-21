require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const path = require('path');
const cors = require('cors');

const db = require('./db');
const { sendPushNotificationMessage } = require('./fcm');
const { registerChatHandlers, createCaseApiRouter } = require('./socketHandlers/chatHandler');

const roomsRouter = require('./routes/rooms');
const imagesRouter = require('./routes/images');
const VideosRouter = require('./routes/videoimages');
const ImageArray = require('./routes/ImageArray');
const inviteCaseRouter = createCaseApiRouter(db, sendPushNotificationMessage);

const app = express();
const server = http.createServer(app);
const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
const port = process.env.PORT || 3000;

db.raw('show tables')
  .then(() => console.log('Database connected!'))
  .catch((err) => console.error('Error connecting to database:', err));

app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/public/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/', roomsRouter);
app.use('/api/', imagesRouter);
app.use('/api/', VideosRouter);
app.use('/api/images/', ImageArray);
app.use('/api/', inviteCaseRouter);

async function handleFcmLogout(req, res) {
  const { user_id, token } = req.body;
  try {
    if (user_id) {
      const userTokens = await db('fcmtoken').where('user_id', user_id);

      if (userTokens?.length > 0) {
        const tokensToSend = userTokens.filter((t) => t.token && t.token !== token);

        if (tokensToSend.length > 0) {
          const messages = tokensToSend.map((t) => ({
            token: t.token,
            data: { ACTION: 'LOGOUT' },
          }));
          await sendPushNotificationMessage(messages);
        }

        if (token && token.trim() !== '') {
          await db('fcmtoken').where('user_id', user_id).update({ token });
          await db('profile').where('user_id', user_id).update({ token });
        }
      } else if (token && token.trim() !== '') {
        const exists = await db('fcmtoken').where({ user_id, token }).first();
        if (!exists) {
          await db('fcmtoken').insert({ user_id, token });
        }
      }
    }

    return res.status(200).json({ status: true, message: 'success' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: false, message: 'Internal server error' });
  }
}

app.post('/api/fcm-send-logout', handleFcmLogout);
app.post('/fcm-send-logout', handleFcmLogout);

function logSocketError(socketName, error, payload) {
  const row = {
    socket_name: socketName,
    error: error?.message || String(error),
  };
  if (payload !== undefined) {
    row.payload = JSON.stringify(payload);
  }
  db('logs_sockets').insert(row).catch(() => {});
}

const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT'],
    allowedHeaders: ['Content-Type'],
    credentials: true,
  },
});

const onlineUsers = new Set();

io.on('connection', (socket) => {
  registerChatHandlers(io, socket, db, sendPushNotificationMessage, baseUrl);

  socket.on('chat-status', async (data) => {
    const { messageId, status, fromUserId, toUserId } = data;

    try {
      if (status === 'READ') {
        await db('chat').where('id', messageId).update({ is_read: 1 });
      }

      await db('chat').where('id', messageId).update({ status });

      const payload = { messageId, status, fromUserId, toUserId };
      io.emit(`chat-status-${fromUserId}`, payload);
      io.emit(`chat-status-${toUserId}`, payload);
    } catch (e) {
      logSocketError(`chat-status-${fromUserId}`, e, data);
    }
  });

  socket.on('offer', (data) => {
    const { targetUserId, offerData, from, iceCandidates } = data;
    try {
      io.emit(`offer-${targetUserId}`, { offerData, from, targetUserId, iceCandidates });
    } catch (e) {
      logSocketError(`offer-${targetUserId}`, e);
    }
  });

  socket.on('make-offer', (data) => {
    const { targetUserId, from } = data;
    try {
      io.emit(`make-offer-${targetUserId}`, { from, targetUserId });
    } catch (e) {
      logSocketError(`make-offer-${targetUserId}`, e);
    }
  });

  socket.on('offer-acknowledgment', (data) => {
    const { from, targetUserId, offerData } = data;
    try {
      io.emit(`offer-acknowledgment-${targetUserId}`, { offer: offerData, from, targetUserId });
    } catch (e) {
      logSocketError(`offer-acknowledgment-${targetUserId}`, e);
    }
  });

  socket.on('answer', (data) => {
    const { targetUserId, answerData, from } = data;
    try {
      io.emit(`answer-${targetUserId}`, { answerData, from, targetUserId });
    } catch (e) {
      logSocketError(`answer-${targetUserId}`, e);
    }
  });

  socket.on('ice-candidate', (data) => {
    const { from, targetUserId, iceCandidateData } = data;
    try {
      io.emit(`ice-candidate-${targetUserId}`, { iceCandidateData, from, targetUserId });
    } catch (e) {
      logSocketError(`ice-candidate-${targetUserId}`, e);
    }
  });

  socket.on('message', async (data, ackCallback) => {
    try {
      const { from, to, message, messageType, attachment, iscaregiver, metadata } = data;
      const utcDateString = new Date().toISOString();

      const [fromU, toU] = await Promise.all([
        db('profile').where('user_id', from).first(),
        db('profile').where('user_id', to).first(),
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
        messageType,
        iscaregiver,
        type: messageType,
        metadata: metadata ? JSON.stringify(metadata) : '',
        is_read: '1',
        is_chat: '1',
      };

      const [insertedMessage] = await db('chat').insert(chatNew);
      const id = insertedMessage;

      if (typeof ackCallback === 'function') {
        ackCallback("{'msgId':" + id + '}');
      }

      const userTokens = await db('fcmtoken').where('user_id', to).select('token');
      const data1 = {
        data: {
          fromUser: from,
          toUser: to,
          ACTION: 'MESSAGE',
          insertedMessage: parseInt(id),
          messageType,
          attachment: attachment && attachment.length > 0 ? attachment : null,
          message,
          metadata: JSON.stringify(metadata),
        },
      };

      const messages = userTokens.map((tokenObject) => ({
        token: tokenObject.token,
        data: {
          DocotorName: JSON.stringify(fromU.first_name + ' ' + fromU.last_name),
          fromUser: JSON.stringify(data1.data.fromUser),
          toUser: JSON.stringify(data1.data.toUser),
          ACTION: JSON.stringify(data1.data.ACTION),
          insertedMessage: JSON.stringify(data1.data.insertedMessage),
          messageType: JSON.stringify(data1.data.messageType),
          attachment: data1.data.attachment ? JSON.stringify(data1.data.attachment) : null,
          message: JSON.stringify(data1.data.message),
          metadata: JSON.stringify(metadata),
        },
      }));

      await sendPushNotificationMessage(messages);

      const emitPayload = {
        message,
        from: JSON.stringify(fromU),
        to: JSON.stringify(toU),
        ACTION: 'MESSAGE',
        insertedMessage: parseInt(id),
        metadata,
        messageType,
        attachment,
      };

      io.emit('notification-success', emitPayload);
      io.emit(`offer-acknowledgment-${to}`, { insertedMessage: parseInt(insertedMessage) });
      io.emit('pushnotification', { data1: data1.data });
      io.emit(`receive-message-${to}`, emitPayload);
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
      logSocketError(`call-status-${targetUserId}`, e);
    }
  });

  socket.on('call-offer', async (data, ackCallback) => {
    try {
      const { doc_id, patient_id, customData, staff_id } = data;
      const customData1 = JSON.parse(customData);

      const [fromU, toU, patintData, doctorData] = await Promise.all([
        db('profile')
          .where('user_id', customData1.fromUser)
          .select(db.raw("CONCAT(first_name, ' ', last_name) as name"), 'id', 'user_id')
          .first(),
        db('profile')
          .where('user_id', customData1.toUser)
          .select(db.raw("CONCAT(first_name, ' ', last_name) as name"), 'id', 'user_id')
          .first(),
        db('profile')
          .where('user_id', patient_id)
          .select(db.raw("CONCAT(first_name, ' ', last_name) as name"), 'id', 'user_id')
          .first(),
        db('profile')
          .where('user_id', doc_id)
          .select(db.raw("CONCAT(first_name, ' ', last_name) as name"), 'id', 'user_id')
          .first(),
      ]);

      const userTokens = await db('fcmtoken').where('user_id', customData1?.toUser).select('token');

      const data1 = {
        patienr: patintData,
        doctor: doctorData,
        staff_id: staff_id ?? '',
        doc_id,
        patient_id,
        customData: customData1,
        ACTION: 'CALL',
      };

      io.emit('notification-success', {
        data: data1,
        from: customData1?.fromUser,
        to: customData1?.toUser,
        ACTION: 'CALL',
      });
      io.emit('pushnotification', { data: data1 });
      io.emit(`call-offer-${customData1.toUser}`, { data: data1 });

      const messages = userTokens.map((tokenObject) => ({
        token: tokenObject.token,
        data: {
          patienr: JSON.stringify({
            name: patintData?.name,
            user_id: patintData?.user_id,
          }),
          doctor: JSON.stringify({
            name: doctorData?.name,
            user_id: doctorData?.user_id,
          }),
          doc_id: String(doc_id ?? ''),
          staff_id: String(staff_id ?? ''),
          patient_id: String(patient_id ?? ''),
          customData: JSON.stringify({
            appointment: customData1.appointment,
            RoomID: customData1.RoomID,
            fromUser: customData1.fromUser,
            toUser: customData1.toUser,
            isVideo: customData1.isVideo,
          }),
          ACTION: 'CALL',
        },
      }));

      await sendPushNotificationMessage(messages);

      if (typeof ackCallback === 'function') {
        ackCallback("{'call':" + '1' + '}');
      }
    } catch (error) {
      console.error('Error:', error);
      io.emit('notification-error', { status: false, message: 'Error processing request' });
    }
  });

  socket.on('camera-switch', async (data) => {
    try {
      const customData1 = JSON.parse(data.customData);
      io.emit(`camera-switch-${customData1.toUser}`, { data });
    } catch (error) {
      console.error('Error:', error);
      io.emit('notification-error', { status: false, message: 'Error processing request' });
    }
  });

  socket.on('message-status', async (data) => {
    try {
      const { message_status, from, to, msgId } = data;

      const [fromU, toU] = await Promise.all([
        db('profile').where('user_id', from).first(),
        db('profile').where('user_id', to).first(),
      ]);

      if (!fromU || !toU) {
        const errorMsg = !fromU ? 'From User not found' : 'To User not found';
        io.emit('notification-error', { status: false, message: errorMsg });
        return;
      }

      const data1 = {
        data: {
          fromUser: fromU,
          toUser: toU,
          ACTION: 'MESSAGE_STATUS',
          is_read: message_status,
          msgId,
        },
        registration_ids: [toU.token],
      };

      const tokens = (data1.registration_ids || []).filter(Boolean);
      if (tokens.length > 0) {
        await sendPushNotificationMessage(
          tokens.map((token) => ({
            token,
            data: data1.data,
          }))
        );
      } else {
        console.log('No tokens to send');
      }

      await db('chat').where({ id: msgId }).update({ is_read: '0' });

      io.emit('notification-success', {
        from: fromU,
        to: toU,
        msgId,
        ACTION: 'MESSAGE_STATUS',
      });
      io.emit('pushnotification', { data1 });
      io.emit(`message-status-${to}`, { data });
    } catch (error) {
      console.error(`Error updating statuses in the database: ${error}`);
    }
  });

  socket.on('userStatus', async (data) => {
    const { userId } = data;
    try {
      onlineUsers.add(socket.id);
      await db('profile').where({ user_id: userId }).update({ socket_id: socket.id, status: 'isActive' });
      io.emit(`userOnline-${userId}`, { isActive: true, userId });
    } catch (error) {
      console.error(`Error updating statuses in the database: ${error.message}`);
    }
  });

  socket.on('userStatusCheck', async (data, ackCallback) => {
    const { userId } = data;
    try {
      onlineUsers.add(socket.id);
      const statusCheck = await db('profile').where({ user_id: userId });
      if (typeof ackCallback === 'function') {
        ackCallback({ statusCheck });
      }
      io.emit(`statusCheck-${userId}`, { statusCheck });
    } catch (error) {
      console.error(`Error updating statuses in the database: ${error.message}`);
    }
  });

  socket.on('chat-history', async (data) => {
    const { from, to } = data;

    try {
      if (!from || !to) {
        throw new Error('Invalid parameters');
      }

      const query = await db('chat AS c')
        .join('profile AS p_from', 'c.from_id', 'p_from.user_id')
        .join('profile AS p_to', 'c.to_id', 'p_to.user_id')
        .select(
          'c.*',
          'p_from.user_id AS from_user_id',
          'p_from.first_name AS from_first_name',
          'p_from.last_name AS from_last_name',
          'p_to.user_id AS to_user_id',
          'p_to.first_name AS to_first_name',
          'p_to.last_name AS to_last_name'
        )
        .where(function () {
          this.where(function () {
            this.where('from_id', from).andWhere('to_id', to);
          }).orWhere(function () {
            this.where('from_id', to).andWhere('to_id', from);
          });
        })
        .orderBy('c.id', 'desc');

      io.emit(`chat-history-${from}-${to}`, { history: query });
    } catch (error) {
      console.error('Error fetching chat history:', error);
      io.emit(`chat-history-${from}-${to}`, {
        message: 'Error in fetching chat history',
        error: error.message,
      });
    }
  });

  socket.on('chat-history-doc-pat', async (data) => {
    const { patientId, doctorId } = data;

    try {
      if (!patientId || !doctorId) {
        throw new Error('patientId and doctorId are required');
      }

      const query = await db('chat AS c')
        .join('profile AS p_from', 'p_from.user_id', 'c.from_id')
        .join('profile AS p_to', 'p_to.user_id', 'c.to_id')
        .leftJoin('profile AS p_patient', 'p_patient.user_id', 'c.patientId')
        .leftJoin('profile AS p_doctor', 'p_doctor.user_id', 'c.doctorId')
        .where('c.patientId', patientId)
        .andWhere('c.doctorId', doctorId)
        .whereNotNull('c.patientId')
        .whereNotNull('c.doctorId')
        .select(
          'c.*',
          'p_from.user_id AS from_user_id',
          'p_from.first_name AS from_first_name',
          'p_from.last_name AS from_last_name',
          'p_to.user_id AS to_user_id',
          'p_to.first_name AS to_first_name',
          'p_to.last_name AS to_last_name'
        )
        .orderBy('c.id', 'desc');

      io.emit(`chat-history-doc-pat-${patientId}-${doctorId}`, { history: query });
    } catch (error) {
      console.error('Error fetching chat history:', error);
      io.emit(`chat-history-doc-pat-${patientId}-${doctorId}`, {
        message: 'Error in fetching chat history',
        error: error.message,
      });
    }
  });

  socket.on('room-details', async (data) => {
    try {
      const { roomID } = data;
      const meetingsUsers = await db('meeting')
        .join('profile', 'meeting.user_id', 'profile.user_id')
        .where({ 'meeting.room_id': roomID })
        .select('*');

      io.emit(`room-details-${roomID}`, {
        data,
        meetingsUsers,
        ACTION: 'JOIN',
      });
    } catch (error) {
      console.error(`Error in room-details for room ${data.roomID}:`, error);
      socket.emit(`room-join-detail-error-${data.roomID}`, {
        error: error.message || 'Something went wrong while joining the room.',
      });
    }
  });

  socket.on('room-join', async (data) => {
    try {
      const { roomID, userId, agoraUid } = data;

      const meeting = await db('meeting')
        .where({ user_id: userId, room_id: roomID, agoraUid })
        .first();

      if (!meeting) {
        await db('meeting').insert({
          user_id: userId,
          room_id: roomID,
          agoraUid,
        });
      }

      const meetingsUsers = await db('meeting')
        .join('profile', 'meeting.user_id', 'profile.user_id')
        .where({ 'meeting.room_id': roomID })
        .select('*');

      io.emit(`room-join-${roomID}`, {
        data,
        meetingsUsers,
        ACTION: 'JOIN',
      });
    } catch (error) {
      console.error(`Error in room-join for room ${data.roomID}:`, error);
      socket.emit('room-join-error-inf', {
        error: error.message || 'Something went wrong while joining the room.',
      });
    }
  });

  socket.on('room-join-user', async (data) => {
    try {
      const { agoraUid } = data;
      const meetingsUsers = await db('meeting')
        .join('profile', 'meeting.user_id', 'profile.user_id')
        .where({ 'meeting.agoraUid': agoraUid })
        .select('*');

      io.emit(`room-join-user-${agoraUid}`, {
        meetingsUsers,
        ACTION: 'JOIN',
      });
    } catch (error) {
      console.error('Error room-join-user:', error);
      socket.emit('room-join-error}', {
        error: error.message || 'Something went wrong while joining the room.',
      });
    }
  });

  socket.on('test', (data) => {
    io.emit('test-success', { data });
  });

  socket.on('disconnect', async () => {
    onlineUsers.delete(socket.id);
    const profileData = await db('profile').where({ socket_id: socket.id }).first();

    if (!profileData?.user_id) {
      return;
    }

    const userId = profileData.user_id;
    await db('profile').where({ socket_id: socket.id }).update({ status: 'isDeactive' });

    const data = {
      data: {
        userId,
        ACTION: 'DISCONNECTED',
      },
      registration_ids: [profileData.token],
    };

    try {
      const tokens = (data.registration_ids || []).filter(Boolean);
      if (tokens.length > 0) {
        await sendPushNotificationMessage(
          tokens.map((token) => ({
            token,
            data: data.data,
          }))
        );
      } else {
        console.log('No tokens to send');
      }

      io.emit(`userOffline-${userId}`, { isActive: false, userId });
      io.emit('notification-success', { userId, ACTION: 'MESSAGE_STATUS' });
      io.emit('pushnotification', { data1: data });
    } catch (error) {
      console.error(error);
    }
  });
});

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

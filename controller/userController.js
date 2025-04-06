const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const User = require('../model/user');

// Memory maps to track states
const activeUsers = new Map();        // userId -> socketId
const socketToUser = new Map();       // socketId -> userId
const meetings = new Map();           // meetingId -> Map(userId -> videoCallId)

function socketHandlers(io) {
  io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Authenticate user via socket
    socket.on('authenticate', async ({ token }) => {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;
        let user = await User.findById(userId);

        // Assign videoCallId if not already set
        if (!user.videoCallId) {
          user.videoCallId = uuidv4();
          await user.save();
        }

        // Save associations
        activeUsers.set(userId, socket.id);
        socketToUser.set(socket.id, userId);

        await User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: new Date() });

        console.log(`User ${userId} authenticated with socket ${socket.id}`);
        socket.emit('authenticated', { success: true, videoCallId: user.videoCallId });
      } catch (err) {
        console.error('Authentication failed:', err.message);
        socket.emit('authenticated', { success: false, message: 'Invalid token' });
      }
    });

    // Create new meeting
    socket.on('create-meeting', () => {
      const meetingId = uuidv4();
      meetings.set(meetingId, new Map());
      console.log(`Meeting ${meetingId} created`);
      socket.emit('meeting-created', { meetingId });
    });

    // Join meeting
    socket.on('join-meeting', async ({ meetingId, token }) => {
      if (!meetings.has(meetingId)) {
        return socket.emit('join-failed', { message: 'Meeting does not exist' });
      }

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;
        let user = await User.findById(userId);

        if (!user.videoCallId) {
          user.videoCallId = uuidv4();
          await user.save();
        }

        const currentMeeting = meetings.get(meetingId);

        // Prevent duplicate join
        if (currentMeeting.has(userId)) {
          return socket.emit('join-failed', { message: 'User already in meeting' });
        }

        const existingUsers = [];
        for (const [otherUserId, otherVideoCallId] of currentMeeting.entries()) {
          if (otherUserId !== userId) {
            existingUsers.push(otherVideoCallId);
          }
        }

        // Add user to meeting
        currentMeeting.set(userId, user.videoCallId);
        socket.join(meetingId);

        console.log(`User ${userId} joined meeting ${meetingId} as ${user.videoCallId}`);

        // Notify others (not including self)
        socket.to(meetingId).emit('user-joined', {
          userId,
          videoCallId: user.videoCallId,
          meetingId,
        });

        // Notify self about existing users
        socket.emit('user-joined', {
          userId,
          videoCallId: user.videoCallId,
          meetingId,
          existingUsers,
        });

      } catch (err) {
        console.error('Join meeting failed:', err.message);
        socket.emit('join-failed', { message: 'Invalid token' });
      }
    });

    // Leave meeting manually
    socket.on("leave-meeting", ({ meetingId }) => {
      const userId = socketToUser.get(socket.id);
      if (!userId || !meetings.has(meetingId)) return;

      const participants = meetings.get(meetingId);
      const videoCallId = participants.get(userId);

      if (participants && participants.has(userId)) {
        participants.delete(userId);
        socket.leave(meetingId);
        io.to(meetingId).emit('user-left', { userId, videoCallId });

        if (participants.size === 0) {
          meetings.delete(meetingId);
          console.log(`Meeting ${meetingId} ended (empty)`);
        }
      }
    });

    // Handle WebRTC signaling - add these handlers
    socket.on('offer', async ({ target, offer }) => {
      console.log(`Relaying offer to ${target}`);
      
      // Find the socket ID for the target user
      const targetUserId = await findUserIdByVideoCallId(target);
      if (!targetUserId) return;
      
      const targetSocketId = activeUsers.get(targetUserId);
      if (!targetSocketId) return;
      
      // Get the sender's videoCallId
      const senderId = socketToUser.get(socket.id);
      if (!senderId) return;
      
      // Find which meeting they're both in
      let inSameMeeting = false;
      meetings.forEach((participants) => {
        if (participants.has(senderId) && participants.has(targetUserId)) {
          inSameMeeting = true;
        }
      });
      
      if (!inSameMeeting) return;
      
      const senderVideoCallId = await getVideoCallIdByUserId(senderId);
      
      // Relay the offer to the target
      io.to(targetSocketId).emit('offer', {
        sender: senderVideoCallId,
        offer
      });
    });

    socket.on('answer', async ({ target, answer }) => {
      console.log(`Relaying answer to ${target}`);
      
      // Find the socket ID for the target user
      const targetUserId = await findUserIdByVideoCallId(target);
      if (!targetUserId) return;
      
      const targetSocketId = activeUsers.get(targetUserId);
      if (!targetSocketId) return;
      
      // Get the sender's videoCallId
      const senderId = socketToUser.get(socket.id);
      if (!senderId) return;
      
      const senderVideoCallId = await getVideoCallIdByUserId(senderId);
      
      // Relay the answer to the target
      io.to(targetSocketId).emit('answer', {
        sender: senderVideoCallId,
        answer
      });
    });

    socket.on('ice-candidate', async ({ target, candidate }) => {
      console.log(`Relaying ICE candidate to ${target}`);
      
      // Find the socket ID for the target user
      const targetUserId = await findUserIdByVideoCallId(target);
      if (!targetUserId) return;
      
      const targetSocketId = activeUsers.get(targetUserId);
      if (!targetSocketId) return;
      
      // Get the sender's videoCallId
      const senderId = socketToUser.get(socket.id);
      if (!senderId) return;
      
      const senderVideoCallId = await getVideoCallIdByUserId(senderId);
      
      // Relay the ICE candidate to the target
      io.to(targetSocketId).emit('ice-candidate', {
        sender: senderVideoCallId,
        candidate
      });
    });

    // On socket disconnect
    socket.on('disconnect', async () => {
      console.log('Client disconnected:', socket.id);
      const userId = socketToUser.get(socket.id);
      if (!userId) return;

      activeUsers.delete(userId);
      socketToUser.delete(socket.id);

      await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() });

      meetings.forEach((participants, meetingId) => {
        if (participants.has(userId)) {
          const videoCallId = participants.get(userId);
          participants.delete(userId);
          io.to(meetingId).emit('user-left', { userId, videoCallId });

          if (participants.size === 0) {
            meetings.delete(meetingId);
            console.log(`Meeting ${meetingId} ended (empty after disconnect)`);
          }
        }
      });
    });
  });
}

// Helper functions for WebRTC signaling
async function findUserIdByVideoCallId(videoCallId) {
  const user = await User.findOne({ videoCallId });
  return user ? user._id.toString() : null;
}

async function getVideoCallIdByUserId(userId) {
  const user = await User.findById(userId);
  return user ? user.videoCallId : null;
}

// ---------- HTTP Controllers ----------

async function createMeeting(req, res) {
  try {
    const meetingId = uuidv4();
    meetings.set(meetingId, new Map());
    return res.json({ success: true, meetingId });
  } catch (err) {
    console.error('Error creating meeting:', err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

async function joinMeeting(req, res) {
  const { meetingId } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];

  if (!meetings.has(meetingId)) {
    return res.status(400).json({ success: false, message: 'Meeting not found' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id;

    const user = await User.findById(userId);
    if (!user.videoCallId) {
      user.videoCallId = uuidv4();
      await user.save();
    }

    const participants = meetings.get(meetingId);
    if (!participants.has(userId)) {
      participants.set(userId, user.videoCallId);
    }

    return res.json({
      success: true,
      message: 'Meeting joined',
      meetingId,
      videoCallId: user.videoCallId,
    });
  } catch (err) {
    console.error('Join meeting error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

module.exports = { socketHandlers, createMeeting, joinMeeting };
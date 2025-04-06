const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const User = require('../model/user');

// Memory maps to track states
const activeUsers = new Map();        // userId -> socketId
const socketToUser = new Map();       // socketId -> userId
const meetings = new Map();           // meetingId -> Map(userId -> videoCallId)
const videoCallIdToUserId = new Map(); // videoCallId -> userId (for quick lookup)

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
        videoCallIdToUserId.set(user.videoCallId, userId);

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
        meetings.set(meetingId, new Map()); // Create meeting if it doesn't exist
        console.log(`Meeting ${meetingId} created on join`);
      }

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;
        let user = await User.findById(userId);

        if (!user.videoCallId) {
          user.videoCallId = uuidv4();
          await user.save();
        }

        // Update mapping
        videoCallIdToUserId.set(user.videoCallId, userId);

        const currentMeeting = meetings.get(meetingId);

        // Prevent duplicate join
        if (currentMeeting.has(userId)) {
          console.log(`User ${userId} already in meeting ${meetingId}`);
          return socket.emit('join-failed', { message: 'User already in meeting' });
        }

        console.log(`Current meeting participants: ${JSON.stringify([...currentMeeting.keys()])}`);
        
        const existingUsers = [];
        for (const [otherUserId, otherVideoCallId] of currentMeeting.entries()) {
          if (otherUserId !== userId) {
            existingUsers.push(otherVideoCallId);
            console.log(`Adding existing user ${otherUserId} with videoCallId ${otherVideoCallId}`);
          }
        }

        // Add user to meeting
        currentMeeting.set(userId, user.videoCallId);
        socket.join(meetingId);

        console.log(`User ${userId} joined meeting ${meetingId} as ${user.videoCallId}`);
        console.log(`Existing users for ${userId}: ${JSON.stringify(existingUsers)}`);

        // Notify others (not including self)
        socket.to(meetingId).emit('user-joined', {
          userId: userId.toString(),
          videoCallId: user.videoCallId,
          meetingId,
        });

        // Notify self about existing users
        socket.emit('user-joined', {
          userId: userId.toString(),
          videoCallId: user.videoCallId,
          meetingId,
          existingUsers,
          totalParticipants: currentMeeting.size
        });

        // Broadcast updated participant count to all in the meeting
        io.to(meetingId).emit('participants-update', {
          count: currentMeeting.size,
          users: Array.from(currentMeeting.values()) // Send all videoCallIds
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

        // Broadcast updated participant count
        io.to(meetingId).emit('participants-update', {
          count: participants.size,
          users: Array.from(participants.values())
        });

        if (participants.size === 0) {
          meetings.delete(meetingId);
          console.log(`Meeting ${meetingId} ended (empty)`);
        }
      }
    });

    // Debug endpoint to get meeting info
    socket.on('get-meeting-info', ({ meetingId }) => {
      if (!meetings.has(meetingId)) {
        return socket.emit('meeting-info', { exists: false });
      }
      
      const participants = meetings.get(meetingId);
      const users = [];
      
      for (const [userId, videoCallId] of participants.entries()) {
        users.push({ userId, videoCallId });
      }
      
      socket.emit('meeting-info', {
        exists: true,
        meetingId,
        participantCount: participants.size,
        users
      });
    });

    // Handle WebRTC signaling
    socket.on('offer', async ({ target, offer }) => {
      console.log(`Relaying offer to ${target}`);
      
      // Find the socket ID for the target user
      const targetUserId = videoCallIdToUserId.get(target);
      if (!targetUserId) {
        console.error(`Could not find userId for videoCallId ${target}`);
        return;
      }
      
      const targetSocketId = activeUsers.get(targetUserId);
      if (!targetSocketId) {
        console.error(`Could not find socketId for userId ${targetUserId}`);
        return;
      }
      
      // Get the sender's videoCallId
      const senderId = socketToUser.get(socket.id);
      if (!senderId) {
        console.error(`Could not find userId for socket ${socket.id}`);
        return;
      }
      
      const senderVideoCallId = await getVideoCallIdByUserId(senderId);
      
      console.log(`Sending offer from ${senderVideoCallId} to ${target}`);
      
      // Relay the offer to the target
      io.to(targetSocketId).emit('offer', {
        sender: senderVideoCallId,
        offer
      });
    });

    socket.on('answer', async ({ target, answer }) => {
      console.log(`Relaying answer to ${target}`);
      
      // Find the socket ID for the target user
      const targetUserId = videoCallIdToUserId.get(target);
      if (!targetUserId) {
        console.error(`Could not find userId for videoCallId ${target}`);
        return;
      }
      
      const targetSocketId = activeUsers.get(targetUserId);
      if (!targetSocketId) {
        console.error(`Could not find socketId for userId ${targetUserId}`);
        return;
      }
      
      // Get the sender's videoCallId
      const senderId = socketToUser.get(socket.id);
      if (!senderId) {
        console.error(`Could not find userId for socket ${socket.id}`);
        return;
      }
      
      const senderVideoCallId = await getVideoCallIdByUserId(senderId);
      
      console.log(`Sending answer from ${senderVideoCallId} to ${target}`);
      
      // Relay the answer to the target
      io.to(targetSocketId).emit('answer', {
        sender: senderVideoCallId,
        answer
      });
    });

    socket.on('ice-candidate', async ({ target, candidate }) => {
      console.log(`Relaying ICE candidate to ${target}`);
      
      // Find the socket ID for the target user
      const targetUserId = videoCallIdToUserId.get(target);
      if (!targetUserId) {
        console.error(`Could not find userId for videoCallId ${target}`);
        return;
      }
      
      const targetSocketId = activeUsers.get(targetUserId);
      if (!targetSocketId) {
        console.error(`Could not find socketId for userId ${targetUserId}`);
        return;
      }
      
      // Get the sender's videoCallId
      const senderId = socketToUser.get(socket.id);
      if (!senderId) {
        console.error(`Could not find userId for socket ${socket.id}`);
        return;
      }
      
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

      // Clean up user's videoCallId mapping
      const user = await User.findById(userId);
      if (user && user.videoCallId) {
        videoCallIdToUserId.delete(user.videoCallId);
      }

      activeUsers.delete(userId);
      socketToUser.delete(socket.id);

      await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() });

      meetings.forEach((participants, meetingId) => {
        if (participants.has(userId)) {
          const videoCallId = participants.get(userId);
          participants.delete(userId);
          io.to(meetingId).emit('user-left', { userId, videoCallId });

          // Broadcast updated participant count
          io.to(meetingId).emit('participants-update', {
            count: participants.size,
            users: Array.from(participants.values())
          });

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
    // Create the meeting if it doesn't exist
    meetings.set(meetingId, new Map());
    console.log(`Meeting ${meetingId} created during HTTP join`);
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id;

    const user = await User.findById(userId);
    if (!user.videoCallId) {
      user.videoCallId = uuidv4();
      await user.save();
    }

    // Update mapping
    videoCallIdToUserId.set(user.videoCallId, userId);

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
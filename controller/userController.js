const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const User = require('../model/user');

// Data structures to track active connections
const activeUsers = new Map();         // userId -> socketId
const socketToUser = new Map();        // socketId -> userId
const meetings = new Map();            // meetingId -> Set of userIds

function socketHandlers(io) {
  io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Authenticate user and associate with socket
    socket.on('authenticate', async ({ token }) => {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;
        
        // Update user mappings
        activeUsers.set(userId, socket.id);
        socketToUser.set(socket.id, userId);
        
        // Generate or update videoCallId
        const videoCallId = uuidv4();
        await User.findByIdAndUpdate(userId, { 
          isOnline: true, 
          lastSeen: new Date(),
          videoCallId
        });

        console.log(`User ${userId} authenticated with socket ${socket.id}`);
        socket.emit('authenticated', { 
          success: true,
          userId,
          videoCallId
        });
      } catch (err) {
        console.error('Authentication failed:', err.message);
        socket.emit('authenticated', { 
          success: false, 
          message: 'Invalid token' 
        });
      }
    });

    // Join or create a meeting
    socket.on('join-meeting', async ({ meetingId }) => {
      try {
        const userId = socketToUser.get(socket.id);
        if (!userId) {
          throw new Error('User not authenticated');
        }

        // Get user details
        const user = await User.findById(userId);
        if (!user) {
          throw new Error('User not found');
        }

        // Get or create meeting
        if (!meetings.has(meetingId)) {
          meetings.set(meetingId, new Set());
          console.log(`New meeting ${meetingId} created`);
        }

        const meeting = meetings.get(meetingId);
        
        // Add user to meeting if not already present
        if (!meeting.has(userId)) {
          meeting.add(userId);
          socket.join(meetingId);
          console.log(`User ${userId} joined meeting ${meetingId}`);
        }

        // Get existing participants (excluding self)
        const existingUsers = Array.from(meeting)
          .filter(id => id !== userId)
          .map(id => {
            return { userId: id };
          });

        // Notify others about new participant
        socket.to(meetingId).emit('user-joined', {
          userId,
          videoCallId: user.videoCallId
        });

        // Respond to joiner with existing participants
        socket.emit('meeting-joined', {
          meetingId,
          yourId: user.videoCallId,
          existingUsers,
          participantCount: meeting.size
        });

      } catch (err) {
        console.error('Join meeting error:', err.message);
        socket.emit('meeting-error', { 
          message: err.message 
        });
      }
    });

    // Leave meeting
    socket.on('leave-meeting', ({ meetingId }) => {
      const userId = socketToUser.get(socket.id);
      if (!userId || !meetings.has(meetingId)) return;

      const meeting = meetings.get(meetingId);
      if (meeting.has(userId)) {
        meeting.delete(userId);
        socket.leave(meetingId);
        
        // Notify others
        socket.to(meetingId).emit('user-left', { userId });
        
        // Clean up empty meetings
        if (meeting.size === 0) {
          meetings.delete(meetingId);
          console.log(`Meeting ${meetingId} ended (no participants)`);
        }
      }
    });

    // WebRTC Signaling - simplified and more reliable
    socket.on('offer', ({ to, offer }) => {
      const targetSocketId = activeUsers.get(to);
      if (!targetSocketId) {
        console.error(`Target user ${to} not found`);
        return;
      }
      
      const fromUserId = socketToUser.get(socket.id);
      if (!fromUserId) {
        console.error('Sender not authenticated');
        return;
      }

      io.to(targetSocketId).emit('offer', {
        from: fromUserId,
        offer
      });
    });

    socket.on('answer', ({ to, answer }) => {
      const targetSocketId = activeUsers.get(to);
      if (!targetSocketId) {
        console.error(`Target user ${to} not found`);
        return;
      }

      const fromUserId = socketToUser.get(socket.id);
      if (!fromUserId) {
        console.error('Sender not authenticated');
        return;
      }

      io.to(targetSocketId).emit('answer', {
        from: fromUserId,
        answer
      });
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
      const targetSocketId = activeUsers.get(to);
      if (!targetSocketId) {
        console.error(`Target user ${to} not found`);
        return;
      }

      const fromUserId = socketToUser.get(socket.id);
      if (!fromUserId) {
        console.error('Sender not authenticated');
        return;
      }

      io.to(targetSocketId).emit('ice-candidate', {
        from: fromUserId,
        candidate
      });
    });

    // Clean up on disconnect
    socket.on('disconnect', () => {
      const userId = socketToUser.get(socket.id);
      if (!userId) return;

      // Leave all meetings this user was in
      meetings.forEach((meetingUsers, meetingId) => {
        if (meetingUsers.has(userId)) {
          meetingUsers.delete(userId);
          io.to(meetingId).emit('user-left', { userId });
          
          if (meetingUsers.size === 0) {
            meetings.delete(meetingId);
          }
        }
      });

      // Clean up user mappings
      activeUsers.delete(userId);
      socketToUser.delete(socket.id);
      
      // Mark user as offline
      User.findByIdAndUpdate(userId, { 
        isOnline: false,
        lastSeen: new Date() 
      }).catch(console.error);
      
      console.log(`User ${userId} disconnected`);
    });
  });
}

// HTTP Controllers
async function createMeeting(req, res) {
  try {
    const meetingId = uuidv4();
    meetings.set(meetingId, new Set());
    return res.json({ 
      success: true, 
      meetingId,
      message: 'Meeting created successfully'
    });
  } catch (err) {
    console.error('Error creating meeting:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to create meeting' 
    });
  }
}

module.exports = { socketHandlers, createMeeting };
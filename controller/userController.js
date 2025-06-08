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
        
        await User.findByIdAndUpdate(userId, { 
          isOnline: true, 
          lastSeen: new Date(),
          videoCallId: uuidv4() // Generate a new videoCallId on each auth
        });

        console.log(`User ${userId} authenticated with socket ${socket.id}`);
        socket.emit('authenticated', { success: true });
      } catch (err) {
        console.error('Authentication failed:', err.message);
        socket.emit('authenticated', { success: false, message: 'Invalid token' });
      }
    });

    // Join a meeting (creates if doesn't exist)
    socket.on('join-meeting', async ({ meetingId, token }) => {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;
        
        if (!socketToUser.has(socket.id)) {
          throw new Error('User not authenticated');
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

        // Get user details for signaling
        const user = await User.findById(userId);
        
        // Get existing participants (excluding self)
        const participants = Array.from(meeting)
          .filter(id => id !== userId)
          .map(async id => {
            const participant = await User.findById(id);
            return participant.videoCallId;
          });
        const existingUsers = await Promise.all(participants);

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
        socket.emit('meeting-error', { message: err.message });
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

    // WebRTC Signaling
    socket.on('offer', ({ to, offer }) => {
      const targetSocketId = activeUsers.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('offer', {
          from: socketToUser.get(socket.id),
          offer
        });
      }
    });

    socket.on('answer', ({ to, answer }) => {
      const targetSocketId = activeUsers.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('answer', {
          from: socketToUser.get(socket.id),
          answer
        });
      }
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
      const targetSocketId = activeUsers.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('ice-candidate', {
          from: socketToUser.get(socket.id),
          candidate
        });
      }
    });

    // Clean up on disconnect
    socket.on('disconnect', () => {
      const userId = socketToUser.get(socket.id);
      if (userId) {
        activeUsers.delete(userId);
        socketToUser.delete(socket.id);
        
        // Mark user as offline
        User.findByIdAndUpdate(userId, { 
          isOnline: false,
          lastSeen: new Date() 
        }).catch(console.error);
        
        console.log(`User ${userId} disconnected`);
      }
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
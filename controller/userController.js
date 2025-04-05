const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const User = require('../model/user');

// Track active users and their socket IDs
const activeUsers = new Map(); // userId -> socketId
const socketToUser = new Map(); // socketId -> userId
const meetings = new Map(); // meetingId -> Map(userId -> videoCallId)

function socketHandlers(io) {
  io.on('connection', (socket) => {
    console.log('New client connected', socket.id);
    
    // User authentication via socket
    socket.on('authenticate', async ({ token }) => {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;
        
        // Fetch user's unique videoCallId
        const user = await User.findById(userId);
        const videoCallId = user.videoCallId || uuidv4(); // Assign if not present

        // Associate socket with user
        activeUsers.set(userId, socket.id);
        socketToUser.set(socket.id, userId);
        
        // Update user's online status
        await User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: new Date() });
        
        console.log(`User ${userId} authenticated with socket ${socket.id}`);
        socket.emit('authenticated', { success: true, videoCallId });
      } catch (err) {
        console.error('Authentication error:', err);
        socket.emit('authenticated', { success: false, message: 'Invalid token' });
      }
    });

    // Create a new meeting
    socket.on('create-meeting', async () => {
      const meetingId = uuidv4();
      meetings.set(meetingId, new Map()); // Initialize meeting with empty user map
      console.log(`Meeting ${meetingId} created`);
      socket.emit('meeting-created', { meetingId });
    });

    // Join a meeting
    socket.on('join-meeting', async ({ meetingId, token }) => {
      if (!meetings.has(meetingId)) {
        return socket.emit('join-failed', { message: 'Meeting does not exist' });
      }

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;

        // Fetch user's unique videoCallId
        const user = await User.findById(userId);
        const videoCallId = user.videoCallId || uuidv4(); // Assign if not present

        // Add user to meeting bucket
        meetings.get(meetingId).set(userId, videoCallId);
        socket.join(meetingId);

        console.log(`User ${userId} (VideoCall ID: ${videoCallId}) joined meeting ${meetingId}`);
        io.to(meetingId).emit('user-joined', { userId, videoCallId, meetingId });
      } catch (err) {
        console.error('Join meeting error:', err);
        socket.emit('join-failed', { message: 'Invalid token' });
      }
    });

    // Handle disconnection
    socket.on('disconnect', async () => {
      console.log('Client disconnected', socket.id);
      
      const userId = socketToUser.get(socket.id);
      if (userId) {
        activeUsers.delete(userId);
        socketToUser.delete(socket.id);
        
        await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() });

        meetings.forEach((participants, meetingId) => {
          if (participants.has(userId)) {
            participants.delete(userId);
            io.to(meetingId).emit('user-left', { userId });

            if (participants.size === 0) {
              meetings.delete(meetingId);
              console.log(`Meeting ${meetingId} ended automatically.`);
            }
          }
        });
      }
    });

    // Handle leaving a meeting
    socket.on('leave-meeting', ({ meetingId, userId }) => {
      if (meetings.has(meetingId)) {
        const participants = meetings.get(meetingId);
        participants.delete(userId);
        
        io.to(meetingId).emit('user-left', { userId });
        socket.leave(meetingId);
        
        if (participants.size === 0) {
          meetings.delete(meetingId);
          console.log(`Meeting ${meetingId} ended automatically.`);
        }
      }
    });
  });
}

// Controller to handle HTTP requests for meeting management
async function createMeeting(req, res) {
  try {
    const meetingId = uuidv4();
    meetings.set(meetingId, new Map()); // Initialize meeting bucket
    return res.json({ success: true, meetingId });
  } catch (error) {
    console.error('Error creating meeting:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

async function joinMeeting(req, res) {
  const { meetingId } = req.body;

  let token; 
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    token = authHeader.split(' ')[1]; 
  } catch (error) { 
    console.error('Error joining meeting:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }

  if (!meetings.has(meetingId)) {
    return res.status(400).json({ success: false, message: 'Invalid meeting ID' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id;

    const user = await User.findById(userId);
    const videoCallId = user.videoCallId;

    meetings.get(meetingId).set(userId, videoCallId);

    return res.json({ success: true, message: 'Meeting joined', meetingId, videoCallId });
  } catch (error) {
    console.error('Error joining meeting:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}


module.exports = { socketHandlers, createMeeting, joinMeeting };
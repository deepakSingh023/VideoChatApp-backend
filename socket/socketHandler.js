const jwt = require('jsonwebtoken');
const User = require('../model/user');

// Track active users and their socket IDs
const activeUsers = new Map(); // userId -> socketId
const socketToUser = new Map(); // socketId -> userId
const callRooms = new Map(); // videoCallId -> Set of socketIds

function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log('New client connected', socket.id);
    
    // User authentication via socket
    socket.on('authenticate', async ({ token }) => {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET );
        const userId = decoded.id;
        
        // Associate socket with user
        activeUsers.set(userId, socket.id);
        socketToUser.set(socket.id, userId);
        
        // Update user's online status
        await User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: new Date() });
        
        console.log(`User ${userId} authenticated with socket ${socket.id}`);
        socket.emit('authenticated', { success: true });
      } catch (err) {
        console.error('Authentication error:', err);
        socket.emit('authenticated', { success: false, message: 'Invalid token' });
      }
    });
    
    // Initiate call
    socket.on('call-user', async ({ targetVideoCallId }) => {
      try {
        // Find user by videoCallId
        const targetUser = await User.findOne({ videoCallId: targetVideoCallId });
        if (!targetUser) {
          return socket.emit('call-failed', { message: 'User not found' });
        }
        
        const targetUserId = targetUser._id.toString();
        const targetSocketId = activeUsers.get(targetUserId);
        
        // Check if target user is online
        if (!targetSocketId) {
          return socket.emit('call-failed', { message: 'User is offline' });
        }
        
        // Get caller info
        const callerId = socketToUser.get(socket.id);
        const caller = await User.findById(callerId).select('username videoCallId');
        
        // Create a room for this call
        const roomId = `${caller.videoCallId}_${targetVideoCallId}`;
        if (!callRooms.has(roomId)) {
          callRooms.set(roomId, new Set());
        }
        callRooms.get(roomId).add(socket.id);
        
        // Notify target user about incoming call
        io.to(targetSocketId).emit('incoming-call', {
          caller: {
            id: caller._id,
            username: caller.username,
            videoCallId: caller.videoCallId
          },
          roomId
        });
        
        socket.emit('call-initiated', { roomId });
      } catch (err) {
        console.error('Call initiation error:', err);
        socket.emit('call-failed', { message: 'Failed to initiate call' });
      }
    });
    
    // Handle call acceptance
    socket.on('accept-call', ({ roomId }) => {
      const userId = socketToUser.get(socket.id);
      
      if (callRooms.has(roomId)) {
        callRooms.get(roomId).add(socket.id);
        
        // Notify all participants that call was accepted
        callRooms.get(roomId).forEach(participantSocketId => {
          if (participantSocketId !== socket.id) {
            io.to(participantSocketId).emit('call-accepted', { 
              roomId,
              acceptedBy: userId
            });
          }
        });
        
        socket.join(roomId);
        socket.emit('joined-call', { roomId });
      } else {
        socket.emit('call-failed', { message: 'Call no longer exists' });
      }
    });
    
    // Handle call rejection
    socket.on('reject-call', ({ roomId }) => {
      if (callRooms.has(roomId)) {
        // Notify all participants that call was rejected
        callRooms.get(roomId).forEach(participantSocketId => {
          if (participantSocketId !== socket.id) {
            io.to(participantSocketId).emit('call-rejected');
          }
        });
        
        // Remove the room
        callRooms.delete(roomId);
      }
    });
    
    // WebRTC signaling
    socket.on('offer', ({ roomId, offer }) => {
      if (callRooms.has(roomId)) {
        socket.to(roomId).emit('offer', { offer, from: socket.id });
      }
    });
    
    socket.on('answer', ({ roomId, answer }) => {
      if (callRooms.has(roomId)) {
        socket.to(roomId).emit('answer', { answer, from: socket.id });
      }
    });
    
    socket.on('ice-candidate', ({ roomId, candidate }) => {
      if (callRooms.has(roomId)) {
        socket.to(roomId).emit('ice-candidate', { candidate, from: socket.id });
      }
    });
    
    // Handle disconnection
    socket.on('disconnect', async () => {
      console.log('Client disconnected', socket.id);
      
      // Get user associated with this socket
      const userId = socketToUser.get(socket.id);
      if (userId) {
        activeUsers.delete(userId);
        socketToUser.delete(socket.id);
        
        // Update user's online status and last seen
        await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() });
        
        // Find and clean up rooms this user was in
        callRooms.forEach((participants, roomId) => {
          if (participants.has(socket.id)) {
            participants.delete(socket.id);
            
            // Notify other participants about disconnection
            participants.forEach(participantSocketId => {
              io.to(participantSocketId).emit('user-disconnected', { userId });
            });
            
            // If no participants left, remove the room
            if (participants.size === 0) {
              callRooms.delete(roomId);
            }
          }
        });
      }
    });
    
    // Handle leaving a call
    socket.on('leave-call', ({ roomId }) => {
      if (callRooms.has(roomId)) {
        const participants = callRooms.get(roomId);
        participants.delete(socket.id);
        
        // Notify other participants
        participants.forEach(participantSocketId => {
          io.to(participantSocketId).emit('user-left', { socketId: socket.id });
        });
        
        socket.leave(roomId);
        
        // If no participants left, remove the room
        if (participants.size === 0) {
          callRooms.delete(roomId);
        }
      }
    });
  });
}

module.exports = {setupSocketHandlers};

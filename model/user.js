const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid'); //used to create a random video id for each user so they that each user ca connect with each other 

const userSchema = new mongoose.Schema({
  username: { 
    type: String, 
    required: true, 
    unique: true,
    trim: true
  },
  password: { 
    type: String, 
    required: true 
  },
  videoCallId: { 
    type: String, 
    unique: true, 
    default: () => uuidv4() 
  },
  isOnline: {
    type: Boolean,
    default: false
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

module.exports = mongoose.model('User', userSchema);
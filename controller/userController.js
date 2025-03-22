const User = require('../model/user.js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

const currentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

const searchUser = async (req, res) => {
  try {
    const user = await User.findOne({ videoCallId: req.params.videoCallId }).select('username videoCallId');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

const online = async (req, res) => {
  try {
    const users = await User.find({
      isOnline: true,
      _id: { $ne: req.user.id } // Exclude current user
    }).select('username videoCallId lastSeen');
    
    res.json(users);
  } catch (err) {
    console.error("Error fetching online users:", err);
    res.status(500).json({ message: "Server Error. Unable to fetch online users." });
  }
};


const 

module.exports = { currentUser, searchUser, online };

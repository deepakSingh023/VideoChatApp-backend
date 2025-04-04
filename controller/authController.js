const User = require('../model/user.js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const register = async (req, res) => {
    try {
      const { username, password } = req.body;
      
      // Check if user already exists
      let user = await User.findOne({username});
      if (user) {
        return res.status(400).json({ message: 'User already exists' });
      }
      
      // Hash password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      
      // Create new user
      user = new User({
        username,
        password: hashedPassword,
        videoCallId: uuidv4() // Generate unique video call ID
      });
      
      await user.save();
      
      // Generate JWT token
      const token = jwt.sign(
        { id: user._id, username: user.username },
        process.env.JWT_SECRET || 'jwtsecretkey',
        { expiresIn: '24h' }
      );
      
      res.status(201).json({
        token,
        user: {
          id: user._id,
          username: user.username,
          videoCallId: user.videoCallId
        }
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error' });
    }
  }

 const login = async (req, res) => {
    try {
      const { email, password } = req.body;
      
      // Check if user exists
      const user = await User.findOne({ email });
      if (!user) {
        return res.status(400).json({ message: 'Invalid credentials' });
      }
      
      // Validate password
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(400).json({ message: 'Invalid credentials' });
      }
      
      // Generate JWT token
      const token = jwt.sign(
        { id: user._id, username: user.username },
        process.env.JWT_SECRET || 'jwtsecretkey',
        { expiresIn: '24h' }
      );
      
      res.json({
        token,
        user: {
          id: user._id,
          username: user.username,
          videoCallId: user.videoCallId
        }
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error' });
    }
  };
  

  module.exports = {
    register,
    login,
  };
const express = require('express');
const router = express.Router();

const userController = require('../controller/userController');

const { createMeeting, joinMeeting } = userController;

// Destructure the auth function from the middleware (ensure your authMiddleware exports it correctly)
const { auth } = require('../middleware/authMiddleware.js');

router.post('/create-meeting', auth, createMeeting);
router.post('/join-meeting', auth, joinMeeting);

module.exports = router;

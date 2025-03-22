const express = require('express');
const router = express.Router();

const userController = require('../controller/userController');
const { currentUser, searchUser, online } = userController;

// Destructure the auth function from the middleware (ensure your authMiddleware exports it correctly)
const { auth } = require('../middleware/authMiddleware.js');

router.get('/me', auth, currentUser);
router.get('/search/:videoCallId', auth, searchUser);
router.get('/online', auth, online);

module.exports = router;

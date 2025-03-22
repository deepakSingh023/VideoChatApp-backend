const express = require('express');
const { register,login} = require('../controller/authController.js');
const auth = require('../middleware/authMiddleware.js');
const User = require('../model/user.js');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);

module.exports = router;
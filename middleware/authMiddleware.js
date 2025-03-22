const jwt = require('jsonwebtoken');
require('dotenv').config(); 

const auth = (req, res, next) => {
  let token;

  // Check for authorization header and if it starts with 'Bearer'
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1]; // Extract the token after 'Bearer'
  }

  
  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    
    req.user = { id: decoded.id };

  
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

  module.exports={auth};
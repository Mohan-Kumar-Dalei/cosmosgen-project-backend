// src/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const { registerUser,getUserDetails } = require('../controllers/auth.controller');
const { isAuthenticated } = require('../middlewares/auth.middleware');

router.post('/register', registerUser);
router.get('/user', isAuthenticated, getUserDetails);
module.exports = router;
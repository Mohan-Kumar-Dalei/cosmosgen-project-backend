const express = require('express');
const router = express.Router();
const { reverseGeocode } = require('../controllers/map.controller');

// GET request for reverse geocoding
router.get('/rev-geocode', reverseGeocode);

module.exports = router;
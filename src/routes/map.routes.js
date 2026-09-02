const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { reverseGeocode, searchPlaces } = require("../controllers/map.controller");

// Nominatim ki policy 1 req/sec hai - hum uske andar rehte hain
const geoLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { success: false, message: "Too many location requests" },
});

router.get("/rev-geocode", geoLimiter, reverseGeocode);
router.get("/search", geoLimiter, searchPlaces);

module.exports = router;
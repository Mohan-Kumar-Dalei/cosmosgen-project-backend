const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { reverseGeocode, searchPlaces, placeDetails } = require("../controllers/map.controller");

// Google's quota is far higher than the old Nominatim 1 req/sec ceiling, so
// this limit is no longer about their policy - it is about our bill. Each
// request past the monthly free tier costs money, so a runaway client or a
// scraper should get cut off well before it becomes expensive.
const geoLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { success: false, message: "Too many location requests" },
});

router.get("/rev-geocode", geoLimiter, reverseGeocode);
router.get("/search", geoLimiter, searchPlaces);
router.get("/place", geoLimiter, placeDetails);

module.exports = router;

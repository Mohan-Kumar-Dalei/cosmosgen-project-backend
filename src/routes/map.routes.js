const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { reverseGeocode, searchPlaces, placeDetails, cities, areas } = require("../controllers/map.controller");

// Google's quota is far higher than the old Nominatim 1 req/sec ceiling, so
// this limit is no longer about their policy - it is about our bill. Each
// request past the monthly free tier costs money, so a runaway client or a
// scraper should get cut off well before it becomes expensive.
const geoLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { success: false, message: "Too many location requests" },
});

/* The town list. Not rate limited the way the others are: it costs a lookup
   in an array we already have in memory, so there is no bill to protect and no
   provider to be polite to. */
router.get("/cities", cities);

/* The localities inside a pincode, from India Post. Free and cached, but it
   is somebody else's server, so the limiter applies - to be polite to them
   rather than to protect a bill. */
router.get("/areas", geoLimiter, areas);

router.get("/rev-geocode", geoLimiter, reverseGeocode);
router.get("/search", geoLimiter, searchPlaces);
router.get("/place", geoLimiter, placeDetails);

module.exports = router;

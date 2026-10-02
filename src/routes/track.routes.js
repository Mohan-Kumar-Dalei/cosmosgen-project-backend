const express = require("express");
const rateLimit = require("express-rate-limit");
const trackController = require("../controllers/track.controller");

const router = express.Router();

/**
 * The one public endpoint with no account behind it.
 *
 * The token in the path is the credential, and that is the whole of the
 * protection - so this is the one door where somebody can try a guess, and try
 * it again, without ever signing in. Unlimited, it was also the cheapest way
 * to scrape live positions: a token that is still open answers with where an
 * engineer is right now.
 *
 * The allowance is set for the customer this is actually for. They open the
 * link from WhatsApp, watch a map that refreshes over a socket rather than by
 * asking again, and perhaps reopen it a few times during a visit. Sixty in a
 * minute is far more than that and far less than a search.
 */
const trackLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests. Wait a moment and open the link again." },
});

// Public. The token in the path is the credential - see track.controller.
router.get("/:token", trackLimiter, trackController.getTracking);

module.exports = router;

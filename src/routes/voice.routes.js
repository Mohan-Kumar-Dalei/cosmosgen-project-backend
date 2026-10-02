const express = require("express");
const rateLimit = require("express-rate-limit");
const voiceController = require("../controllers/voice.controller");

const router = express.Router();

/**
 * The carrier's webhooks. Public by necessity - Exotel cannot sign in - and
 * form-encoded rather than JSON, which is why this router brings its own
 * parser instead of relying on the app's express.json().
 */
router.use(express.urlencoded({ extended: false }));

/**
 * A ceiling, because these two spend money.
 *
 * `/exotel/say` reaches Sarvam for text-to-speech on every request, including
 * the one that answers an unknown call id - a real caller holding a stale link
 * still has to be told something. Public, unsigned and unlimited, that is an
 * open tap: anybody could have held it down and spent the speech balance
 * without ever being a customer.
 *
 * Set well above what the carrier actually does. A call is a handful of
 * requests per turn and Exotel comes from a small set of its own addresses, so
 * several calls at once share one here - the number has to leave room for a
 * busy afternoon while still closing the tap. It also cannot be the global
 * limiter's job: that one counts a customer's phone and a carrier's data
 * centre the same way.
 */
const carrierLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.VOICE_RATE_LIMIT_PER_MINUTE) || 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: "busy",
});

/**
 * Exotel's flow applets. Both accept GET and POST because which one an applet
 * uses depends on how it is configured in their console, and we would rather
 * answer either than have a call fall silent over a verb.
 */
router.all("/exotel/say", carrierLimiter, voiceController.exotelSay);
router.all("/exotel/heard", carrierLimiter, voiceController.exotelHeard);

router.post("/status/:callId", carrierLimiter, voiceController.onStatus);

module.exports = router;

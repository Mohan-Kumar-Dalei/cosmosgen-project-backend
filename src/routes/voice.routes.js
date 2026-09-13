const express = require("express");
const voiceController = require("../controllers/voice.controller");

const router = express.Router();

/**
 * The carrier's webhooks. Public by necessity - Exotel cannot sign in - and
 * form-encoded rather than JSON, which is why this router brings its own
 * parser instead of relying on the app's express.json().
 */
router.use(express.urlencoded({ extended: false }));

/**
 * Exotel's flow applets. Both accept GET and POST because which one an applet
 * uses depends on how it is configured in their console, and we would rather
 * answer either than have a call fall silent over a verb.
 */
router.all("/exotel/say", voiceController.exotelSay);
router.all("/exotel/heard", voiceController.exotelHeard);

router.post("/status/:callId", voiceController.onStatus);

module.exports = router;

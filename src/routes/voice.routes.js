const express = require("express");
const voiceController = require("../controllers/voice.controller");

const router = express.Router();

/**
 * Twilio's webhooks. Public by necessity - Twilio cannot sign in - so every
 * one of them checks the X-Twilio-Signature before doing anything. See
 * signatureValid in the controller.
 *
 * Twilio posts form-encoded bodies, not JSON, which is why this router brings
 * its own parser rather than relying on the app's express.json().
 */
router.use(express.urlencoded({ extended: false }));

/**
 * Exotel's flow applets. Both accept GET and POST because which one an applet
 * uses depends on how it is configured in their console, and we would rather
 * answer either than have a call fall silent over a verb.
 */
router.all("/exotel/say", voiceController.exotelSay);
router.all("/exotel/heard", voiceController.exotelHeard);

router.post("/answer/:callId", voiceController.onAnswer);
router.post("/turn/:callId", voiceController.onTurn);
router.post("/status/:callId", voiceController.onStatus);

// The line to play, fetched by Twilio moments after we make it
router.get("/clip/:id", voiceController.getClip);

module.exports = router;

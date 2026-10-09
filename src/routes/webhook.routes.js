const express = require("express");
const router = express.Router();
const { phonepeWebhook, phonepeWebhookAlive } = require("../controllers/webhook.controller");

// PhonePe proves itself with a header, not a signature over the bytes, so its
// body can be parsed like any other.
router.post("/phonepe", express.json({ limit: "256kb" }), phonepeWebhook);
router.get("/phonepe", phonepeWebhookAlive);

module.exports = router;

const express = require("express");
const router = express.Router();
const { phonepeWebhook, phonepeWebhookAlive, razorpayWebhook } = require("../controllers/webhook.controller");

// PhonePe proves itself with a header, not a signature over the bytes, so its
// body can be parsed like any other.
router.post("/phonepe", express.json({ limit: "256kb" }), phonepeWebhook);
router.get("/phonepe", phonepeWebhookAlive);

// Old Razorpay links only - see razorpayWebhook. Raw, because Razorpay signs
// the raw bytes.
router.post("/razorpay", express.raw({ type: "application/json" }), razorpayWebhook);

module.exports = router;

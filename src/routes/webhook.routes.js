const express = require("express");
const router = express.Router();
const { razorpayWebhook } = require("../controllers/webhook.controller");

// express.raw() zaroori hai - signature verification ke liye raw buffer chahiye
router.post("/razorpay", express.raw({ type: "application/json" }), razorpayWebhook);

module.exports = router;
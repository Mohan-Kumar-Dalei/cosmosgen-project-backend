const express = require("express");
const router = express.Router();
const { verifyWebhook, receiveWebhook } = require("../controllers/whatsapp.controller");

console.log("[BOOT] whatsapp.routes.js loaded");

router.get("/webhook", verifyWebhook);
router.post("/webhook", express.raw({ type: "application/json" }), receiveWebhook);

module.exports = router;
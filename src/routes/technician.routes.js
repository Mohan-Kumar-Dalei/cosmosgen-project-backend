const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const upload = require("../middlewares/multer");
const { isTechAuthenticated } = require("../middlewares/techAuth.middleware");
const technicianController = require("../controllers/technician.controller");

// One limiter per route, never shared. express-rate-limit counts per
// instance, so reusing one across login and register meant failed logins
// locked people out of registering.
const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: { success: false, message: "Too many verification attempts. Try again in a few minutes." },
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { success: false, message: "Too many registration attempts. Try again later." },
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    message: { success: false, message: "Too many login attempts. Try again in a few minutes." },
});

const ifscLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { success: false, message: "Too many lookups, slow down" },
});

/* ---------- REGISTRATION ---------- */

// A new vendor is verified over WhatsApp, from the app and the web panel
// alike - six digits this server issued and checks itself
router.post("/signup-otp", otpLimiter, technicianController.sendSignupOtp);
router.post("/signup-otp/verify", otpLimiter, technicianController.verifySignupOtp);
router.get("/ifsc/:code", ifscLimiter, technicianController.checkIfsc);
router.post("/register", registerLimiter, upload.single("profileImage"), technicianController.registerTechnician);

/* ---------- AUTH ---------- */
router.post("/login", loginLimiter, technicianController.loginTechnician);
router.post("/logout", technicianController.logoutTechnician);

/* ---------- PROFILE ---------- */
router.get("/me", isTechAuthenticated, technicianController.getTechProfile);
router.get("/bootstrap", isTechAuthenticated, technicianController.bootstrap);
router.get("/cash-deposits", isTechAuthenticated, technicianController.getCashDeposits);
router.put("/profile/update", isTechAuthenticated, upload.single("profileImage"), technicianController.updateTechProfile);
router.delete("/profile/delete", isTechAuthenticated, technicianController.deleteTechProfile);

/* ---------- STATUS ---------- */
router.put("/status", isTechAuthenticated, technicianController.updateStatus);

/* ---------- LOCATION ---------- */
// Its own limiter: a technician on the road pings every 20-30 seconds, which
// would blow through any of the limiters above within a minute. This is also
// the only ride endpoint now - the route, the ETA and the arrival message are
// all derived from these pings rather than from buttons in the panel.
const locationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { success: false, message: "Too many location updates" },
});
router.post("/location", isTechAuthenticated, locationLimiter, technicianController.updateLocation);

/* ---------- PRICING ---------- */
router.get("/pricing", isTechAuthenticated, technicianController.getPricing);

/* ---------- TICKETS ---------- */
// The customer's code, sent to the customer - see otp.service
router.post("/tickets/:id/otp/:purpose", isTechAuthenticated, otpLimiter, technicianController.sendJobOtp);
router.post("/tickets/:id/on-the-way", isTechAuthenticated, technicianController.startOnTheWay);
router.post("/tickets/:id/start-work", isTechAuthenticated, technicianController.startWork);
router.post("/tickets/:id/release", isTechAuthenticated, technicianController.releaseTicket);
router.post("/tickets/:id/refuse", isTechAuthenticated, technicianController.refuseTicket);
router.post("/tickets/:id/visit-charge", isTechAuthenticated, technicianController.billVisitCharge);
router.post("/tickets/:id/skip-visit-charge", isTechAuthenticated, technicianController.skipVisitCharge);
router.post("/tickets/generateBill", isTechAuthenticated, technicianController.generateBill);
router.post("/tickets/:id/collect-cash", isTechAuthenticated, technicianController.collectCash);
router.get("/tickets/:id/payment-status", isTechAuthenticated, technicianController.getPaymentStatus);
router.post("/tickets/:id/start-now", isTechAuthenticated, technicianController.startScheduledNow);

/* ---------- WALLET ---------- */
router.get("/wallet", isTechAuthenticated, technicianController.getWallet);
router.post("/wallet/recharge", isTechAuthenticated, technicianController.createWalletRecharge);
router.get("/wallet/recharge/:linkId", isTechAuthenticated, technicianController.checkWalletRecharge);

module.exports = router;
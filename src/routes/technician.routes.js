const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const upload = require("../middlewares/multer");
const { isTechAuthenticated } = require("../middlewares/techAuth.middleware");
const technicianController = require("../controllers/technician.controller");

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    message: { success: false, message: "Too many attempts, try again later" },
});

// Auth
router.post("/register", authLimiter, technicianController.registerTechnician);
router.post("/login", authLimiter, technicianController.loginTechnician);
router.post("/logout", technicianController.logoutTechnician);

// Profile
router.get("/me", isTechAuthenticated, technicianController.getTechProfile);
router.get("/bootstrap", isTechAuthenticated, technicianController.bootstrap);
router.get("/cash-deposits", isTechAuthenticated, technicianController.getCashDeposits);
router.put("/profile/update", isTechAuthenticated, upload.single("profileImage"), technicianController.updateTechProfile);
router.delete("/profile/delete", isTechAuthenticated, technicianController.deleteTechProfile);

// Status & location
router.put("/status", isTechAuthenticated, technicianController.updateStatus);
//router.post("/update-location", isTechAuthenticated, technicianController.updateLocation);

// Pricing catalog
router.get("/pricing", isTechAuthenticated, technicianController.getPricing);

// Tickets
// router.get("/my-ticket", isTechAuthenticated, technicianController.getMyAssignedTicket);
// router.get("/tickets/history", isTechAuthenticated, technicianController.getCompletedTickets);
router.post("/tickets/:id/start-work", isTechAuthenticated, technicianController.startWork);
router.post("/tickets/:id/release", isTechAuthenticated, technicianController.releaseTicket);
router.post("/tickets/generateBill", isTechAuthenticated, technicianController.generateBill);
router.post("/tickets/:id/collect-cash", isTechAuthenticated, technicianController.collectCash);
router.get("/tickets/:id/payment-status", isTechAuthenticated, technicianController.getPaymentStatus);
router.post("/tickets/:id/start-now", isTechAuthenticated, technicianController.startScheduledNow);

//wallet
router.get("/wallet", isTechAuthenticated, technicianController.getWallet); 
router.post("/wallet/recharge", isTechAuthenticated, technicianController.createWalletRecharge);
router.get("/wallet/recharge/:linkId", isTechAuthenticated, technicianController.checkWalletRecharge);

module.exports = router;
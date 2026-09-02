const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { isAdminAuthenticated, isSuperAdmin } = require("../middlewares/adminAuth.middleware");
const adminController = require("../controllers/admin.controller");

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    message: { success: false, message: "Too many login attempts, try again later" },
});

/* ---------- PUBLIC ---------- */
router.post("/register", authLimiter, adminController.registerAdmin);
router.post("/login", authLimiter, adminController.loginAdmin);
router.post("/logout", adminController.logoutAdmin);

/* ---------- BOTH ROLES ---------- */
router.get("/me", isAdminAuthenticated, adminController.getAdminProfile);
router.get("/dashboard/stats", isAdminAuthenticated, adminController.getDashboardStats);

// Tickets
router.get("/tickets", isAdminAuthenticated, adminController.getTickets);
router.get("/tickets/:id", isAdminAuthenticated, adminController.getTicketById);
router.get("/tickets/:id/nearby-technicians", isAdminAuthenticated, adminController.getNearbyTechnicians);
router.post("/tickets/:id/assign", isAdminAuthenticated, adminController.assignTicket);
router.post("/tickets/:id/unassign", isAdminAuthenticated, adminController.unassignTicket);
router.post("/tickets/:id/reassign", isAdminAuthenticated, adminController.reassignTicket);
router.post("/tickets/:id/reschedule", isAdminAuthenticated, adminController.rescheduleTicket);
router.post("/tickets/:id/cancel", isAdminAuthenticated, adminController.cancelTicket);

// Technicians - reviewing applications is daily backoffice work
router.get("/technicians", isAdminAuthenticated, adminController.getAllTechnicians);
router.get("/technicians/:id", isAdminAuthenticated, adminController.getTechnicianById);
router.post("/technicians/:id/approve", isAdminAuthenticated, adminController.approveTechnician);
router.post("/technicians/:id/reject", isAdminAuthenticated, adminController.rejectTechnician);

// Pricing
router.get("/pricing", isAdminAuthenticated, adminController.getPricingList);
router.post("/pricing/:serviceKey/items", isAdminAuthenticated, adminController.addPricingItem);
router.put("/pricing/:serviceKey/items/:itemId", isAdminAuthenticated, adminController.updatePricingItem);
router.delete("/pricing/:serviceKey/items/:itemId", isAdminAuthenticated, adminController.deletePricingItem);

// Payments - counting cash a technician hands in is counter work, not owner work
router.get("/payments", isAdminAuthenticated, adminController.getPayments);
router.post("/payments/:id/verify", isAdminAuthenticated, adminController.verifyPayment);
//wallet
// Wallet - moving money is owner work, not counter work
router.get("/wallets", isAdminAuthenticated, adminController.getWalletSummary);
router.get("/wallets/:technicianId", isAdminAuthenticated, adminController.getTechnicianWallet);
router.post("/technicians/payout", isAdminAuthenticated, isSuperAdmin, adminController.issueTechnicianPayout);
router.post("/wallets/:technicianId/collect", isAdminAuthenticated, isSuperAdmin, adminController.collectFromTechnician);

/* ---------- SUPERADMIN ONLY ---------- */
// Blocking bars that phone number permanently, so it stays with the owner
router.post("/technicians/:id/block", isAdminAuthenticated, isSuperAdmin, adminController.blockTechnician);
router.post("/technicians/:id/unblock", isAdminAuthenticated, isSuperAdmin, adminController.unblockTechnician);

router.post("/tickets/:id/force-close", isAdminAuthenticated, isSuperAdmin, adminController.forceCloseTicket);

router.get("/staff", isAdminAuthenticated, isSuperAdmin, adminController.getAllStaff);
router.post("/staff", isAdminAuthenticated, isSuperAdmin, adminController.createStaff);
router.patch("/staff/:id/toggle-active", isAdminAuthenticated, isSuperAdmin, adminController.toggleStaffActive);

router.get("/analytics/revenue", isAdminAuthenticated, isSuperAdmin, adminController.getRevenueAnalytics);
router.get("/analytics/export", isAdminAuthenticated, isSuperAdmin, adminController.exportRevenueCsv);

module.exports = router;
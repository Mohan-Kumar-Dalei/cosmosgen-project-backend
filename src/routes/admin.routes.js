const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { isAdminAuthenticated, isSuperAdmin } = require("../middlewares/adminAuth.middleware");
const adminController = require("../controllers/admin.controller");
const serviceAdmin = require("../controllers/serviceAdmin.controller");
const siteImage = require("../controllers/siteImage.controller");
const keyAdmin = require("../controllers/apiKey.controller");
const announcement = require("../controllers/announcement.controller");
const upload = require("../middlewares/multer");

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
router.post("/tickets/:id/call", isAdminAuthenticated, adminController.callCustomer);
router.post("/tickets/:id/cancel", isAdminAuthenticated, adminController.cancelTicket);
router.post("/tickets/:id/refusal", isAdminAuthenticated, adminController.resolveRefusal);

// Technicians - reviewing applications is daily backoffice work
router.get("/technicians", isAdminAuthenticated, adminController.getAllTechnicians);
router.get("/technicians/:id", isAdminAuthenticated, adminController.getTechnicianById);
router.post("/technicians/:id/approve", isAdminAuthenticated, adminController.approveTechnician);
router.post("/technicians/:id/reject", isAdminAuthenticated, adminController.rejectTechnician);

// Pricing
router.get("/pricing", isAdminAuthenticated, adminController.getPricingList);
/* ---------- THE CATALOGUE ----------
   What the company sells is the office's to change, not a developer's. Reading
   it is open to any admin; changing it is the owner's, because a service added
   here appears on the website, in the WhatsApp menu and in the assistant's
   prompt the moment it is saved. */
router.get("/services", isAdminAuthenticated, serviceAdmin.listServices);
router.post("/services/draft", isAdminAuthenticated, isSuperAdmin, serviceAdmin.draftService);
router.post("/services", isAdminAuthenticated, isSuperAdmin, upload.single("image"), serviceAdmin.createService);
router.put("/services/:key", isAdminAuthenticated, isSuperAdmin, upload.single("image"), serviceAdmin.updateService);
router.delete("/services/:key", isAdminAuthenticated, isSuperAdmin, serviceAdmin.removeService);

/* ---------- THE PICTURES ----------
   Every drawing the customer site shows, in one place, saved either by
   uploading a file or by pasting the ImageKit link it already has. The owner's
   decision rather than the desk's: these are the first thing anybody sees. */
router.get("/images", isAdminAuthenticated, isSuperAdmin, siteImage.listImages);
router.put("/images/appliance/:key/:appliance", isAdminAuthenticated, isSuperAdmin, upload.single("image"), siteImage.saveApplianceImage);
router.put("/images/:slot", isAdminAuthenticated, isSuperAdmin, upload.single("image"), siteImage.saveSiteImage);

/* ---------- WHAT THE OFFICE IS SAYING ----------
   The posters on the app's home screen and the notices behind its bell. Owner
   only for the same reason the pictures are: this reaches every customer at
   once, and Send cannot be taken back. */
router.get("/announcements", isAdminAuthenticated, isSuperAdmin, announcement.list);
router.post("/announcements", isAdminAuthenticated, isSuperAdmin, announcement.create);
router.put("/announcements/:id", isAdminAuthenticated, isSuperAdmin, announcement.update);
router.delete("/announcements/:id", isAdminAuthenticated, isSuperAdmin, announcement.remove);
router.post("/announcements/:id/push", isAdminAuthenticated, isSuperAdmin, announcement.send);

/* ---------- THE KEYS ----------
   Which API key the platform is spending, how much of it is left, and what to
   fall back to when a free tier runs out. Owner only, and the key itself is
   never sent back to the browser. */
router.get("/keys", isAdminAuthenticated, isSuperAdmin, keyAdmin.listKeys);

/* What the maps cost, split by the kind of call. Owner only, like the keys
   themselves - it is a bill, and the shape of one says how the product is
   being used. */
router.get("/map-usage", isAdminAuthenticated, isSuperAdmin, keyAdmin.mapUsage);

/* Emptying the vendor recycle bin. Owner only - it is the one thing on that
   screen nobody can undo. */
router.delete("/technicians/deleted", isAdminAuthenticated, isSuperAdmin, adminController.purgeDeletedTechnicians);
router.post("/keys", isAdminAuthenticated, isSuperAdmin, keyAdmin.addKey);
router.post("/keys/reveal", isAdminAuthenticated, isSuperAdmin, keyAdmin.revealKey);
router.post("/keys/:id/test", isAdminAuthenticated, isSuperAdmin, keyAdmin.testKey);
router.post("/keys/:id/promote", isAdminAuthenticated, isSuperAdmin, keyAdmin.promoteKey);
router.post("/keys/:id/reset", isAdminAuthenticated, isSuperAdmin, keyAdmin.resetKey);
router.put("/keys/:id", isAdminAuthenticated, isSuperAdmin, keyAdmin.updateKey);
router.delete("/keys/:id", isAdminAuthenticated, isSuperAdmin, keyAdmin.removeKey);

router.post("/pricing/:serviceKey/items", isAdminAuthenticated, adminController.addPricingItem);
router.put("/pricing/:serviceKey/items/:itemId", isAdminAuthenticated, adminController.updatePricingItem);
router.delete("/pricing/:serviceKey/items/:itemId", isAdminAuthenticated, adminController.deletePricingItem);

// Payments - counting cash a technician hands in is counter work, not owner work
router.get("/payments", isAdminAuthenticated, adminController.getPayments);
router.post("/payments/check-reference", isAdminAuthenticated, adminController.checkPaymentReference);
router.post("/payments/:id/check", isAdminAuthenticated, adminController.checkPaymentMoney);
router.post("/payments/:id/verify", isAdminAuthenticated, adminController.verifyPayment);
//wallet
// Wallet - moving money is owner work, not counter work
router.get("/settings", isAdminAuthenticated, adminController.getSettings);
router.patch("/settings/:key", isAdminAuthenticated, isSuperAdmin, adminController.updateSetting);
router.get("/settlements", isAdminAuthenticated, adminController.getSettlements);
router.get("/wallets", isAdminAuthenticated, adminController.getWalletSummary);
router.get("/wallets/:technicianId", isAdminAuthenticated, adminController.getTechnicianWallet);
router.get("/wallets/:technicianId/references", isAdminAuthenticated, adminController.getTechnicianPaymentReferences);
/*
 * Recording a payout is office work too.
 *
 * It sits beside collect for a reason: both are the same clerk, at the same
 * screen, writing down money that has already moved. Neither of them moves
 * it - the transfer happens in a bank app, and this is the record of it - so
 * gating one behind the owner and not the other only meant a vendor waited
 * for the owner to log in before his payment appeared on his own wallet.
 */
router.post("/technicians/payout", isAdminAuthenticated, adminController.issueTechnicianPayout);
/*
 * Recording a collection is backoffice work, not owner work.
 *
 * It was behind isSuperAdmin, which meant the one person who is not sitting
 * in front of the queue all day was the only one who could clear it - so a
 * vendor's settlement waited for the owner to log in. The office already
 * verifies these references against Razorpay; recording what it just
 * verified is the same job finished. Payout, just above, went the same way
 * for the same reason.
 */
router.post("/wallets/:technicianId/collect", isAdminAuthenticated, adminController.collectFromTechnician);

/* ---------- SUPERADMIN ONLY ---------- */
// Blocking bars that phone number permanently, so it stays with the owner
router.post("/technicians/:id/block", isAdminAuthenticated, isSuperAdmin, adminController.blockTechnician);
router.post("/technicians/:id/unblock", isAdminAuthenticated, isSuperAdmin, adminController.unblockTechnician);

// Ending a pause is an ordinary day-to-day call, unlike blocking - the
// office makes it while a job is waiting, so it is not kept for the owner.
router.post("/technicians/:id/unpause", isAdminAuthenticated, adminController.unpauseTechnician);

router.post("/tickets/:id/force-close", isAdminAuthenticated, isSuperAdmin, adminController.forceCloseTicket);

router.get("/staff", isAdminAuthenticated, isSuperAdmin, adminController.getAllStaff);
router.post("/staff", isAdminAuthenticated, isSuperAdmin, adminController.createStaff);
router.patch("/staff/:id/toggle-active", isAdminAuthenticated, isSuperAdmin, adminController.toggleStaffActive);

router.get("/analytics/revenue", isAdminAuthenticated, isSuperAdmin, adminController.getRevenueAnalytics);
router.get("/analytics/export", isAdminAuthenticated, isSuperAdmin, adminController.exportRevenueCsv);

module.exports = router;
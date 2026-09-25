const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { isAuthenticated } = require("../middlewares/auth.middleware");
const customer = require("../controllers/customer.controller");
const siteImage = require("../controllers/siteImage.controller");

/**
 * The customer's own API - the app books through it, the website reads from it.
 *
 * Separate from `/api/auth`, which is the old phone-number-only registration
 * the chat demo used. Anything signing a customer in now comes through here,
 * behind a code sent to their WhatsApp.
 */

// One limiter per route, never shared: express-rate-limit counts per instance,
// so reusing one across sending and checking means a mistyped code eats into
// the allowance for asking for a new one.
const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: { success: false, message: "Too many attempts. Try again in a few minutes." },
});

const coverageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { success: false, message: "Too many location checks. Wait a moment." },
});

const askLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 40,
    message: { success: false, message: "That is a lot of questions at once. Wait a few minutes, or message us on WhatsApp." },
});

const bookLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { success: false, message: "That is a lot of requests in one hour. Message us instead." },
});

/* ---------- SIGNING IN ---------- */
router.post("/otp", otpLimiter, customer.sendOtp);
router.post("/otp/verify", otpLimiter, customer.verifyOtp);
router.post("/logout", customer.logout);

/* ---------- WHAT WE DO ----------
   Public: somebody deciding whether to install the app has to be able to see
   what is on offer before they have an account. */
router.get("/services", customer.getServices);

/* ---------- WHAT IT LOOKS LIKE ----------
   The pictures the office has swapped out from under the ones the site ships
   with. Public, cached by the browser like any other asset, and safe to fail:
   an empty answer means the site keeps its own drawings. */
router.get("/images", siteImage.publicImages);

/* ---------- WHERE WE WORK ----------
   Public too, and asked before anything is promised: the catalogue is the same
   everywhere, the people who do the work are not. Rate limited because each
   miss behind it can cost a Google geocode. */
router.get("/coverage", coverageLimiter, customer.coverage);

/* ---------- THE ASSISTANT ----------
   Signed in only, now. It used to answer anybody, on the reasoning that the
   questions deciding whether a person becomes a customer all come before the
   account does - but every turn is a model call somebody pays for, and an
   endpoint that spends money for strangers is one that will eventually be
   found and spent. A rate limiter slows that down; it does not stop it.

   It answers and it cannot book: the service behind it is never given a
   booking tool. */
router.post("/ask", askLimiter, isAuthenticated, customer.ask);

/* And the thread itself. These were open because the chat id was the only key
   a visitor had, which also meant anybody holding an id could read a thread or
   delete it - a delete that removes the document from the database outright.
   With the assistant behind a session, the thread belongs to a person and is
   checked the same way. */
router.get("/chat/:chatId", isAuthenticated, customer.chat);
router.delete("/chat/:chatId", isAuthenticated, customer.forgetChat);

/* ---------- THEIR ACCOUNT ---------- */
router.get("/me", isAuthenticated, customer.me);
router.put("/profile", isAuthenticated, customer.updateProfile);
router.put("/push-token", isAuthenticated, customer.savePushToken);

/* ---------- THEIR JOBS ---------- */
// Saved addresses. The list is the customer's own, so every one of these is
// scoped to the signed-in account inside the service.
router.get("/addresses", isAuthenticated, customer.listAddresses);
router.post("/addresses", isAuthenticated, customer.addAddress);
router.patch("/addresses/:id", isAuthenticated, customer.updateAddress);
router.delete("/addresses/:id", isAuthenticated, customer.deleteAddress);
router.post("/addresses/:id/default", isAuthenticated, customer.makeAddressDefault);

router.post("/book", isAuthenticated, bookLimiter, customer.book);
router.get("/tickets", isAuthenticated, customer.myTickets);
router.get("/tickets/:id", isAuthenticated, customer.ticketDetail);

// What the customer thought of a job, once it is finished. See rateTicket -
// their own ticket, closed, and once.
router.get("/rating-tags", customer.ratingTags);
router.post("/tickets/:id/rating", isAuthenticated, customer.rateTicket);

// What the office is saying to everybody: the home screen's posters and the
// notices behind the bell. Signed in, because the unread count is per customer.
router.get("/announcements", isAuthenticated, customer.announcements);
router.post("/notices/seen", isAuthenticated, customer.noticesSeen);

module.exports = router;

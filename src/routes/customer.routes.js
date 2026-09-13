const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { isAuthenticated, attachUserIfAny } = require("../middlewares/auth.middleware");
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
   Open to visitors, better for somebody signed in: the questions that decide
   whether a person ever becomes a customer all come before the account does.
   It answers and it cannot book - the service behind it is never given a
   booking tool. Rate limited because every turn costs a model call. */
router.post("/ask", askLimiter, attachUserIfAny, customer.ask);

/* Reading one back. Open, because the chat id is the only key a visitor has
   and nothing in a thread is private to anybody else - the assistant reads a
   signed-in customer's jobs from their session, never from the stored chat. */
router.get("/chat/:chatId", customer.chat);
router.delete("/chat/:chatId", customer.forgetChat);

/* ---------- THEIR ACCOUNT ---------- */
router.get("/me", isAuthenticated, customer.me);
router.put("/profile", isAuthenticated, customer.updateProfile);

/* ---------- THEIR JOBS ---------- */
router.post("/book", isAuthenticated, bookLimiter, customer.book);
router.get("/tickets", isAuthenticated, customer.myTickets);
router.get("/tickets/:id", isAuthenticated, customer.ticketDetail);

module.exports = router;

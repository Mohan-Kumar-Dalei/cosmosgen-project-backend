const express = require("express");
const router = express.Router();

const { getUserDetails, logoutUser } = require("../controllers/auth.controller");
const { isAuthenticated } = require("../middlewares/auth.middleware");

/*
 * There is no registration here any more, and there must not be one again.
 *
 * `POST /register` took a phone number, no OTP and nothing else, wrote the
 * name and address that came with it onto whichever account held that number,
 * and set a seven-day session cookie for it. Anybody who knew a customer's
 * phone number could have had a logged-in session as that customer, and could
 * have overwritten the address an engineer is sent to on the way past. It was
 * live on the production server.
 *
 * It was written before OTP existed - the comment left in the controller said
 * the verification would be added "in phase 2" - and when phase 2 arrived the
 * new door was built beside it at /api/customer/otp rather than in front of
 * it. Nothing has called this in a long time: not the website, not the
 * customer app, not the vendor app.
 *
 * Registration is /api/customer/otp and /api/customer/otp/verify, both behind
 * a limiter, and a code the customer actually receives.
 */
router.get("/user", isAuthenticated, getUserDetails);
router.post("/logout", logoutUser);

module.exports = router;

const jwt = require("jsonwebtoken");
const userModel = require("../models/user.model");
const registration = require("../services/registration.service");

const isProd = process.env.NODE_ENV === "production";

const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
};

/*
 * Registration by phone number alone used to live here and has been removed.
 *
 * It verified nothing. A phone number went in, the name and address that came
 * with it were written onto whichever account held that number, and a
 * seven-day session cookie came back for it - so knowing somebody's number was
 * the whole of what it took to be them, and to change the address an engineer
 * would be sent to.
 *
 * It predated OTP; the comment left in it said verification would arrive "in
 * phase 2", and when it did the new door was built beside this one instead of
 * in front of it. Nothing had called it in a long time.
 *
 * Registration is /api/customer/otp and /api/customer/otp/verify.
 */

// GET /api/auth/user
const getUserDetails = async (req, res) => {
    // req.user middleware se aa chuka hai, dobara DB hit karne ki zaroorat nahi
    return res.status(200).json({ success: true, user: req.user });
};

// POST /api/auth/logout
const logoutUser = (req, res) => {
    res.clearCookie("token", {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? "none" : "lax",
        path: "/",
    });
    return res.status(200).json({ success: true, message: "Logged out" });
};

module.exports = { getUserDetails, logoutUser };
const jwt = require("jsonwebtoken");
const userModel = require("../models/user.model");

const isProd = process.env.NODE_ENV === "production";

const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
};

// POST /api/auth/register
// FIX: pehle token 1 ghante mein expire hota tha par cookie 7 din ki thi, aur
// koi login route nahi tha. Expire hone par user "already exists" pe atak jata tha.
const registerUser = async (req, res) => {
    try {
        const { phone, name, address, state, area, lat, lon } = req.body;

        if (!phone) {
            return res.status(400).json({ success: false, message: "Phone number is required" });
        }
        if (!/^[6-9]\d{9}$/.test(String(phone).trim())) {
            return res.status(400).json({ success: false, message: "Enter a valid 10-digit mobile number" });
        }

        const cleanPhone = String(phone).trim();
        const numLat = Number(lat);
        const numLon = Number(lon);
        const hasCoords = Number.isFinite(numLat) && Number.isFinite(numLon);

        const updateData = { name, address, state, area };
        if (hasCoords) {
            updateData.lat = numLat;
            updateData.lon = numLon;
            updateData.location = { type: "Point", coordinates: [numLon, numLat] };
        }

        // Upsert - purana user dobara aaye to error nahi, session wapas mil jayega.
        // (Phase 2 mein ye OTP verification ke peeche jayega.)
        const user = await userModel
            .findOneAndUpdate(
                { phone: cleanPhone },
                { $set: updateData, $setOnInsert: { phone: cleanPhone } },
                { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
            )
            .lean();

        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
        res.cookie("token", token, cookieOptions);

        return res.status(201).json({ success: true, user });
    } catch (error) {
        console.error("Register user error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

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

module.exports = { registerUser, getUserDetails, logoutUser };
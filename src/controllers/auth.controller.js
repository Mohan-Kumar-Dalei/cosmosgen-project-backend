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

        // Nobody reaches the assistant without a name and a place, on any
        // channel. Dispatch cannot find the nearest vendor without the
        // coordinates, so letting somebody through and asking later only
        // moves the dead end further into the conversation.
        if (!String(name || "").trim()) {
            return res.status(400).json({ success: false, message: "Please tell us your name" });
        }
        if (!hasCoords) {
            return res.status(400).json({
                success: false,
                message: "We need your location to find someone near you",
            });
        }

        // Upsert - purana user dobara aaye to error nahi, session wapas mil jayega.
        // (Phase 2 mein ye OTP verification ke peeche jayega.)
        //
        // The pin is resolved into a full address, state and pincode here,
        // exactly as it is on WhatsApp, so a customer registered on one door
        // is registered at all of them.
        await registration.applyLocation(cleanPhone, {
            lat: numLat,
            lon: numLon,
            fallbackAddress: address,
            name: String(name).trim(),
        });

        const typed = {
            name: String(name).trim(),
            // Their own words win over anything worked out from the pin
            ...(String(address || "").trim() ? { address: String(address).trim() } : {}),
            ...(String(state || "").trim() ? { state: String(state).trim() } : {}),
            ...(String(area || "").trim() ? { area: String(area).trim() } : {}),
            nameConfirmedAt: new Date(),
        };

        const user = await userModel
            .findOneAndUpdate(
                { phone: cleanPhone },
                { $set: typed },
                { returnDocument: "after", runValidators: true }
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
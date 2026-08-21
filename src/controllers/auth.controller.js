const userModel = require('../models//user.model');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

//POST /api/auth/register
const registerUser = async (req, res) => {
    try {
        const { phone, name, address, state, area, lat, lon } = req.body;

        const userExists = await userModel.findOne({ phone: phone });
        if (userExists) {
            return res.status(400).json({ success: false, message: "User already exists" });
        }
        const user = await userModel.create({
            phone,
            name,
            address,
            state,
            area,
            lat,
            lon,
            // Exact Map mapping ke liye GeoJSON format
            location: {
                type: "Point",
                coordinates: [lon || 0, lat || 0]
            }
        });

        const token = jwt.sign({
            userId: user._id,
        }, process.env.JWT_SECRET, { expiresIn: '1h' });

        res.cookie('token', token, {
            httpOnly: true,
            secure: true,         
            sameSite: 'none',  
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });
        res.status(201).json({ success: true, token, user });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}
// GET /api/auth/user
const getUserDetails = async (req, res) => {
    try {
        // req.user humein auth middleware se mil gaya hai
        const user = await userModel.findById(req.user._id).select("-password -__v");
        // .select("-password") ka matlab hai ki password field frontend par send nahi karni (security)

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Frontend ko user data bhej diya
        res.status(200).json({ user: user });

    } catch (error) {
        console.error("🚨 Get User API Error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};



module.exports = { registerUser, getUserDetails }
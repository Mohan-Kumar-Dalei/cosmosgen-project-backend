const jwt = require("jsonwebtoken");
const Technician = require("../models/technician.model");

const isTechAuthenticated = async (req, res, next) => {
    try {
        // Read the token from the cookie
        const token = req.cookies.techToken;
        
        if (!token) {
            console.error("Tech Auth Error: No token found in cookies");
            return res.status(401).json({ success: false, message: "Unauthorized: Please login first" });
        }

        // Verify the token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Find the technician
        const technician = await Technician.findById(decoded.techId).select("-password");
        
        if (!technician) {
            console.error("Tech Auth Error: Technician not found in database");
            return res.status(401).json({ success: false, message: "Unauthorized: Invalid user" });
        }

        // Attach technician data to the request object for the next functions
        req.technician = technician;
        next();

    } catch (error) {
        console.error("Tech Auth Error: Token verification failed", error.message);
        res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
    }
};

module.exports = { isTechAuthenticated };
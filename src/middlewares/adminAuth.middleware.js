const jwt = require("jsonwebtoken");
const adminModel = require("../models/admin.model");

const isAdminAuthenticated = async (req, res, next) => {
    try {
        const token = req.cookies?.adminToken;
        if (!token) {
            return res.status(401).json({ success: false, message: "Unauthorized: Please login first" });
        }

        const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
        if (!decoded.adminId) {
            return res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
        }

        const admin = await adminModel
            .findById(decoded.adminId)
            .select("_id name email role isActive")
            .lean();

        // Checked on every request, not just at login - an account switched
        // off mid-session loses access immediately
        if (!admin || !admin.isActive) {
            res.clearCookie("adminToken", { path: "/" });
            return res.status(401).json({ success: false, message: "Unauthorized: Account inactive" });
        }

        req.admin = admin;
        next();
    } catch (error) {
        console.error("Admin auth error:", error.message);
        return res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
    }
};

// Runs after isAdminAuthenticated - it reads req.admin.role
const isSuperAdmin = (req, res, next) => {
    if (req.admin?.role !== "superadmin") {
        return res.status(403).json({ success: false, message: "Forbidden: Owner access required" });
    }
    next();
};

module.exports = { isAdminAuthenticated, isSuperAdmin };
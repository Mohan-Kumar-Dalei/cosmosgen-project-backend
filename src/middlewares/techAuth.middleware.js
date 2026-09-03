const jwt = require("jsonwebtoken");
const technicianModel = require("../models/technician.model");

const isTechAuthenticated = async (req, res, next) => {
    try {
        const token = req.cookies?.techToken;
        if (!token) {
            return res.status(401).json({ success: false, message: "Unauthorized: Please login first" });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.techId || decoded.role !== "technician") {
            return res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
        }

        const technician = await technicianModel
            .findById(decoded.techId)
            .select("_id name phone state area pincode skills profileImage rating isAvailable activeTicket completedJobs performanceLevel location approvalStatus isBlacklisted isDeleted bankDetails")
            .lean();

        if (!technician) {
            return res.status(401).json({ success: false, message: "Unauthorized: Technician not found" });
        }

        // Checked on every request, not just at login - an account blocked or
        // un-approved mid-session loses access immediately instead of running
        // on a token that's still technically valid
        if (technician.isBlacklisted) {
            res.clearCookie("techToken", { path: "/" });
            return res.status(403).json({ success: false, message: "This account has been blocked. Contact the office." });
        }
        if (technician.isDeleted) {
            res.clearCookie("techToken", { path: "/" });
            return res.status(403).json({ success: false, message: "This account is no longer active." });
        }
        if (technician.approvalStatus !== "approved") {
            res.clearCookie("techToken", { path: "/" });
            return res.status(403).json({
                success: false,
                message: "Your account is still being reviewed by the office.",
                approvalStatus: technician.approvalStatus,
            });
        }

        req.technician = technician;
        next();
    } catch (error) {
        console.error("Tech auth error:", error.message);
        return res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
    }
};

// No isSuperAdmin here - that lives in adminAuth.middleware.js and reads
// req.admin, which technician routes never have
module.exports = { isTechAuthenticated };
const jwt = require("jsonwebtoken");
const technicianModel = require("../models/technician.model");

const isTechAuthenticated = async (req, res, next) => {
    try {
        /**
         * A cookie for the browser, a header for the phone.
         *
         * The web panel signs in and the browser carries an httpOnly cookie on
         * every request afterwards, which is the safer arrangement and stays.
         * A React Native app has no cookie jar worth relying on, so it keeps
         * the token itself and sends it as a bearer header. Same token, same
         * signature, same checks below - only the way it arrives differs.
         */
        const header = req.headers.authorization || "";
        const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        const token = req.cookies?.techToken || bearer;

        if (!token) {
            return res.status(401).json({ success: false, message: "Unauthorized: Please login first" });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.techId || decoded.role !== "technician") {
            return res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
        }

        const technician = await technicianModel
            .findById(decoded.techId)
            /*
             * `city` belongs in this list, and its absence is why the vendor
             * app showed "Not set" against Town or city.
             *
             * GET /technician/me hands back exactly what this attaches, so a
             * field left out here does not merely go unchecked - it never
             * reaches the app at all, and the profile screen reports it as
             * missing from the record. `state`, `area` and `pincode` were all
             * here; the town was the one that was not.
             */
            .select("_id name phone state city area pincode skills profileImage rating isAvailable activeTicket completedJobs performanceLevel location approvalStatus isBlacklisted isDeleted bankDetails commissionRate walletBalancePaise")
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
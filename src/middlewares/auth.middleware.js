const jwt = require("jsonwebtoken");
const userModel = require("../models/user.model");

const isAuthenticated = async (req, res, next) => {
    try {
        // Cookie parser se token nikalna (ensure karein app.use(cookieParser()) `server.js` mein laga ho)
        const token = req.cookies.token;
        
        if (!token) {
            return res.status(401).json({ message: "Unauthorized: No token provided" });
        }

        // Token verify karna
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Database se user find karna (decoded.userId ya decoded.id aapke login logic par depend karta hai)
        const user = await userModel.findById(decoded.userId || decoded.id);
        
        if (!user) {
            return res.status(401).json({ message: "Unauthorized: User not found" });
        }

        // Request object mein user data attach kar diya
        req.user = user;
        next();

    } catch (error) {
        console.error("🚨 Auth Middleware Error:", error.message);
        res.status(401).json({ message: "Unauthorized: Invalid token" });
    }
};

module.exports = { isAuthenticated };
const jwt = require("jsonwebtoken");
const userModel = require("../models/user.model");

const isAuthenticated = async (req, res, next) => {
    try {
        /**
         * A cookie for the browser, a header for the phone.
         *
         * The website signs in and the browser carries an httpOnly cookie on
         * every request afterwards, which is the safer arrangement and stays.
         * A React Native app has no cookie jar worth relying on, so it keeps
         * the token itself and sends it as a bearer header - the same split
         * the technician side already makes. Same token, same signature, same
         * checks below; only the way it arrives differs.
         */
        const header = req.headers.authorization || "";
        const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        const token = req.cookies?.token || bearer;

        if (!token) {
            return res.status(401).json({ success: false, message: "Unauthorized: No token provided" });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId || decoded.id;

        // select + lean -> sirf zaroori fields, mongoose hydration skip.
        // Ye middleware HAR request pe chalta hai, isliye yahan speed matter karti hai
        const user = await userModel
            .findById(userId)
            /*
             * `language` and `languageConfirmedAt` belong here.
             *
             * GET /customer/me hands back exactly what this attaches, so
             * leaving them out meant the app could never see what the customer
             * had actually chosen - the booking screen fell back to English
             * while WhatsApp wrote to them in Odia, and neither could be told
             * from the other. `languageConfirmedAt` is the one that matters:
             * everywhere else in this codebase it is the test for "have they
             * chosen", because `language` always holds a value whether they
             * picked it or not.
             */
            /*
             * `noticesSeenAt` rides along because the bell is drawn on every
             * screen of the app, so the request that answers it is the request
             * the app makes first. Reading it separately would be a second
             * round trip to the same document to fetch one date.
             */
            .select("_id name phone address state area lat lon role language languageConfirmedAt noticesSeenAt photoUrl bookmarks")
            .lean();

        if (!user) {
            return res.status(401).json({ success: false, message: "Unauthorized: User not found" });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error("Auth middleware error:", error.message);
        return res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
    }
};

/**
 * The same check, but a stranger is allowed through.
 *
 * For a page that answers everybody and simply answers a signed-in person
 * better - the website's assistant, which explains the company to anyone and
 * can also read back the jobs of somebody who has an account. Returning 401 to
 * a visitor there would be wrong; so would quietly treating a signed-in
 * customer as a stranger. A bad or expired token is not an error here either,
 * it just means nobody is attached.
 */
const attachUserIfAny = async (req, res, next) => {
    try {
        const header = req.headers.authorization || "";
        const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        const token = req.cookies?.token || bearer;
        if (!token) return next();

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await userModel
            .findById(decoded.userId || decoded.id)
            .select("_id name phone language role")
            .lean();

        if (user) req.user = user;
    } catch {
        // No session, and that is a perfectly ordinary state here
    }

    return next();
};

module.exports = { isAuthenticated, attachUserIfAny };

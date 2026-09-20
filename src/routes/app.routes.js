const express = require("express");
const rateLimit = require("express-rate-limit");
const errors = require("../config/sentry");

const router = express.Router();

/**
 * Where a crash in the phone app goes.
 *
 * The server's own faults have been watched since Sentry went in, and the apps'
 * have not been watched at all: a screen that throws on somebody's handset in
 * Rasulgarh simply stops working for them, and nobody here ever hears of it.
 * The apps could carry their own Sentry, but that is a package, a megabyte and
 * a half of APK, and a second place to look.
 *
 * This is the cheap half of it. The app already has an error screen - see
 * Broke.js - and the screen tells us what it caught, in one small request, on
 * its way to showing the customer a button. The report lands in the same Sentry
 * project as everything else, tagged so it is obvious it came from a phone.
 *
 * Deliberately open, because a customer whose app has just broken has no token
 * worth trusting and may not be signed in at all. What stops it being a hole is
 * that it accepts almost nothing: a few short strings, no files, no lookups, no
 * writes to the database, and a hard limit per address.
 */
const reportLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many reports." },
});

/** Long enough to be a stack trace, short enough not to be a payload. */
const clip = (value, limit) => String(value ?? "").slice(0, limit);

router.post("/error", reportLimiter, (req, res) => {
    const message = clip(req.body?.message, 300).trim();

    // Nothing to report is not an error worth an error.
    if (!message) return res.status(200).json({ success: true });

    const where = clip(req.body?.screen, 80) || "unknown screen";
    const which = clip(req.body?.app, 40) || "app";

    console.error("[APP] " + which + " crashed on " + where + ": " + message);

    errors.report(new Error(message), "app." + which, {
        screen: where,
        version: clip(req.body?.version, 40),
        stack: clip(req.body?.stack, 4000),
    });

    return res.status(200).json({ success: true });
});

module.exports = router;

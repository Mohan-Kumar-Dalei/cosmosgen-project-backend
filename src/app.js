const errors = require("./config/sentry");
const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const redis = require("./config/redis");
const keyring = require("./services/keyring.service");

const authRoutes = require("./routes/auth.route");
const technicianRoutes = require("./routes/technician.routes");
const trackRoutes = require("./routes/track.routes");
const voiceRoutes = require("./routes/voice.routes");
const mapRoutes = require("./routes/map.routes");
const appRoutes = require("./routes/app.routes");
const customerRoutes = require("./routes/customer.routes");
const adminRoutes = require("./routes/admin.routes");
const webhookRoutes = require("./routes/webhook.routes");
const whatsappRoutes = require("./routes/whatsapp.routes");

const app = express();

const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim());

/**
 * Who may call this API from a browser.
 *
 * The list above is the real answer and it comes from the environment, so the
 * live server allows exactly what it is told to allow and nothing else.
 *
 * The one addition is a laptop. `expo start --web` runs the customer app on a
 * localhost port that changes with whatever else is already running, and every
 * one of those would otherwise have to be typed into CLIENT_ORIGINS before the
 * app could fetch anything - which is the difference between looking at a
 * screen and spending ten minutes working out why it is empty. A development
 * server has nothing worth protecting from a page on the same machine.
 *
 * Only off production. On the live box this branch never runs, so the API's
 * public CORS is unchanged: if the web build is to be pointed at production,
 * its origin goes in CLIENT_ORIGINS deliberately, by somebody who meant it.
 */
const isLocalhost = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

const corsOrigin = (origin, done) => {
    // A request with no Origin header is not a browser - curl, a webhook, the
    // apps themselves - and CORS has nothing to say about it.
    if (!origin) return done(null, true);

    if (CLIENT_ORIGINS.includes(origin)) return done(null, true);

    if (process.env.NODE_ENV !== "production" && isLocalhost(origin)) return done(null, true);

    return done(null, false);
};

// Behind the Render proxy - the rate limiter needs the real client IP
app.set("trust proxy", 1);

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use(compression());

app.use(cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
}));

/* ------------------------------------------------------------------ */
/* WEBHOOKS - these must come BEFORE express.json()                     */
/*                                                                      */
/* Razorpay and Meta both sign the raw request bytes. Once express.json */
/* has parsed the body, those bytes are gone and every signature check  */
/* fails. Each of these routers applies express.raw() itself.           */
/* ------------------------------------------------------------------ */
app.use("/api/webhook", webhookRoutes);
// The carrier, like the payment webhooks, cannot sign in and must not be
// rate limited alongside ordinary browser traffic - a busy afternoon of
// calls would otherwise start dropping mid-conversation.
app.use("/api/voice", voiceRoutes);
app.use("/api/whatsapp", whatsappRoutes);

/* ------------------------------------------------------------------ */
/* Everything below here gets normal JSON parsing                       */
/* ------------------------------------------------------------------ */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

/*
 * The outer envelope, and only that.
 *
 * Everything worth abusing already carries its own, tighter limiter beside
 * the route it guards - fifteen OTPs in fifteen minutes, ten bookings in an
 * hour, forty questions to the assistant in ten. This one exists to stop a
 * single address hammering the box, and nothing else.
 *
 * It was 120 a minute, which is not a lot of people. It counts per address,
 * and Indian mobile networks put hundreds of customers behind one - so twenty
 * people on the same carrier, each opening the app and costing half a dozen
 * requests, were sharing an allowance built for one. The limit that was meant
 * for an attacker was being spent by customers.
 */
app.use("/api", rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.API_RATE_LIMIT_PER_MINUTE) || 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests, please slow down." },
}));

app.get("/", (req, res) => {
    res.status(200).json({ success: true, message: "Server is working fine" });
});

/**
 * Whether the things this server leans on are actually there.
 *
 * "Server is working fine" above answers only that Node is up, which is the
 * one thing that was never in doubt. Everything that has gone quiet on this
 * box went quiet underneath it - a Redis with no URL falling back to memory,
 * a key ring with nothing in it, a cluster that dropped its connection - and
 * finding out meant grepping pm2 logs for a line printed once at boot, hours
 * ago, in a file that had since rotated.
 *
 * Deliberately open and deliberately thin. It names no host, no key and no
 * count that would tell a stranger anything worth knowing: for each piece,
 * whether it is up. Anybody may ask a building whether its lights are on.
 *
 * The status code is the part a monitor reads. Mongo being down is the server
 * being down - nothing it serves can be answered without it - so that is a
 * 503. Redis being down costs a cache, and the key ring being empty costs the
 * assistant; both leave every booking, every map and every payment working,
 * so they are reported inside a 200 rather than paging somebody at night.
 */
app.get("/api/health", async (req, res) => {
    const mongoUp = mongoose.connection.readyState === 1;

    let keys = 0;
    try {
        keys = (await keyring.health("gemini")).usable;
    } catch {
        // A key ring that cannot be counted is reported as empty, which is
        // what it amounts to for anything trying to use one.
    }

    return res.status(mongoUp ? 200 : 503).json({
        success: mongoUp,
        uptimeSeconds: Math.round(process.uptime()),
        mongo: mongoUp ? "up" : "down",

        // "memory" rather than "down": without a URL this is the documented
        // fallback and not a fault, and the two look identical from here.
        redis: redis.ready() ? "up" : "memory",

        geminiKeys: keys,
    });
});

app.use("/api/auth", authRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/track", trackRoutes);
app.use("/api/technician", technicianRoutes);
app.use("/api/map", mapRoutes);
app.use("/api/app", appRoutes);
app.use("/api/admin", adminRoutes);

app.use((req, res) => {
    /**
     * The voicebot's socket path, asked for as an ordinary request.
     *
     * That path only answers WebSocket upgrades, so anything else - a browser
     * opened to check the tunnel, or a provider probing the URL before it
     * connects - fell through to here and was told the route does not exist.
     * It does exist, and saying so is the difference between "my server is
     * broken" and "this URL is fine, it just needs a websocket".
     */
    if (req.path === "/voice-stream") {
        return res.status(200).json({
            success: true,
            message: "Voicebot socket is live here. Connect with a WebSocket, not a GET.",
        });
    }

    res.status(404).json({ success: false, message: "Route not found" });
});

/**
 * The last word, and it is always JSON.
 *
 * Without this Express answers an unhandled error with its own HTML page. The
 * apps and the panels all read `data.message` to decide what to put on screen,
 * find nothing in a page of markup, and fall back to their own vague line -
 * so a precise failure on the server arrived as "Could not send your
 * application" with no way to tell what had actually gone wrong.
 *
 * Multer is the one that made this worth fixing. It rejects a malformed
 * upload - a multipart body whose boundary is missing, a file over the limit -
 * by throwing, and every one of those was reaching the phone as a bare 500.
 */
app.use((err, req, res, _next) => {
    /*
     * Reported before it is answered.
     *
     * Everything that reaches here is a fault nobody wrote a catch for, which
     * makes it exactly the kind worth being told about - and until now it was
     * turned into a tidy JSON message and forgotten.
     */
    errors.report(err, "http", {
        method: req.method,
        path: req.originalUrl,
        status: err?.status || 500,
    });

    console.error("Unhandled error on " + req.method + " " + req.originalUrl + ":", err);

    if (res.headersSent) return;

    const upload = {
        LIMIT_FILE_SIZE: "That image is too large. Please choose a smaller one.",
        LIMIT_UNEXPECTED_FILE: "That file was not expected here.",
    }[err?.code];

    // A boundary the client never wrote, which is a malformed request rather
    // than a server fault - say so with a 400 instead of a blank 500
    const malformed = /boundary/i.test(err?.message || "");

    res.status(upload || malformed ? 400 : err?.status || 500).json({
        success: false,
        message: upload
            || (malformed ? "That upload was not readable. Please try again." : "Internal Server Error"),
    });
});

module.exports = app;
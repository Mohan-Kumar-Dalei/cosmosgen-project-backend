const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth.route");
const technicianRoutes = require("./routes/technician.routes");
const trackRoutes = require("./routes/track.routes");
const voiceRoutes = require("./routes/voice.routes");
const mapRoutes = require("./routes/map.routes");
const customerRoutes = require("./routes/customer.routes");
const adminRoutes = require("./routes/admin.routes");
const webhookRoutes = require("./routes/webhook.routes");
const whatsappRoutes = require("./routes/whatsapp.routes");

const app = express();

const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim());

// Behind the Render proxy - the rate limiter needs the real client IP
app.set("trust proxy", 1);

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use(compression());

app.use(cors({
    origin: CLIENT_ORIGINS,
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

app.use("/api", rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests, please slow down." },
}));

app.get("/", (req, res) => {
    res.status(200).json({ success: true, message: "Server is working fine" });
});

app.use("/api/auth", authRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/track", trackRoutes);
app.use("/api/technician", technicianRoutes);
app.use("/api/map", mapRoutes);
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

module.exports = app;
const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth.route");
const technicianRoutes = require("./routes/technician.routes");
const mapRoutes = require("./routes/map.routes");
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
app.use("/api/technician", technicianRoutes);
app.use("/api/map", mapRoutes);
app.use("/api/admin", adminRoutes);

app.use((req, res) => {
    res.status(404).json({ success: false, message: "Route not found" });
});

module.exports = app;
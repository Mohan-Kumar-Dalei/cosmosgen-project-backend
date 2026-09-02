const { Server } = require("socket.io");
const cookie = require("cookie");
const jwt = require("jsonwebtoken");

const userModel = require("../models/user.model");
const technicianModel = require("../models/technician.model");
const adminModel = require("../models/admin.model");
const messageModel = require("../models/message.model");
const aiService = require("../services/ai.service");
const { createMemory, queryMemory } = require("../services/vector.service");
const { setIo, userRoom, techRoom, adminRoom } = require("./socket.instance");

const parseCookies = (header = "") => {
    const fn = cookie.parseCookie || cookie.parse;
    try {
        return fn(header) || {};
    } catch (e) {
        console.error("[SOCKET] cookie parse threw:", e.message);
        return {};
    }
};

function initSocketServer(httpServer) {
    const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS || "http://localhost:5173")
        .split(",")
        .map((o) => o.trim());

    console.log("[SOCKET] Initializing. Allowed origins:", CLIENT_ORIGINS);

    const io = new Server(httpServer, {
        cors: {
            origin: CLIENT_ORIGINS,
            methods: ["GET", "POST"],
            credentials: true,
        },
        pingTimeout: 30000,
    });

    setIo(io);

    io.engine.on("connection_error", (err) => {
        console.error("[SOCKET] Engine-level connection_error:", { message: err.message, code: err.code });
    });

    /**
     * AUTH
     *
     * The client tells us which role it's connecting as (socket.handshake.auth.role).
     * This matters because a browser can hold all three auth cookies at once
     * (e.g. during testing, when you're logged in as admin, technician, and
     * customer in the same browser) - without an explicit role, we'd always
     * pick the same cookie first and silently connect as the wrong actor.
     */
    io.use(async (socket, next) => {
        try {
            const cookies = parseCookies(socket.handshake.headers?.cookie || "");
            const requestedRole = socket.handshake.auth?.role;

            if (!Object.keys(cookies).length) {
                console.warn("[SOCKET] Auth failed: no cookies sent. Check withCredentials on the client.");
                return next(new Error("Authentication error: no cookies sent"));
            }

            if (requestedRole === "admin") {
                if (!cookies.adminToken) return next(new Error("No admin session"));
                const decoded = jwt.verify(cookies.adminToken, process.env.ADMIN_JWT_SECRET);
                const admin = await adminModel.findById(decoded.adminId).select("_id name role isActive").lean();
                if (!admin || !admin.isActive) return next(new Error("Admin not found"));
                socket.role = "admin";
                socket.actor = admin;
                return next();
            }

            if (requestedRole === "technician") {
                if (!cookies.techToken) return next(new Error("No technician session"));
                const decoded = jwt.verify(cookies.techToken, process.env.JWT_SECRET);
                const tech = await technicianModel.findById(decoded.techId).select("_id name").lean();
                if (!tech) return next(new Error("Technician not found"));
                socket.role = "technician";
                socket.actor = tech;
                return next();
            }

            if (requestedRole === "customer") {
                if (!cookies.token) return next(new Error("No customer session"));
                const decoded = jwt.verify(cookies.token, process.env.JWT_SECRET);
                const user = await userModel
                    .findById(decoded.userId || decoded.id)
                    .select("_id name phone area state lat lon")
                    .lean();
                if (!user) return next(new Error("User not found"));
                socket.role = "customer";
                socket.actor = user;
                return next();
            }

            // Fallback for older clients that don't send a role yet.
            // Should not be hit once every panel uses createRoleSocket().
            console.warn("[SOCKET] No role sent by client, falling back to cookie priority");
            if (cookies.adminToken) {
                const decoded = jwt.verify(cookies.adminToken, process.env.ADMIN_JWT_SECRET);
                const admin = await adminModel.findById(decoded.adminId).select("_id name role isActive").lean();
                if (admin?.isActive) {
                    socket.role = "admin";
                    socket.actor = admin;
                    return next();
                }
            }
            if (cookies.techToken) {
                const decoded = jwt.verify(cookies.techToken, process.env.JWT_SECRET);
                const tech = await technicianModel.findById(decoded.techId).select("_id name").lean();
                if (tech) {
                    socket.role = "technician";
                    socket.actor = tech;
                    return next();
                }
            }
            if (cookies.token) {
                const decoded = jwt.verify(cookies.token, process.env.JWT_SECRET);
                const user = await userModel.findById(decoded.userId || decoded.id).select("_id name phone area state lat lon").lean();
                if (user) {
                    socket.role = "customer";
                    socket.actor = user;
                    return next();
                }
            }

            return next(new Error("Authentication error: no valid session found"));
        } catch (err) {
            console.error("[SOCKET] Auth exception:", err.name, "-", err.message);
            return next(new Error("Authentication error: invalid token"));
        }
    });

    io.on("connection", (socket) => {
        const actorId = String(socket.actor._id);
        console.log(`[SOCKET] Connected: role=${socket.role} id=${actorId}`);

        if (socket.role === "admin") {
            socket.join(adminRoom());
            return;
        }

        if (socket.role === "technician") {
            socket.join(techRoom(actorId));
            registerTechnicianHandlers(socket, actorId);
            return;
        }

        socket.join(userRoom(actorId));
        registerCustomerHandlers(socket, actorId);
    });

    return io;
}

/* ------------------------------------------------------------------ */
/* TECHNICIAN                                                          */
/* ------------------------------------------------------------------ */

function registerTechnicianHandlers(socket, techId) {
    let lastWrite = 0;
    const MIN_WRITE_GAP_MS = 10000;

    socket.on("tech:location", async (payload = {}) => {
        const lat = Number(payload.lat);
        const lon = Number(payload.lon ?? payload.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;

        const now = Date.now();
        if (now - lastWrite < MIN_WRITE_GAP_MS) return;
        lastWrite = now;

        try {
            await technicianModel.updateOne(
                { _id: techId },
                { location: { type: "Point", coordinates: [lon, lat] }, lastLocationAt: new Date() }
            );
        } catch (err) {
            console.error("[SOCKET] tech:location write failed:", err.message);
        }
    });
}

/* ------------------------------------------------------------------ */
/* CUSTOMER (AI chat)                                                  */
/* ------------------------------------------------------------------ */

function registerCustomerHandlers(socket, userIdString) {
    socket.on("ai-message", async (messagePayload = {}) => {
        const chatId = String(messagePayload.chat || "").trim();
        const content = String(messagePayload.content || "").trim();

        console.log(`[SOCKET] ai-message from ${userIdString}: "${content.slice(0, 60)}"`);

        if (!chatId || !content) {
            console.warn("[SOCKET] ai-message dropped: missing chatId or content");
            return;
        }
        if (content.length > 2000) {
            socket.emit("ai-response", { content: "That message is too long. Please shorten it and try again.", chat: chatId });
            return;
        }

        try {
            const [vectors, chatHistory] = await Promise.all([
                aiService.generateVector(content).catch((e) => {
                    console.error("[SOCKET] generateVector failed:", e.message);
                    return [];
                }),
                messageModel
                    .find({ chat: chatId, user: userIdString })
                    .sort({ createdAt: -1 })
                    .limit(20)
                    .select("role content")
                    .lean(),
            ]);

            let memory = [];
            if (vectors.length > 0) {
                memory = await queryMemory({
                    queryVector: vectors,
                    limit: 3,
                    metadata: { user: userIdString },
                }).catch((e) => {
                    console.error("[SOCKET] queryMemory failed:", e.message);
                    return [];
                });
            }

            const shortTermMemory = chatHistory.reverse().map((item) => ({
                role: item.role === "model" ? "model" : "user",
                parts: [{ text: item.content }],
            }));

            const memoryText = memory.map((m) => m?.metadata?.text).filter(Boolean).join(" | ");
            const currentTurn = {
                role: "user",
                parts: [{
                    text: memoryText
                        ? `[Long term memory from previous chats]:\n${memoryText}\n\n[Current user message]:\n${content}`
                        : content,
                }],
            };

            const response = await aiService.generateResponse(
                [...shortTermMemory, currentTurn],
                socket.actor,
                content,
                messagePayload.location
            );

            socket.emit("ai-response", { content: response, chat: chatId });
            console.log("[SOCKET] ai-response emitted");

            // Background save - fire and forget
            (async () => {
                try {
                    const userMessage = await messageModel.create({
                        chat: chatId, user: userIdString, content: content, role: "user",
                    });
                    if (vectors.length > 0) {
                        await createMemory({
                            vectors,
                            messageId: userMessage._id,
                            metadata: { chat: chatId, user: userIdString, text: content },
                        }).catch((e) => console.error("[SOCKET] createMemory (user) failed:", e.message));
                    }
                    const responseMessage = await messageModel.create({
                        chat: chatId, user: userIdString, content: response, role: "model",
                    });
                    const responseVectors = await aiService.generateVector(response).catch(() => []);
                    if (responseVectors.length > 0) {
                        await createMemory({
                            vectors: responseVectors,
                            messageId: responseMessage._id,
                            metadata: { chat: chatId, user: userIdString, text: response },
                        }).catch((e) => console.error("[SOCKET] createMemory (model) failed:", e.message));
                    }
                } catch (bgErr) {
                    console.error("[SOCKET] Background save error:", bgErr.message);
                }
            })();
        } catch (error) {
            console.error("[SOCKET] ai-message handler exception:", error);
            socket.emit("ai-response", {
                content: "Sorry, something went wrong. Please try again in a moment.",
                chat: chatId,
            });
        }
    });
}

module.exports = initSocketServer;
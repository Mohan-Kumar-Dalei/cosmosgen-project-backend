const { Server } = require("socket.io");
const cookie = require("cookie");
const jwt = require("jsonwebtoken");
const userModel = require("../models/user.model");
const aiService = require("../services/ai.service");
const messageModel = require("../models/message.model");
const { createMemory, queryMemory } = require("../services/vector.service");
let ioInstance;
function initSocketServer(httpServer) {
    const io = new Server(httpServer, {
        cors: {
            origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
            methods: ["GET", "POST"],
            allowedHeaders: ["Content-Type", "Authorization"],
            credentials: true
        }
    });
    ioInstance = io;

    // 🛡️ AUTHENTICATION MIDDLEWARE
    io.use(async (socket, next) => {
        try {
            // FIX: cookie.parseCookie nahi hota, sirf cookie.parse hota hai
            const cookies = cookie.parseCookie(socket.handshake.headers?.cookie || "");

            if (!cookies.token) {
                return next(new Error("Authentication error: No token provided"));
            }

            const decoded = jwt.verify(cookies.token, process.env.JWT_SECRET);
            const user = await userModel.findById(decoded.userId || decoded.id);

            if (!user) return next(new Error("User not found"));

            socket.user = user;
            next();
        } catch (err) {
            console.error("🚨 Socket Auth Error:", err.message);
            next(new Error("Authentication error: Invalid token"));
        }
    });

    io.on("connection", (socket) => {
        console.log(`🟢 User connected: ${socket.user._id}`);
        socket.join(`user_${socket.user._id.toString()}`);
        socket.on("ai-message", async (messagePayload) => {
            try {
                const userIdString = socket.user._id.toString();

                // ==========================================
                // 🚀 FAST TRACK: Turant Context aur Reply nikalo
                // ==========================================

                // 1. User message ka vector banao aur Purani chat nikalo (Concurrently)
                const [vectors, chatHistory] = await Promise.all([
                    aiService.generateVector(messagePayload.content),
                    messageModel.find({ chat: messagePayload.chat })
                        .sort({ createdAt: -1 })
                        .limit(20)
                        .lean()
                        .then(messages => messages.reverse())
                ]);

                // 2. Vector use karke Pinecone se RAG Memory nikalo
                const memory = await queryMemory({
                    queryVector: vectors,
                    limit: 3,
                    metadata: { user: userIdString }
                });

                // 3. 🧠 SORT TERM MEMORY (Pichli taaza chat history DB se)
                const sortTermMemory = chatHistory.map(item => ({
                    role: item.role === "ai" ? "model" : "user", // Gemini sirf 'user' ya 'model' samajhta hai
                    parts: [{ text: item.content }]
                }));

                // 4. 🧠 LONG TERM MEMORY + NAYA MESSAGE (Pinecone facts + current message)
                // Isko hum ek "user" prompt bana kar bhej rahe hain taaki AI turant answer de aur error na aaye
                const longTermMemory = {
                    role: "user",
                    parts: [{
                        text: `[Here is some Long Term Memory context from previous chats]:\n${memory.map(item => item.metadata.text).join(" | ")}\n\n[Here is the Current User Message]:\n${messagePayload.content}`
                    }]
                };

                // 5. generate response from AI using both short-term and long-term memory
                const chatHistoryMemory = [...sortTermMemory, longTermMemory];
                const response = await aiService.generateResponse(
                    chatHistoryMemory,
                    socket.user,
                    messagePayload.content,
                    messagePayload.location
                );

                // 6. ⚡ send to frontend without waiting for DB save (background save)
                socket.emit('ai-response', {
                    content: response,
                    chat: messagePayload.chat
                });

                // ==========================================
                // 🐢 BACKGROUND TRACK: save in DB with chilling
                // ==========================================
                (async () => {
                    try {
                        // A. User message save in DB
                        const userMessage = await messageModel.create({
                            chat: messagePayload.chat,
                            user: socket.user._id,
                            content: messagePayload.content,
                            role: "user"
                        });

                        // B. User Vector save in Pinecone(RAG)
                        await createMemory({
                            vectors: vectors,
                            messageId: userMessage._id,
                            metadata: {
                                chat: messagePayload.chat,
                                user: userIdString,
                                text: messagePayload.content
                            }
                        });

                        // C. AI reply message save in DB
                        const responseMessage = await messageModel.create({
                            chat: messagePayload.chat,
                            user: socket.user._id,
                            content: response,
                            role: "model"
                        });

                        // D. AI reply message save in Pinecone(RAG)
                        const responseVectors = await aiService.generateVector(response);
                        await createMemory({
                            vectors: responseVectors,
                            messageId: responseMessage._id,
                            metadata: {
                                chat: messagePayload.chat,
                                user: userIdString,
                                text: response
                            }
                        });

                    } catch (bgErr) {
                        console.error("🚨 Background Database Save Error:", bgErr);
                    }
                })(); // IIFE function

            } catch (error) {
                console.error("🚨 AI Message Handling Error:", error);
                //after error, send a generic error message to the client
                socket.emit('ai-response', {
                    content: "Sorry, something went wrong while processing your message. Please try again later.",
                    chat: messagePayload?.chat
                });
            }
        });
    });

    initSocketServer.getIo = () => {
        if (!ioInstance) {
            throw new Error("Socket.io is not initialized yet!");
        }
        return ioInstance;
    };
}

module.exports = initSocketServer;
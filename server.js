require("dotenv").config();
const cron = require('node-cron');
const { createServer } = require("http");
const app = require("./src/app");
const connectDB = require("./src/config/db");
const initSocketServer = require("./src/sockets/socketManager");
const { promoteDueScheduledTickets } = require("./src/services/dispatch.service");
const PORT = process.env.PORT || 3000;
const httpServer = createServer(app);

const startServer = async () => {
    // DB pehle connect karo, warna server chalu ho jayega aur har request 500 degi
    await connectDB();
    initSocketServer(httpServer);

    httpServer.listen(PORT, () => {
        console.log(`Server + socket.io running on port ${PORT}`);
    });

    setInterval(() => {
        promoteDueScheduledTickets().catch((err) =>
            console.error("Scheduled promotion failed:", err.message)
        );
    }, 5 * 60 * 1000);

    cron.schedule('30 9 * * *', async () => {
    await promoteDueScheduledTickets();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata" // Server duniya mein kahin bhi ho, time India ka lega
});
};

startServer();

// // Render SIGTERM bhejta hai deploy ke waqt - clean shutdown
// process.on("SIGTERM", () => {
//     console.log("SIGTERM received, closing server...");
//     httpServer.close(() => process.exit(0));
// });

// process.on("unhandledRejection", (reason) => {
//     console.error("Unhandled rejection:", reason);
// });
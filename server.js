require("dotenv").config();
const cron = require("node-cron");
const { createServer } = require("http");
const app = require("./src/app");
const connectDB = require("./src/config/db");
const initSocketServer = require("./src/sockets/socketManager");
const { promoteDueScheduledTickets } = require("./src/services/dispatch.service");

const PORT = process.env.PORT || 3000;
const httpServer = createServer(app);

const startServer = async () => {
    // DB first - otherwise the server accepts requests it can't answer
    await connectDB();
    initSocketServer(httpServer);

    httpServer.listen(PORT, () => {
        console.log("Server + socket.io running on port " + PORT);
    });

    // Safety net in case a scheduled job's date passes while nobody is
    // closing tickets
    setInterval(() => {
        promoteDueScheduledTickets().catch((err) =>
            console.error("Scheduled promotion failed:", err.message)
        );
    }, 5 * 60 * 1000);

    cron.schedule("30 9 * * *", async () => {
        await promoteDueScheduledTickets();
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata",
    });
};

// Without this catch a failed DB connect became an unhandled rejection,
// which Node kills the process for - silently. The symptom was the frontend
// failing to open a socket with no error anywhere to explain it.
startServer().catch((err) => {
    console.error("SERVER FAILED TO START:", err);
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
});

// process.on("uncaughtException", (err) => {
//     console.error("Uncaught exception:", err);
//     process.exit(1);
// });

// process.on("SIGTERM", () => {
//     console.log("SIGTERM received, closing server...");
//     httpServer.close(() => process.exit(0));
// });
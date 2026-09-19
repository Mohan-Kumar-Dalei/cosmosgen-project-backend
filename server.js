require("dotenv").config();

/*
 * Before anything else, so the SDK can wrap what loads after it.
 *
 * It does nothing at all without SENTRY_DSN in the environment, which is how a
 * laptop and a fresh clone are meant to run - see src/config/sentry.js.
 */
const errors = require("./src/config/sentry");
errors.init();

const cron = require("node-cron");
const { createServer } = require("http");
const app = require("./src/app");
const connectDB = require("./src/config/db");
const initSocketServer = require("./src/sockets/socketManager");
const initVoicebotServer = require("./src/sockets/voicebot.socket");
const { promoteDueScheduledTickets } = require("./src/services/dispatch.service");
const catalog = require("./src/services/catalog.service");
const keyring = require("./src/services/keyring.service");

const PORT = process.env.PORT || 3000;
const httpServer = createServer(app);

const startServer = async () => {
    // DB first - otherwise the server accepts requests it can't answer
    await connectDB();

    // The catalogue moves from the file into the database on first boot and is
    // read back into memory on every boot after that, so the WhatsApp menu, the
    // assistant and the website all see whatever the office last changed
    await catalog.init();

    // And the keys, so anything asking "is the assistant configured?" before
    // the first model call has a real answer rather than an empty ring
    await keyring.warm();

    initSocketServer(httpServer);

    // Exotel talks to the voicebot over a raw WebSocket on its own path, so it
    // sits beside socket.io on the same server rather than inside it
    initVoicebotServer(httpServer);

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
startServer().catch(async (err) => {
    console.error("SERVER FAILED TO START:", err);
    errors.report(err, "server.start");

    // Sent before the exit, or the one error worth having is the one that
    // never left the box.
    await errors.flush();
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    errors.report(reason, "unhandledRejection");
});

/*
 * An uncaught exception, and then out.
 *
 * This was commented out, which left the worst case running: Node prints the
 * stack and carries on with whatever half-finished state caused it - a socket
 * mid-handshake, a ticket saved but not announced. pm2 restarts a process that
 * exits; it cannot do anything about one that stays up and lies.
 *
 * So it is reported, flushed, and the process ends. A restart takes a second
 * and leaves the system in a state somebody can reason about.
 */
process.on("uncaughtException", async (err) => {
    console.error("Uncaught exception:", err);
    errors.report(err, "uncaughtException");

    await errors.flush();
    process.exit(1);
});

// process.on("SIGTERM", () => {
//     console.log("SIGTERM received, closing server...");
//     httpServer.close(() => process.exit(0));
// });
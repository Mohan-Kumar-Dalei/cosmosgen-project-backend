const Sentry = require("@sentry/node");

/**
 * Where an error goes when nobody is watching the terminal.
 *
 * There are two hundred `console.error` calls in this codebase and every one
 * of them writes to a log file on a box in Mumbai. That is fine while somebody
 * is ssh'd in watching it and useless the rest of the time - which is most of
 * the time. Two of this week's bugs proved it: a require cycle left
 * notifyCustomerArrived undefined for days, and every customer push was being
 * refused for want of an FCM key. Both were printing the reason, in full, to a
 * file nobody had open.
 *
 * So errors are also sent somewhere that remembers them, groups the repeats,
 * keeps the stack, and sends an email the first time something new breaks.
 *
 * Nothing here is required for the server to run. No DSN, no reporting, and
 * every call below turns into a no-op - which is exactly what a developer
 * running this on a laptop wants.
 */

const DSN = String(process.env.SENTRY_DSN || "").trim();

/** Whether anything is actually being sent. Read by the health endpoint. */
const watching = () => Boolean(DSN);

/**
 * Anything that could carry a customer's details out of the building.
 *
 * Sentry does its own scrubbing and it is on by default, but the rule that
 * matters is not to rely on somebody else's list. A stack trace here can hold
 * a phone number, a door code or a bearer token, and none of those belong on a
 * third party's server for thirty days.
 */
const SECRET_KEYS = /phone|otp|code|token|password|secret|authorization|address|lat|lon|dsn|key/i;

/** A ten digit Indian mobile number, wherever it turns up in a string. */
const PHONE = /\b[6-9]\d{9}\b/g;

const scrub = (value, depth = 0) => {
    if (depth > 6 || value == null) return value;

    if (typeof value === "string") return value.replace(PHONE, "[phone]");

    if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));

    if (typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = SECRET_KEYS.test(key) ? "[removed]" : scrub(item, depth + 1);
        }
        return out;
    }

    return value;
};

/**
 * One error, once.
 *
 * The free allowance is five thousand events a month, which is generous until
 * something starts failing in a loop - a socket that reconnects every second,
 * a cron that throws on every tick - and spends a month's worth before
 * breakfast. The same message is sent at most once a minute; the rest are
 * counted and dropped, because the tenth copy of an error tells nobody
 * anything the first one did not.
 */
const RETELL_MS = 60 * 1000;
const recent = new Map();

const tooSoon = (key) => {
    const now = Date.now();
    const last = recent.get(key) || 0;

    if (now - last < RETELL_MS) return true;

    recent.set(key, now);

    // The map is a cache, not a record. Anything older than the window is of
    // no further interest and is dropped rather than held for the process's
    // whole life.
    if (recent.size > 500) {
        for (const [k, at] of recent) if (now - at > RETELL_MS) recent.delete(k);
    }

    return false;
};

const init = () => {
    if (!DSN) {
        console.log("[SENTRY] no DSN set - errors stay in the log, as they were");
        return;
    }

    Sentry.init({
        dsn: DSN,
        environment: process.env.SENTRY_ENV || process.env.NODE_ENV || "development",

        /*
         * Errors only.
         *
         * Performance tracing is the half of Sentry that costs quota by the
         * transaction rather than by the fault, and this server's slow paths
         * are already known: Gemini, Google Routes, WhatsApp. Turning it on
         * would spend the free allowance measuring what we can already read.
         */
        tracesSampleRate: 0,

        /*
         * Never the request body, never the headers, never a user's address.
         *
         * `sendDefaultPii: false` is what the SDK has always taken and it
         * still works; version 10 replaced it with a list that names each
         * category, and will drop the old flag in 11. Both are written here
         * on purpose - the new one is what the SDK reads, the old one keeps
         * this correct if the package is ever pinned back.
         */
        sendDefaultPii: false,
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpBodies: [],
        },

        beforeSend(event) {
            try {
                if (event.request) {
                    delete event.request.cookies;
                    delete event.request.headers;
                    delete event.request.data;
                }

                if (event.extra) event.extra = scrub(event.extra);
                if (event.contexts) event.contexts = scrub(event.contexts);
                if (event.message) event.message = String(event.message).replace(PHONE, "[phone]");

                return event;
            } catch {
                // A scrubber that throws must not become the reason an error
                // goes unreported - but an unscrubbed event must not go out
                // either, so it is dropped.
                return null;
            }
        },
    });

    console.log("[SENTRY] watching (" + (process.env.SENTRY_ENV || "development") + ")");
};

/**
 * Report an error that has already been handled.
 *
 * Called beside a console.error rather than instead of it: the log is what
 * somebody reads while they are looking at the box, and this is what finds
 * them when they are not.
 *
 * `where` is a short name for the thing that failed - "ride.sync",
 * "whatsapp.send" - and `context` is whatever would make the error make sense
 * a week later: a ticket number, a vendor's id, the id of the customer. Never
 * a name, never a number; see the scrubber above.
 */
const report = (error, where, context = {}) => {
    if (!DSN) return;

    try {
        const key = where + "|" + String(error?.message || error).slice(0, 120);
        if (tooSoon(key)) return;

        Sentry.withScope((scope) => {
            scope.setTag("where", where);
            scope.setExtras(scrub(context));
            Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
        });
    } catch {
        // Reporting must never be the thing that breaks a request.
    }
};

/** Everything still in the queue, before the process is allowed to die. */
const flush = (ms = 2000) => (DSN ? Sentry.flush(ms).catch(() => false) : Promise.resolve(true));

module.exports = { init, report, flush, watching, Sentry };

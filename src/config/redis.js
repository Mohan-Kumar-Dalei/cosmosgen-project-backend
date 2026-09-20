const Redis = require("ioredis");

/**
 * The answers worth keeping between restarts.
 *
 * There is already a cache in this codebase - a Map in map.controller with a
 * day's life on it - and for a single process it does the job. What it cannot
 * do is survive a deploy, and it cannot be shared: pm2 restarts on every push,
 * and the first customer to open a tracking screen afterwards pays for a fresh
 * reverse geocode, and the one after that pays again for the same street.
 *
 * On a ride that is felt rather than counted. The name under the bike - "Near
 * Rasulgarh" - is bought while the customer is watching, and a cold cache is a
 * second of waiting on somebody else's server in the middle of a live map.
 * Mohan's words for it: no load on the map.
 *
 * Redis holds those answers instead. It is not required: with no REDIS_URL
 * every call below quietly does nothing, the Map in front of it still works,
 * and a developer on a laptop needs nothing installed.
 */

const URL = String(process.env.REDIS_URL || "").trim();

let client = null;
let up = false;

const connect = () => {
    if (!URL) {
        console.log("[REDIS] no REDIS_URL - caching stays in memory only");
        return;
    }

    client = new Redis(URL, {
        // A cache is never worth delaying a request for. If Redis is slow or
        // gone, the call gives up quickly and whatever asked goes and fetches
        // the real answer, which is what it would have done anyway.
        connectTimeout: 2000,
        commandTimeout: 500,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,

        // Backing off rather than hammering: a Redis that is down stays down
        // for a few seconds, and reconnecting every millisecond would fill the
        // log and the event loop with nothing.
        retryStrategy: (times) => Math.min(times * 500, 10000),
    });

    client.on("ready", () => {
        up = true;
        console.log("[REDIS] connected");
    });

    client.on("error", (error) => {
        if (up) console.warn("[REDIS] " + error.message);
        up = false;
    });

    client.on("end", () => { up = false; });
};

connect();

/** Whether anything is actually being cached. Read by the health endpoint. */
const ready = () => up;

/**
 * What was stored under this key, or null - never a throw, never a wait worth
 * noticing.
 */
const remembered = async (key) => {
    if (!up) return null;

    try {
        const raw = await client.get(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
};

/** Keep this answer for a while. Failure here costs a cache hit and nothing else. */
const remember = async (key, value, seconds) => {
    if (!up || value === undefined) return;

    try {
        await client.set(key, JSON.stringify(value), "EX", Math.max(1, Math.round(seconds)));
    } catch {
        // A cache that cannot be written is a cache that will be missed later,
        // which is the whole of the damage.
    }
};

/** Drop one. */
const forget = async (key) => {
    if (!up) return;
    try { await client.del(key); } catch { /* see above */ }
};

module.exports = { ready, remembered, remember, forget };

const { GoogleGenAI } = require("@google/genai");
const ApiKey = require("../models/apiKey.model");
const { ENV_KEYS } = require("../config/apiKeys");

/**
 * Which key the platform is spending, and what happens when it runs dry.
 *
 * Every Gemini call in this codebase used to build its own client at import
 * time from one environment variable. That has a failure mode the office
 * cannot do anything about: the free tier stops at a few hundred calls a day,
 * and at that moment the WhatsApp assistant, the website assistant, the
 * service drafter and the voice calls all start failing together until
 * somebody with server access edits a file. The fix is not a bigger quota - it
 * is being able to keep three free keys in the office's own screen and step
 * onto the next one the instant the provider says the first is finished.
 *
 * So callers ask here instead of holding a client. The order is the office's,
 * the counting is per key per day, and a key the provider refuses for quota is
 * stepped past for the rest of that day rather than retried into the ground.
 *
 * The key in the server's own settings is still honoured and still comes last.
 * It is given a row of its own at boot - a meter with no secret in it - so
 * that the platform's busiest key is not the one nobody can see a number for.
 * An empty collection means the platform behaves exactly as it did before any
 * of this existed, which is what makes it safe to deploy before anybody has
 * typed a key into the screen.
 */

/** Today, as the key rows record it. */
const today = () => new Date().toISOString().slice(0, 10);

/*
 * Clients are expensive to build and hold a connection pool, so one per key
 * is kept for the life of the process. Keyed by the secret itself, which means
 * a key edited in the office gets a new client without anything being purged.
 */
const clients = new Map();

const clientFor = (secret) => {
    if (!clients.has(secret)) clients.set(secret, new GoogleGenAI({ apiKey: secret }));
    return clients.get(secret);
};

/*
 * How many keys were usable the last time anybody looked.
 *
 * Some callers have to answer "is this feature configured at all?" without
 * being able to wait for a query - the telephony check runs on a webhook that
 * must answer in milliseconds. They get this, which is a fact about a moment
 * ago rather than about now, and that is the right trade for the question they
 * are asking.
 */
let lastUsable = 0;

/**
 * The keys worth trying, best first.
 *
 * Read fresh on every call rather than cached. It is one small indexed query
 * against a collection with a handful of rows, and the alternative is a
 * process that carries on spending a key the office disabled two minutes ago.
 */
const candidates = async (provider) => {
    const rows = await ApiKey.find({ provider, isActive: true })
        .sort({ order: 1, createdAt: 1 })
        .select("+secret")
        .lean();

    const day = today();

    const usable = rows
        // An env row carries no secret of its own - it is the meter for the
        // one in the server's settings, and stands or falls with it
        .map((row) => (row.source === "env"
            ? { ...row, secret: process.env[row.envVar] || "" }
            : row))
        .filter((row) => {
            // A daily quota comes back at midnight, so yesterday's exhaustion
            // says nothing about today
            const spent = row.day === day ? row.usedToday : 0;
            const exhaustedToday = row.exhaustedAt
                && new Date(row.exhaustedAt).toISOString().slice(0, 10) === day;

            if (exhaustedToday) return false;
            if (row.dailyLimit > 0 && spent >= row.dailyLimit) return false;

            return Boolean(row.secret);
        });

    if (provider === "gemini") lastUsable = usable.length;

    return usable;
};

/** Enough to try with, as far as anybody knows. Never queries. */
const seemsConfigured = () => Boolean(process.env.GEMINI_API_KEY) || lastUsable > 0;

/*
 * Whether the key in the server's own settings has a row to be counted
 * against. Until it does - a database that was down at boot, a first ever
 * start - the ring uses that key directly and counts nothing, which is the
 * right way round: answering the customer matters more than the tally.
 */
let envRowKnown = false;

/**
 * Read the ring once at boot, and give the environment's own key a meter.
 *
 * The row created here holds no secret. It exists so that calls made on the
 * key in the server's settings appear on the developer platform beside the
 * managed ones - without it, the platform's busiest key is the one nobody can
 * see. It sits last in the queue by default, so a key the office adds is
 * preferred over the one that needs a deploy to change.
 */
const warm = async () => {
    try {
        for (const spec of ENV_KEYS) {
            // A row for every key that is actually set, not only the ones the
            // ring can choose between. The others are meters: they let the
            // platform say how much of a free tier today has eaten, and let a
            // limit be put on one before the provider does it for us.
            if (!process.env[spec.envVar]) continue;

            await ApiKey.updateOne(
                { provider: spec.provider, source: "env", envVar: spec.envVar },
                {
                    $set: { tail: String(process.env[spec.envVar]).slice(-4) },
                    $setOnInsert: {
                        label: spec.label + " (server settings)",
                        model: "",
                        order: 1000,
                        isActive: true,
                        dailyLimit: 0,
                    },
                },
                { upsert: true }
            );

            if (spec.provider === "gemini") envRowKnown = true;
        }

        await candidates("gemini");

        console.log("Key ring: " + lastUsable + " Gemini key(s) ready"
            + (process.env.GEMINI_API_KEY ? " (the server's own included)" : ""));
    } catch (error) {
        console.error("Key ring could not be read, falling back to the environment:", error.message);
    }
};

/**
 * Mark one call against a provider that the ring does not choose between.
 *
 * The Gemini ring counts as a side effect of picking a key. Every other
 * provider - the WhatsApp send, the ImageKit upload, the geocode, the Sarvam
 * round trip - has exactly one key and no choice to make, so the counting has
 * to be asked for at the point the request happens. One line at each of those
 * points is what turns "we are on free tiers somewhere" into a number per day
 * per provider.
 *
 * Never awaited and never able to throw: a counter is not worth failing a
 * customer's message over. The whole roll-the-day-or-add-one decision is a
 * single atomic pipeline update, so two calls landing together cannot lose one
 * another's increment.
 */
const count = (provider) => {
    const day = today();

    ApiKey.updateOne(
        { provider, source: "env" },
        [{
            $set: {
                day,
                usedToday: {
                    $cond: [{ $eq: ["$day", day] }, { $add: [{ $ifNull: ["$usedToday", 0] }, 1] }, 1],
                },
                usedTotal: { $add: [{ $ifNull: ["$usedTotal", 0] }, 1] },
                lastUsedAt: "$$NOW",

                /*
                 * And the day that just ended is filed before it is lost.
                 *
                 * Every expression in one $set sees the document as it was
                 * before the stage, so "$day" and "$usedToday" here are still
                 * yesterday's - which is exactly what wants keeping. A row
                 * that has never counted anything has no day to file.
                 */
                history: {
                    $cond: [
                        { $or: [{ $eq: ["$day", day] }, { $not: [{ $ifNull: ["$day", false] }] }] },
                        { $ifNull: ["$history", []] },
                        {
                            $slice: [
                                {
                                    $concatArrays: [
                                        { $ifNull: ["$history", []] },
                                        [{ day: "$day", used: { $ifNull: ["$usedToday", 0] } }],
                                    ],
                                },
                                -14,
                            ],
                        },
                    ],
                },
            },
        }],
        // Mongoose refuses an array update without this, and the refusal
        // arrives as a rejected promise - which the catch below would have
        // swallowed in silence, leaving every counter on nought
        { updatePipeline: true }
    ).catch((error) => {
        // A missing row or an unreachable database means one uncounted call
        console.warn("Key usage not counted for " + provider + ":", error.message);
    });
};

/** What the provider says when a key has nothing left to give. */
const isQuota = (error) => {
    const text = (error?.message || "") + " " + (error?.status || "");
    return /429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(text);
};

/** And what it says when the key is wrong rather than spent. */
const isRejected = (error) => {
    const text = (error?.message || "") + " " + (error?.status || "");
    return /401|403|API key not valid|API_KEY_INVALID|PERMISSION_DENIED|unauthenticated/i.test(text);
};

/**
 * And what it says when the model itself is busy rather than the key spent.
 *
 * "This model is currently experiencing high demand" is a 503, and it is the
 * single most common thing in this server's error log. It is also the one
 * error here that is temporary: the key is fine, the prompt is fine, and the
 * same call a moment later usually works.
 *
 * It used to be thrown straight back at the caller, because the loop below
 * only understood two kinds of failure - a spent key and a wrong one - and
 * treated everything else as permanent. So a customer's question went
 * unanswered and a phone call fell silent over a wobble that would have
 * cleared in half a second.
 */
const isBusy = (error) => {
    const text = (error?.message || "") + " " + (error?.status || "");
    return /503|UNAVAILABLE|overloaded|high demand|try again later/i.test(text);
};

/** How long to wait before asking a busy model again, and how many times. */
const BUSY_WAITS_MS = [400, 1200];

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Record what a call cost, without making the caller wait for it.
 *
 * The counters are for the office's screen, not for the reply that is already
 * on its way back to a customer - so this is deliberately not awaited, and a
 * failed write costs a number on a dashboard rather than an answer.
 */
const spend = (row, { quota = false, rejected = false, error = "" } = {}) => {
    const day = today();
    const rolled = row.day !== day;

    const patch = {
        $set: {
            day,
            lastUsedAt: new Date(),
            ...(error ? { lastError: String(error).slice(0, 300) } : {}),
            ...(quota ? { exhaustedAt: new Date() } : {}),
            // A key the provider will not accept is not a key. Switching it
            // off is better than letting every call queue behind it.
            ...(rejected ? { isActive: false } : {}),
        },
        $inc: {
            usedTotal: 1,
            ...(quota || rejected ? { failures: 1 } : {}),
        },
    };

    if (rolled) {
        patch.$set.usedToday = 1;

        // The day that just ended, kept before it is overwritten
        if (row.day) {
            patch.$push = {
                history: {
                    $each: [{ day: row.day, used: row.usedToday || 0 }],
                    $slice: -14,
                },
            };
        }
    } else {
        patch.$inc.usedToday = 1;
    }

    // Yesterday's exhaustion is not today's
    if (rolled && !quota) patch.$set.exhaustedAt = null;

    ApiKey.updateOne({ _id: row._id }, patch).catch((err) => {
        console.error("Key usage not recorded:", err.message);
    });
};

/**
 * Run one call against whichever key is still good, stepping past the spent.
 *
 * `pin` decides whether a key's own model choice may override the caller's.
 * It may for a conversation, where a key on a different sort of account is
 * exactly why somebody added it - and it may not for an embedding, where the
 * model names the vector space: answering with a vector from a different model
 * than the stored ones would not fail, it would quietly return nonsense.
 */
const attempt = async (params, call, { pin }) => {
    const rows = await candidates("gemini").catch(() => []);

    const queue = rows
        .filter((row) => row.secret)
        .map((row) => ({ row, secret: row.secret, model: row.model }));

    /*
     * The environment's key, uncounted, only when nothing is counting it.
     *
     * Once it has a meter row it is already in the queue above, and adding it
     * again would both try it twice and let a key the office switched off go
     * on being used. Before that row exists - a first boot, a database that
     * was unreachable - it is the whole of the fallback.
     */
    if (!envRowKnown && process.env.GEMINI_API_KEY) {
        queue.push({ row: null, secret: process.env.GEMINI_API_KEY, model: "" });
    }

    if (!queue.length) {
        throw new Error("No Gemini key is available. Add one under Developer.");
    }

    let last;

    for (const entry of queue) {
        try {
            /*
             * A busy model is asked again before the key is blamed.
             *
             * Two short waits, and only for a 503 - long enough to ride out
             * the spike that causes almost all of them, short enough that a
             * customer on a phone call does not notice. Anything else drops
             * out of this loop on the first try, exactly as before.
             */
            let response = null;
            let busyError = null;

            for (let attempt = 0; attempt <= BUSY_WAITS_MS.length; attempt += 1) {
                try {
                    response = await call(clientFor(entry.secret), {
                        ...params,
                        model: (pin && entry.model) || params.model,
                    });
                    busyError = null;
                    break;
                } catch (error) {
                    if (!isBusy(error) || attempt === BUSY_WAITS_MS.length) throw error;

                    busyError = error;
                    console.warn(
                        "Gemini is busy, waiting " + BUSY_WAITS_MS[attempt] + "ms and asking again"
                    );
                    await pause(BUSY_WAITS_MS[attempt]);
                }
            }

            if (busyError) throw busyError;

            if (entry.row) spend(entry.row);
            return response;
        } catch (error) {
            last = error;

            const quota = isQuota(error);
            const rejected = isRejected(error);
            const busy = isBusy(error);

            if (entry.row) spend(entry.row, { quota, rejected, error: error.message });

            /*
             * A key that is spent or wrong is worth swapping. A model that is
             * still busy after the waits above is worth swapping too - a
             * different key can land on different capacity. Everything else -
             * a bad prompt, a model that does not exist, the network - fails
             * the same way on every key, so trying them all only multiplies
             * the wait.
             */
            if (!quota && !rejected && !busy) throw error;

            console.warn(
                "Gemini key " + (entry.row?.label || "from the environment")
                + (quota ? " is out of quota" : rejected ? " was rejected" : " kept getting a busy model")
                + ", trying the next one"
            );
        }
    }

    throw last || new Error("Every Gemini key failed.");
};

/**
 * Ask Gemini, on whichever key is still good.
 *
 * The parameters are exactly `ai.models.generateContent`'s, and so is the
 * value, so a call site changes by one word.
 */
const generate = (params) =>
    attempt(params, (client, body) => client.models.generateContent(body), { pin: true });

/** The same, for embeddings - and the model stays the caller's, always. */
const embed = (params) =>
    attempt(params, (client, body) => client.models.embedContent(body), { pin: false });

/** For the office's screen: is anything usable right now? */
const health = async (provider = "gemini") => {
    const usable = await candidates(provider).catch(() => []);

    return {
        usable: usable.length,
        envKey: Boolean(process.env.GEMINI_API_KEY),
        envMetered: envRowKnown,
        current: usable[0]
            ? { label: usable[0].label, model: usable[0].model || "" }
            : (process.env.GEMINI_API_KEY ? { label: "From the environment", model: "" } : null),
    };
};

/** A cheap round trip, to prove a key works before it is relied on. */
const probe = async (secret, model) => {
    const response = await clientFor(secret).models.generateContent({
        model: model || process.env.GEMINI_CHAT_MODEL || "gemini-3.1-flash-lite",
        contents: [{ role: "user", parts: [{ text: "Reply with the single word: ready" }] }],
        config: { temperature: 0 },
    });

    return String(response.text || "").trim().slice(0, 40);
};

module.exports = { generate, embed, count, health, probe, warm, seemsConfigured, isQuota, isRejected, isBusy };

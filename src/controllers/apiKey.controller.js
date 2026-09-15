const ApiKey = require("../models/apiKey.model");
const keyring = require("../services/keyring.service");
const { ENV_KEYS, ENV_SECRETS } = require("../config/apiKeys");
const usage = require("../services/mapUsage.service");
const { RATES, VIEW_RATES, CONFIG, rupeesFor } = require("../config/mapRates");

/**
 * The owner's view of what the platform is spending.
 *
 * Listing never carries a secret: every row here is a masked tail and a set of
 * counts, so a page load, a cache or a screenshot cannot leak a key. The whole
 * key is available - the person behind this door is the one who owns it and
 * has to be able to copy it - but only through `revealKey`, one at a time,
 * asked for on purpose.
 */

const today = () => new Date().toISOString().slice(0, 10);

/** The shape the screen reads - everything except the key itself. */
const present = (row) => {
    const day = today();
    const used = row.day === day ? row.usedToday : 0;
    const exhaustedToday = row.exhaustedAt
        && new Date(row.exhaustedAt).toISOString().slice(0, 10) === day;

    return {
        id: row._id,
        provider: row.provider,
        label: row.label,
        source: row.source || "managed",
        envVar: row.envVar || "",
        tail: row.tail || "",
        model: row.model || "",
        order: row.order,
        isActive: row.isActive,
        dailyLimit: row.dailyLimit,
        usedToday: used,
        usedTotal: row.usedTotal,
        history: row.history || [],
        failures: row.failures,
        lastUsedAt: row.lastUsedAt,
        lastError: row.lastError,
        exhausted: Boolean(exhaustedToday),
        // What the ring would decide about this key right now, said plainly
        status: !row.isActive
            ? "off"
            : exhaustedToday
                ? "spent"
                : (row.dailyLimit > 0 && used >= row.dailyLimit)
                    ? "spent"
                    : "ready",
    };
};

/**
 * Everything else the platform runs on, and whether it is there.
 *
 * These are not rotatable from a screen - they are in the server's own
 * settings and changing one means a deploy. What the platform can do is tell
 * the truth about them: which are set, which four characters are in use, what
 * stops working without each, and which are free tiers worth keeping an eye
 * on. That is the whole answer to "why did it go quiet?", which is the
 * question this page exists for.
 */
const environment = (rows = []) => {
    const mask = (value) => (value ? "••••" + String(value).slice(-4) : "");
    const day = today();

    const meters = Object.fromEntries(
        rows.filter((row) => row.source === "env").map((row) => [row.envVar, row])
    );

    const keys = ENV_KEYS.map((spec) => {
        const value = process.env[spec.envVar] || "";
        const missing = (spec.also || []).filter((name) => !process.env[name]);

        // The meter row, which exists for every key that is set. It is what
        // carries the day's count and whatever ceiling has been put on it.
        const meter = meters[spec.envVar];
        const used = meter && meter.day === day ? meter.usedToday : 0;

        return {
            envVar: spec.envVar,
            provider: spec.provider,
            label: spec.label,
            powers: spec.powers,
            note: spec.note || "",
            free: Boolean(spec.free),
            metered: Boolean(spec.metered),
            set: Boolean(value),
            tail: mask(value),

            // Everything the screen needs to draw a bar and to let a ceiling
            // be set on this key like any other
            id: meter?._id || null,
            usedToday: used,
            usedTotal: meter?.usedTotal || 0,
            // The fortnight behind today, so a key that spent everything
            // yesterday does not read as an idle one this morning
            history: meter?.history || [],
            dailyLimit: meter?.dailyLimit || 0,
            isActive: meter ? meter.isActive : true,
            lastUsedAt: meter?.lastUsedAt || null,
            lastError: meter?.lastError || "",
            // A provider is only really configured when its whole set is
            // there - ImageKit with a private key and no endpoint fails at the
            // first upload, and the missing half is what you want named
            companions: spec.also || [],
            missingCompanions: missing,

            /*
             * Everything the platform is made of, ids included.
             *
             * A headline key on its own is not what somebody comparing this
             * screen against a provider's dashboard needs: Razorpay is a key
             * id beside a key secret beside a webhook secret, and which of the
             * three has gone stale is exactly the question. So every variable
             * is a row, named, with its own tail, and each can be revealed on
             * its own.
             */
            fields: (spec.fields || [{ envVar: spec.envVar, label: "API key", kind: "key" }])
                .map((field) => {
                    const held = process.env[field.envVar] || "";

                    return {
                        envVar: field.envVar,
                        label: field.label,
                        kind: field.kind,
                        // Only set where one platform has several keys and
                        // which one is being used is the whole question
                        where: field.where || "",
                        calls: Boolean(field.calls),
                        set: Boolean(held),
                        // A URL endpoint is not a secret and reads as nonsense
                        // masked, so it is shown as it is
                        tail: field.kind === "url" ? held : mask(held),
                    };
                }),
        };
    });

    const secrets = ENV_SECRETS.map((spec) => ({
        envVar: spec.envVar,
        label: spec.label,
        powers: spec.powers,
        set: Boolean(process.env[spec.envVar]),
    }));

    return { keys, secrets };
};

/**
 * POST /api/admin/keys/reveal
 *
 * The whole key, for the one person allowed in here.
 *
 * Deliberately its own request rather than a field on the list. A key that
 * travels with every page load ends up in a browser cache, a proxy log and the
 * next screenshot; asked for one at a time, it is a thing somebody did on
 * purpose. The route is already behind the owner's sign-in and security key.
 */
const revealKey = async (req, res) => {
    try {
        const { id, envVar } = req.body || {};

        if (id) {
            const row = await ApiKey.findById(id).select("+secret").lean();
            if (!row) return res.status(404).json({ success: false, message: "No such key." });

            const secret = row.source === "env" ? process.env[row.envVar] : row.secret;

            if (!secret) {
                return res.status(404).json({
                    success: false,
                    message: (row.envVar || "That row") + " is empty on the server.",
                });
            }

            return res.status(200).json({ success: true, data: { secret } });
        }

        // Only names the platform itself knows about, so this cannot be used
        // to read arbitrary variables off the server
        const known = [
            ...ENV_KEYS.flatMap((k) => [
                k.envVar,
                ...(k.fields || []).map((f) => f.envVar),
                ...(k.also || []),
            ]),
            ...ENV_SECRETS.map((k) => k.envVar),
        ];
        const name = String(envVar || "");

        if (!known.includes(name)) {
            return res.status(404).json({ success: false, message: "The platform does not use a key by that name." });
        }

        if (!process.env[name]) {
            return res.status(404).json({ success: false, message: name + " is not set on the server." });
        }

        return res.status(200).json({ success: true, data: { secret: process.env[name] } });
    } catch (error) {
        console.error("Reveal key error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/** GET /api/admin/keys */
const listKeys = async (req, res) => {
    try {
        const rows = await ApiKey.find().sort({ provider: 1, order: 1, createdAt: 1 }).lean();
        const health = await keyring.health("gemini");

        return res.status(200).json({
            success: true,
            data: {
                keys: rows.map(present),
                environment: environment(rows),
                health,
                // The models the platform actually asks for, so the screen can
                // say which one a call will use rather than making the office
                // remember the environment
                models: {
                    chat: process.env.GEMINI_CHAT_MODEL || "gemini-3.1-flash-lite",
                    voice: process.env.GEMINI_VOICE_MODEL || "gemini-3.1-flash-lite",
                },
            },
        });
    } catch (error) {
        console.error("List keys error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/** POST /api/admin/keys */
const addKey = async (req, res) => {
    try {
        const label = String(req.body.label || "").trim();
        const secret = String(req.body.secret || "").trim();

        if (label.length < 2 || secret.length < 8) {
            return res.status(400).json({ success: false, message: "A name and the key itself are both needed." });
        }

        const provider = String(req.body.provider || "gemini").trim().toLowerCase();

        // Same key twice is not a second key - it is one quota counted in two
        // places, which is worse than no fallback at all because it looks like
        // one. Only rows whose tail matches are read, so this compares at most
        // a handful of secrets.
        const similar = await ApiKey.find({ provider, tail: secret.slice(-4) }).select("+secret").lean();

        if (similar.some((row) => row.secret === secret)) {
            return res.status(409).json({ success: false, message: "That key is already on the list." });
        }

        const last = await ApiKey.findOne({ provider }).sort({ order: -1 }).select("order").lean();

        const row = await ApiKey.create({
            provider,
            label,
            secret,
            tail: secret.slice(-4),
            model: String(req.body.model || "").trim(),
            dailyLimit: Number(req.body.dailyLimit) || 0,
            order: (last?.order ?? 0) + 10,
            createdBy: req.admin?._id,
            updatedBy: req.admin?._id,
        });

        return res.status(201).json({ success: true, data: present(row.toObject()), message: label + " added." });
    } catch (error) {
        console.error("Add key error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/** PUT /api/admin/keys/:id */
const updateKey = async (req, res) => {
    try {
        const patch = { updatedBy: req.admin?._id };

        if (req.body.label !== undefined) patch.label = String(req.body.label).trim();
        if (req.body.model !== undefined) patch.model = String(req.body.model).trim();
        if (req.body.dailyLimit !== undefined) patch.dailyLimit = Number(req.body.dailyLimit) || 0;
        if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);
        if (req.body.order !== undefined) patch.order = Number(req.body.order) || 0;

        const existing = await ApiKey.findById(req.params.id).lean();
        if (!existing) return res.status(404).json({ success: false, message: "No such key." });

        // Replacing the key itself is the point of the screen: a free tier
        // runs out and a new one goes in without the old row's history being
        // lost. The one exception is the row standing in for the server's own
        // settings - accepting a secret there would look like it had changed
        // something, and the next call would still use the old one.
        const secret = existing.source === "env" ? "" : String(req.body.secret || "").trim();

        if (existing.source === "env" && String(req.body.secret || "").trim()) {
            return res.status(409).json({
                success: false,
                message: "That key lives in the server's settings and has to be changed there. You can still rename it, give it a limit, or switch it off.",
            });
        }

        if (secret) {
            patch.secret = secret;
            patch.tail = secret.slice(-4);
            patch.exhaustedAt = null;
            patch.lastError = "";
            patch.isActive = req.body.isActive === undefined ? true : Boolean(req.body.isActive);
        }

        const row = await ApiKey.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true }).lean();

        if (!row) return res.status(404).json({ success: false, message: "No such key." });

        return res.status(200).json({ success: true, data: present(row), message: "Saved." });
    } catch (error) {
        console.error("Update key error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/admin/keys/:id/promote
 *
 * Straight to the front of the queue. The office's usual reason for opening
 * this screen is that the key being spent has stopped working, so "use this
 * one instead" has to be one button and not an exercise in renumbering.
 */
const promoteKey = async (req, res) => {
    try {
        const row = await ApiKey.findById(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: "No such key." });

        const first = await ApiKey.findOne({ provider: row.provider }).sort({ order: 1 }).select("order").lean();

        row.order = (first?.order ?? 0) - 10;
        row.isActive = true;
        row.updatedBy = req.admin?._id;
        await row.save();

        return res.status(200).json({ success: true, message: row.label + " is first in line now." });
    } catch (error) {
        console.error("Promote key error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/admin/keys/:id/reset
 *
 * For when a provider's day rolls over before ours does, or a limit was typed
 * in wrongly. It clears the marks, not the totals.
 */
const resetKey = async (req, res) => {
    try {
        const row = await ApiKey.findByIdAndUpdate(
            req.params.id,
            { $set: { exhaustedAt: null, usedToday: 0, day: today(), lastError: "", updatedBy: req.admin?._id } },
            { new: true }
        ).lean();

        if (!row) return res.status(404).json({ success: false, message: "No such key." });

        return res.status(200).json({ success: true, data: present(row), message: "Counter cleared." });
    } catch (error) {
        console.error("Reset key error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/admin/keys/:id/test
 *
 * One real call, because the only thing that proves a key works is the
 * provider accepting it. It costs a request against the quota and says so on
 * the screen.
 */
const testKey = async (req, res) => {
    try {
        const row = await ApiKey.findById(req.params.id).select("+secret");
        if (!row) return res.status(404).json({ success: false, message: "No such key." });

        // An env row has no secret of its own - the key is wherever the server
        // keeps it, and that is what has to be tested
        const secret = row.source === "env" ? process.env[row.envVar] : row.secret;

        if (!secret) {
            return res.status(200).json({
                success: false,
                message: "There is no key to test - " + (row.envVar || "this row") + " is empty on the server.",
            });
        }

        try {
            const reply = await keyring.probe(secret, row.model);

            row.exhaustedAt = null;
            row.lastError = "";
            await row.save();

            return res.status(200).json({ success: true, message: "Working. It answered: " + reply });
        } catch (error) {
            const quota = keyring.isQuota(error);

            row.lastError = String(error.message).slice(0, 300);
            if (quota) row.exhaustedAt = new Date();
            await row.save();

            return res.status(200).json({
                success: false,
                message: quota
                    ? "That key has nothing left today."
                    : "The provider refused it: " + String(error.message).slice(0, 160),
            });
        }
    } catch (error) {
        console.error("Test key error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/** DELETE /api/admin/keys/:id */
const removeKey = async (req, res) => {
    try {
        const existing = await ApiKey.findById(req.params.id).lean();
        if (!existing) return res.status(404).json({ success: false, message: "No such key." });

        // The row for the server's own key is a meter, not the key. Deleting
        // it would change nothing except that the calls stop being counted,
        // and it would be recreated at the next restart anyway.
        if (existing.source === "env") {
            return res.status(409).json({
                success: false,
                message: "That key lives in the server's settings. Switch it off here if you want it left alone, or change it where it is set.",
            });
        }

        const row = await ApiKey.findByIdAndDelete(req.params.id).lean();
        if (!row) return res.status(404).json({ success: false, message: "No such key." });

        return res.status(200).json({ success: true, message: row.label + " is deleted." });
    } catch (error) {
        console.error("Remove key error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};


/**
 * GET /api/admin/map-usage?days=14
 *
 * What the map providers were asked for, day by day and kind by kind, priced
 * in rupees.
 *
 * The key ring already counts Google as one number, which says the key is
 * alive and nothing about where the money goes - an autocomplete request and a
 * route matrix are both "Google" and are priced an order of magnitude apart.
 * This splits them, so "the bill went up" can be followed by "because of what".
 *
 * The rupee figures come from `config/mapRates.js`, which holds list prices
 * somebody has to keep current by hand. The rate card and the date it was last
 * checked travel with the response, so the page can say plainly what it is
 * estimating from rather than presenting a guess as an invoice.
 */
const mapUsage = async (req, res) => {
    try {
        const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
        const rows = await usage.recent(days);

        const priced = rows.map((row) => {
            const kinds = {};
            let rupees = 0;

            for (const [kind, count] of Object.entries(row.kinds)) {
                const cost = rupeesFor(kind, count);
                kinds[kind] = { count, rupees: Math.round(cost * 100) / 100 };
                rupees += cost;
            }

            return {
                day: row.day,
                total: row.total,
                rupees: Math.round(rupees * 100) / 100,
                kinds,
            };
        });

        // The totals the page leads with, added up here so the browser does
        // not do the same arithmetic a second time
        const period = { calls: 0, rupees: 0, kinds: {} };
        for (const row of priced) {
            period.calls += row.total;
            period.rupees += row.rupees;
            for (const [kind, entry] of Object.entries(row.kinds)) {
                if (!period.kinds[kind]) period.kinds[kind] = { count: 0, rupees: 0 };
                period.kinds[kind].count += entry.count;
                period.kinds[kind].rupees += entry.rupees;
            }
        }
        period.rupees = Math.round(period.rupees * 100) / 100;
        for (const entry of Object.values(period.kinds)) {
            entry.rupees = Math.round(entry.rupees * 100) / 100;
        }

        return res.status(200).json({
            success: true,
            data: {
                days,
                today: usage.today(),
                rows: priced,
                period,
                rates: RATES,
                views: VIEW_RATES,
                config: CONFIG,
            },
        });
    } catch (error) {
        console.error("Map usage error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

module.exports = {
    mapUsage, listKeys, addKey, updateKey, promoteKey, resetKey, testKey, revealKey, removeKey };

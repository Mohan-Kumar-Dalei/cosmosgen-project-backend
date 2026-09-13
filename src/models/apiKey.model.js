const mongoose = require("mongoose");

/**
 * One key the platform spends, and what is left of it.
 *
 * Keys lived in the environment, which is fine for one key that never runs
 * out. Gemini's free tier is not that: it stops at a few hundred calls a day,
 * and when it does, every assistant reply, every drafted service and every
 * voice call fails at once until somebody edits a file on the server and
 * restarts it. Keys in here can be added from the office, ordered, and stepped
 * past automatically the moment the provider says a quota is gone.
 *
 * The secret is `select: false`, so it is never in a response by accident -
 * reading it takes an explicit `.select("+secret")`, which is one deliberate
 * act in one file rather than a field that travels everywhere its document
 * does.
 */
const apiKeySchema = new mongoose.Schema({
    // "gemini" today. The shape is the same for any metered provider, so
    // Sarvam or a map key can join without a second collection.
    provider: { type: String, required: true, default: "gemini", index: true },

    /** What the office calls it - "Gemini free (personal)", and so on. */
    label: { type: String, required: true, trim: true },

    /**
     * Where the key itself lives.
     *
     * "managed" means the secret is in this document and the office can
     * change it here. "env" means the row is a meter rather than a key: the
     * secret stays in the server's own settings, and this exists so the calls
     * made on it can be counted alongside the rest. Rows like that are created
     * by the ring at boot, not by a person, and cannot be edited to hold a
     * secret - which is why `secret` is only required for the managed sort.
     */
    source: { type: String, enum: ["managed", "env"], default: "managed" },

    /** For an env row: the variable the secret is read from. */
    envVar: { type: String, default: "" },

    secret: {
        type: String,
        select: false,
        required: function required() { return this.source !== "env"; },
    },

    /**
     * The last four characters, which is all the office ever needs to see.
     * Stored rather than derived so that showing the list never has to read
     * the secret at all.
     */
    tail: { type: String, default: "" },

    /**
     * The model this key should be used with.
     *
     * Empty means whatever the caller asked for. It is per key because the
     * reason for holding a second key is usually that it is a different sort
     * of account - a paid one that may use a better model, a free one that may
     * not.
     */
    model: { type: String, default: "", trim: true },

    /** Where it sits in the queue. Lowest number is tried first. */
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },

    /**
     * What the provider allows in a day, as the office understands it. Zero
     * means "not known" - the counter still runs, nothing is held back, and
     * the provider's own refusal is what moves us on.
     */
    dailyLimit: { type: Number, default: 0 },

    /** The day `usedToday` belongs to, as YYYY-MM-DD in the server's zone. */
    day: { type: String, default: "" },
    usedToday: { type: Number, default: 0 },
    usedTotal: { type: Number, default: 0 },

    /*
     * The fortnight behind today.
     *
     * `usedToday` answers "how much is left before midnight", which is the
     * urgent question, and it is worth nothing the morning after: a key that
     * burned its whole allowance yesterday shows a bar at nought. So each day
     * is pushed here as it rolls over, capped at a fortnight, which is enough
     * to see a habit forming without turning a key row into a log.
     */
    history: {
        type: [{
            _id: false,
            day: { type: String },
            used: { type: Number, default: 0 },
        }],
        default: [],
    },
    failures: { type: Number, default: 0 },

    lastUsedAt: { type: Date },

    /**
     * When the provider last said this key had nothing left. Cleared the
     * moment a new day starts, because that is when a daily quota returns.
     */
    exhaustedAt: { type: Date },
    lastError: { type: String, default: "" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
}, { timestamps: true });

apiKeySchema.index({ provider: 1, order: 1 });

module.exports = mongoose.model("ApiKey", apiKeySchema);

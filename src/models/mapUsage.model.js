const mongoose = require("mongoose");

/**
 * One row per kind of map call, per day.
 *
 * The key ring already counts Google as a single number, which answers "are we
 * using this key" and nothing else. What the office actually needs to know is
 * *which* call is costing the money - an autocomplete request and a route
 * matrix are both "Google" and they are priced an order of magnitude apart, so
 * one total tells you the bill went up and not a thing about why.
 *
 * Deliberately tiny: a day, a kind, a number. No per-request rows, because
 * nobody is going to audit an individual geocode and a year of them would be
 * millions of documents for a figure that is only ever read as a daily total.
 */
const mapUsageSchema = new mongoose.Schema({
    /** YYYY-MM-DD in the server's zone, the same string the key ring uses. */
    day: { type: String, required: true },

    /**
     * What was called, in the names the rate card uses - "autocomplete",
     * "details", "geocode", "routes", "matrix". Free text rather than an enum
     * so adding a kind is one line in the rate card and nothing here.
     */
    kind: { type: String, required: true },

    count: { type: Number, default: 0 },
}, { timestamps: true });

// One row per day and kind, and the upsert below depends on it being unique
mapUsageSchema.index({ day: 1, kind: 1 }, { unique: true });

/*
 * A year of counters is plenty.
 *
 * These rows exist to answer "which call is eating the budget, and roughly how
 * much" - a question about this month against last, not about last winter. The
 * page asks for a fortnight by default and ninety days at most, so anything
 * past a year has no way of being read even deliberately.
 */
mapUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model("MapUsage", mapUsageSchema);

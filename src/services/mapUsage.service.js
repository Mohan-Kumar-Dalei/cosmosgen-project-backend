const MapUsage = require("../models/mapUsage.model");

/** The same day string the key ring files its history under. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * More of this kind, today.
 *
 * Never awaited and never able to throw. A counter exists to inform somebody
 * later; failing a vendor's search because the counter could not be written
 * would be the tail wagging the dog. `upsert` plus the unique day+kind index
 * means two calls landing together cannot lose one another's increment.
 *
 * `howMany` is there because one request is not always one charge. Route
 * Matrix bills per pair, so a single request asking about four vendors is four
 * charges - and counted as one, this page priced it at a quarter of what it
 * cost. The rate card beside it has always said "priced per element"; this is
 * the half that makes that true.
 */
const record = (kind, howMany = 1) => {
    const n = Math.floor(Number(howMany));
    if (!kind || !Number.isFinite(n) || n < 1) return;

    MapUsage.updateOne(
        { day: today(), kind },
        { $inc: { count: n } },
        { upsert: true }
    ).catch((err) => {
        console.error("[MAP USAGE] not counted:", err.message);
    });
};

/**
 * The last `days` days, newest first, as one row per day with a count per kind.
 *
 * Shaped for reading rather than for storing: the page wants "on the 14th we
 * made 40 autocompletes and 3 geocodes", and turning rows into that here keeps
 * the arithmetic in one place.
 */
const recent = async (days = 14) => {
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    const fromDay = from.toISOString().slice(0, 10);

    const rows = await MapUsage.find({ day: { $gte: fromDay } })
        .select("day kind count")
        .lean();

    const byDay = new Map();
    for (const row of rows) {
        if (!byDay.has(row.day)) byDay.set(row.day, { day: row.day, kinds: {}, total: 0 });
        const bucket = byDay.get(row.day);
        bucket.kinds[row.kind] = (bucket.kinds[row.kind] || 0) + row.count;
        bucket.total += row.count;
    }

    return Array.from(byDay.values()).sort((a, b) => b.day.localeCompare(a.day));
};

module.exports = { record, recent, today };

const ticketModel = require("../models/ticket.model");
const callModel = require("../models/call.model");

/**
 * Throwing away the weight of old jobs, and keeping the rest.
 *
 * Two things in this database are large, and neither of them is read once the
 * job they belong to is over: the road drawn under a moving bike, and the
 * words spoken on a phone call. Together they are roughly two thirds of what a
 * job leaves behind. The parts that matter - the ticket, what it cost, which
 * invoice, who did it, what money moved - are a fraction of the size and are
 * never touched here.
 *
 * WHAT IS DELIBERATELY NOT DELETED, and must stay that way. Payments and
 * wallet transactions are the company's books: GST asks for six years of them
 * and income tax for longer, so nothing in this file goes near either. Nor
 * does it touch conversations, which look like history and are not - that row
 * holds a customer's language, their registration and where they had got to,
 * so deleting one would greet a returning customer as a stranger.
 *
 * The two collections that clean themselves - messages and map usage counters
 * - do it with a TTL index on the model rather than from here, because Mongo
 * doing it on its own is one less thing that can stop running.
 */

/** How long anything here is worth keeping. */
const KEEP_MONTHS = 6;

const cutoff = () => {
    const at = new Date();
    at.setMonth(at.getMonth() - KEEP_MONTHS);
    return at;
};

/**
 * The route, the origin, and the places a ride was worked out from.
 *
 * `encodedPolyline` is the big one - a line with a few hundred points on it,
 * written onto the ticket so a customer's map could draw it. Once the job is
 * closed nobody will ever draw it again; it cannot even be shown, because the
 * tracking screen only opens on a live job.
 *
 * What stays on the ticket is the part somebody may still ask about: when he
 * set off, when he arrived, how far it was and how long it took. Only the
 * drawing is dropped.
 */
const RIDE_WEIGHT = {
    "ride.encodedPolyline": "",
    "ride.origin": "",
    "ride.askedFrom": "",
    "ride.placeAt": "",
    "ride.nearPlace": "",
};

const stripOldRides = async (before) => {
    const result = await ticketModel.updateMany(
        {
            status: { $in: ["Closed", "Cancelled"] },
            updatedAt: { $lt: before },
            "ride.encodedPolyline": { $exists: true, $ne: null },
        },
        { $unset: RIDE_WEIGHT }
    );

    return result.modifiedCount || 0;
};

/**
 * What was said on a call, but not the fact that it happened.
 *
 * The turns are the bulk of a call record and the least re-read part of it.
 * Exotel keeps its own recording of the call, and `providerCallSid` on the row
 * is the reference that finds it there - which is exactly why the row itself
 * is kept rather than deleted. Drop that and the recording still exists but
 * nothing here knows where to look for it.
 *
 * So the office keeps what it uses: which job, which customer, why we rang,
 * whether they answered, how long it lasted.
 */
const stripOldCallTurns = async (before) => {
    const result = await callModel.updateMany(
        {
            createdAt: { $lt: before },
            "turns.0": { $exists: true },
        },
        { $set: { turns: [] } }
    );

    return result.modifiedCount || 0;
};

/**
 * Never throws and never blocks anything.
 *
 * This runs beside a live server. A housekeeping pass that fails is a database
 * slightly larger than it needed to be; a housekeeping pass that throws into
 * the scheduler is a server that stops doing the thing it was actually for.
 */
const sweep = async () => {
    const before = cutoff();

    try {
        const [rides, calls] = await Promise.all([
            stripOldRides(before),
            stripOldCallTurns(before),
        ]);

        if (rides || calls) {
            console.log(
                "[HOUSEKEEPING] older than " + before.toISOString().slice(0, 10)
                + ": " + rides + " ride(s) stripped, " + calls + " call transcript(s) cleared"
            );
        }
    } catch (err) {
        console.error("[HOUSEKEEPING] sweep failed:", err.message);
    }
};

module.exports = { sweep, KEEP_MONTHS };

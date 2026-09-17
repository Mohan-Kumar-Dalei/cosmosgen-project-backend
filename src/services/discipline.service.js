const technicianModel = require("../models/technician.model");

/**
 * What happens when a technician keeps handing jobs back.
 *
 * Refusing a job is allowed and is often the right call - the office would
 * much rather be told than have somebody drive across the city and waste the
 * trip. What it cannot be is free. A vendor who turns down everything far,
 * awkward or cheap is choosing the easy half of the day's work and leaving the
 * rest for people who do not, and the office finds out about it weeks later
 * from a pile of reassignments.
 *
 * So the fifth refusal in one day costs him the rest of that day. Not a
 * warning, not a smaller share of jobs - the app stops, he goes offline, and
 * he starts again tomorrow morning. Five is high enough that an ordinary bad
 * day never reaches it and low enough that a habit does.
 *
 * Mohan's reason for keeping the record, rather than only the pause, is that
 * the pause is the small consequence. A vendor who collects these week after
 * week is a vendor the office should stop sending work to at all, and that
 * decision needs evidence rather than somebody's memory.
 */

/** Five in a day is a habit, not a bad morning. */
const DECLINE_LIMIT = 5;

/**
 * India, always.
 *
 * The server's own clock is UTC and "the rest of the day" means the vendor's
 * day, not Greenwich's. Without this a refusal at nine in the evening would
 * suspend somebody until half past five in the morning, and one at six would
 * be counted against the wrong day entirely.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The Indian calendar date of a moment, as a plain sortable string. */
const dayKey = (at) => new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Midnight at the start of the next Indian day.
 *
 * Working in the shifted clock and shifting back is what keeps this correct
 * without a timezone library: setting the hour to 24 rolls the date over for
 * us, including across a month or a year.
 */
const nextDayStart = (at) => {
    const shifted = new Date(at.getTime() + IST_OFFSET_MS);
    shifted.setUTCHours(24, 0, 0, 0);
    return new Date(shifted.getTime() - IST_OFFSET_MS);
};

/** Is this technician paused right now? */
const isSuspended = (technician, at = new Date()) =>
    Boolean(technician?.suspendedUntil) && new Date(technician.suspendedUntil) > at;

/**
 * One more job handed back.
 *
 * Returns what the caller needs to decide what to do next: the running count
 * and whether this was the one that stopped him. It writes the record whatever
 * the answer, because the record is the point - the pause is only the part the
 * vendor notices.
 *
 * The day is rolled over here rather than by anything scheduled. Comparing the
 * stored key against today's means a server that was asleep at midnight still
 * gives the right answer on the first request of the morning, and there is no
 * cron job to forget about.
 */
const recordDecline = async (technicianId, ticket, reason) => {
    const at = new Date();
    const technician = await technicianModel.findById(technicianId).select("declines suspendedUntil").lean();

    if (!technician) return { counted: 0, suspended: false, until: null };

    const sameDay = technician.declines?.dayKey === dayKey(at);
    const counted = (sameDay ? Number(technician.declines?.today || 0) : 0) + 1;
    const suspend = counted >= DECLINE_LIMIT;
    const until = suspend ? nextDayStart(at) : null;

    const update = {
        $set: {
            "declines.today": counted,
            "declines.dayKey": dayKey(at),
        },
        $inc: { "declines.total": 1 },
        $push: {
            "declines.recent": {
                $each: [{
                    ticket: ticket._id,
                    ticketNumber: ticket.ticketNumber,
                    reason: String(reason || "").trim(),
                    at,
                }],
                // Evidence for a conversation, not an audit log.
                $slice: -30,
            },
        },
    };

    if (suspend) {
        update.$set.suspendedUntil = until;

        /*
         * Offline as well as paused.
         *
         * Two flags for one state looks redundant until you remember that
         * every list of who is available reads `isAvailable`, and none of them
         * should have to learn about suspensions to get the right answer.
         */
        update.$set.isAvailable = false;

        update.$push.suspensions = { at, until, declines: counted };
    }

    await technicianModel.updateOne({ _id: technicianId }, update);

    return { counted, suspended: suspend, until, limit: DECLINE_LIMIT };
};

/**
 * End a pause early.
 *
 * Nothing calls this yet. It exists because the client has asked about a fine
 * in place of a lost day, and that will be a Razorpay button and then this -
 * one field, cleared, with the record of why it was cleared left behind. A
 * paid-off suspension must still be visible to whoever is deciding about a
 * vendor later, which is the whole reason `suspensions` keeps its history.
 */
const liftSuspension = async (technicianId, reason) => {
    await technicianModel.updateOne(
        { _id: technicianId },
        {
            $set: { suspendedUntil: null },
            $push: { suspensions: { at: new Date(), until: null, declines: 0, reason } },
        }
    );
};

module.exports = { recordDecline, isSuspended, liftSuspension, DECLINE_LIMIT, dayKey, nextDayStart };

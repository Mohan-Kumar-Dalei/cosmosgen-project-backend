const ticketModel = require("../models/ticket.model");

/**
 * What customers have actually said about each trade.
 *
 * The app and the website both show a score on every service card, and until
 * now that score was the number 4.8 written into the app. It was honest about
 * itself in a code comment and dishonest on the screen, which is the wrong way
 * round: a customer reading 4.8 beside "Air conditioning" believes other
 * customers put it there.
 *
 * Every rating in the system is already collected - the app asks for one when a
 * job closes, and it lands on the ticket. This turns those into a figure per
 * trade.
 */

/*
 * A new trade does not start at zero, and it does not start at five.
 *
 * One customer having a bad morning should not drop a service to 2.0, and the
 * first customer to give five stars should not lift it to a perfect score
 * either - both are a single opinion presented as a verdict. So the average is
 * pulled towards a neutral starting point, hard at first and less as real
 * ratings arrive: at one rating the figure is mostly the prior, at fifty it is
 * almost entirely the customers.
 *
 * PRIOR is deliberately not 5. A wall of perfect scores is the thing that makes
 * a listings page read as advertising, and this company's own vendors sit
 * around here.
 */
const PRIOR = 4.6;
const WEIGHT = 8;

/** How long a computed set is reused before the tickets are counted again. */
const CACHE_MS = 5 * 60 * 1000;

let cache = { at: 0, data: null };

/**
 * `{ AC_APPLIANCE: { rating: 4.7, count: 31 }, ... }`
 *
 * Cached for a few minutes because it is asked for on every home screen and it
 * cannot move meaningfully in that time - one more five-star rating on thirty
 * does not change a figure printed to one decimal place. A rating saved in the
 * meantime is simply counted at the next refresh.
 */
const byService = async () => {
    if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

    try {
        const rows = await ticketModel.aggregate([
            { $match: { "feedback.ratedAt": { $ne: null }, "feedback.rating": { $gt: 0 } } },
            {
                $group: {
                    _id: "$serviceKey",
                    total: { $sum: "$feedback.rating" },
                    count: { $sum: 1 },
                },
            },
        ]);

        const data = {};

        for (const row of rows) {
            if (!row._id) continue;

            const smoothed = (row.total + PRIOR * WEIGHT) / (row.count + WEIGHT);

            data[row._id] = {
                rating: Math.round(smoothed * 10) / 10,
                count: row.count,
            };
        }

        cache = { at: Date.now(), data };
        return data;
    } catch (error) {
        console.error("Service ratings failed:", error.message);

        // A screen without a star is a screen; a screen that failed to load
        // because a star could not be counted is a bug. Empty means every
        // service falls back to the starting figure.
        return {};
    }
};

/** What a trade nobody has rated yet shows. Exported so one number is used. */
const DEFAULT_RATING = PRIOR;

/** Dropped when a new rating lands, so the next screen counts it in. */
const forget = () => { cache = { at: 0, data: null }; };

module.exports = { byService, forget, DEFAULT_RATING };

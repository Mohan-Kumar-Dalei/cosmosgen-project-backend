const ServicePricing = require("../models/servicePricing.model");
const { SERVICE_CATALOG } = require("../config/services");
const { getSetting } = require("./settings.service");

/**
 * What a job usually comes to, so somebody can say yes knowing roughly what
 * they are saying yes to.
 *
 * The assistant used to be forbidden from mentioning money at all, and the
 * reasoning was sound: a quote it invented would be a promise the engineer
 * could not keep. But "we cannot tell you anything about the price" is its own
 * kind of wrong - it is the first question anybody asks before letting a
 * stranger into the house, and refusing it loses bookings that would have gone
 * ahead happily.
 *
 * The middle answer is the honest one: a range the office itself set. These
 * figures are the price list the engineers bill from, so they are not a guess
 * and they are not a promise either - the range is wide because the work is,
 * and the words around it say so.
 *
 * Parts are left out of the range deliberately. A compressor costs more than
 * every labour line put together, and folding it in would turn a useful "most
 * jobs are four to twelve hundred" into a useless "four hundred to nine
 * thousand". They are mentioned as what they are: extra, itemised, and shown
 * before anything is fitted.
 */

/** Prices change perhaps twice a year; this is re-read every ten minutes. */
const CACHE_MS = 10 * 60 * 1000;

let cached = { at: 0, text: "" };

/** Rounded to the nearest fifty, because a range is not an invoice. */
const tidy = (rupees) => Math.max(50, Math.round(rupees / 50) * 50);

const money = (rupees) => "Rs " + rupees.toLocaleString("en-IN");

const rangeFor = (doc) => {
    const items = (doc?.itemsList || []).filter((i) => i.isActive !== false);
    if (!items.length) return null;

    /*
     * Labour and service lines only - see the note above. If a service happens
     * to be priced entirely in parts (a catalogue of fittings, say), the parts
     * are all there is, and a range from them beats no answer.
     */
    const work = items.filter((i) => i.category !== "part");
    const use = work.length ? work : items;

    const prices = use.map((i) => Math.round((i.pricePaise || 0) / 100)).filter((n) => n > 0);
    if (!prices.length) return null;

    return { from: tidy(Math.min(...prices)), to: tidy(Math.max(...prices)) };
};

/**
 * The block the assistant reads its figures from.
 *
 * Nothing here is addressed to the customer - it is written for the model, the
 * same way the customer record is, and the rules in the instruction tell it
 * never to read a block out as-is.
 */
const estimateBlock = async () => {
    if (cached.text && Date.now() - cached.at < CACHE_MS) return cached.text;

    try {
        const docs = await ServicePricing.find().select("serviceKey itemsList").lean();
        const byKey = new Map(docs.map((d) => [d.serviceKey, d]));

        const lines = SERVICE_CATALOG.map((service) => {
            const range = rangeFor(byKey.get(service.key));
            if (!range) return null;

            return "- " + service.label + ": most jobs come to "
                + money(range.from) + " to " + money(range.to)
                + ", depending on what is wrong.";
        }).filter(Boolean);

        if (!lines.length) {
            cached = { at: Date.now(), text: "" };
            return "";
        }

        const visit = await getSetting("VISIT_CHARGE_RUPEES");

        cached = {
            at: Date.now(),
            text: "\nWHAT THINGS USUALLY COST:\n"
                + lines.join("\n") + "\n"
                + "Parts, if any are needed, are extra and are shown to them before "
                + "anything is fitted.\n"
                + "Coming out is free. " + money(visit) + " is charged only if they "
                + "turn the work down after the engineer has already travelled to them.\n"
                + "Give a range from this list when they ask what it will cost, or "
                + "before booking if they have not asked - one short line, in their "
                + "own language, and always as 'usually' or 'around'. Never a single "
                + "figure, never a promise, and never a number that is not here. The "
                + "engineer confirms the real price at the door before starting.\n",
        };

        return cached.text;
    } catch (error) {
        // A missing price list costs the estimate, not the conversation.
        console.error("[ESTIMATE] could not build the price block:", error.message);
        return "";
    }
};

/**
 * The same ranges, as figures rather than as a paragraph.
 *
 * `estimateBlock` writes for the model; this writes for a screen. Both read the
 * office's own price list through `rangeFor`, so a rate changed once is changed
 * everywhere - the card in the app, the sentence the assistant says, and the
 * bill the engineer raises cannot drift apart.
 *
 * A service with nothing priced comes back absent rather than as zero. The card
 * then says nothing about money, which is honest: we do not know yet.
 */
const serviceRanges = async () => {
    try {
        const docs = await ServicePricing.find().select("serviceKey itemsList").lean();
        const out = {};

        docs.forEach((doc) => {
            const range = rangeFor(doc);
            if (range) out[doc.serviceKey] = range;
        });

        return out;
    } catch (error) {
        // A missing price list costs the figure, not the screen.
        console.error("[ESTIMATE] could not read the price list:", error.message);
        return {};
    }
};

module.exports = { estimateBlock, serviceRanges };

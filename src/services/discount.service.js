const Discount = require("../models/discount.model");
const ticketModel = require("../models/ticket.model");

/**
 * What a discount is worth on a particular bill, and who pays for it.
 *
 * Every question about an offer is answered here and nowhere else. A booking
 * asks `quote` whether an offer applies and what it comes to; the bill asks
 * `amountOn` for the figure to take off; the wallet asks `split` whose earnings
 * it comes out of. Scattering any of that across the controllers is how a
 * discount ends up being taken off the customer's total in one place and
 * forgotten in the commission in another, which is a vendor quietly funding a
 * company offer.
 *
 * None of this runs against anything today: there are no discount rows, so
 * `quote` returns nothing and every bill computes exactly as it did before.
 */

const rupeesToPaise = (rupees) => Math.round(Number(rupees) * 100);

/**
 * The offer's value against a subtotal, rounded to whole paise and never
 * bigger than the bill itself.
 *
 * Worked out on the subtotal rather than the total on purpose: GST is charged
 * on what the customer actually pays, so the discount comes off first and the
 * tax is computed on the net. Taking it off after GST would have the company
 * paying tax on money it never collected.
 */
const amountOn = (discount, subtotalPaise) => {
    if (!discount || !(subtotalPaise > 0)) return 0;

    const raw = discount.kind === "percent"
        ? Math.round((subtotalPaise * Number(discount.value || 0)) / 100)
        : rupeesToPaise(discount.value || 0);

    const capped = discount.maxDiscountPaise > 0
        ? Math.min(raw, discount.maxDiscountPaise)
        : raw;

    // A discount larger than the bill is a refund, which is a different thing
    // entirely and not one a coupon is allowed to invent.
    return Math.max(0, Math.min(capped, subtotalPaise));
};

/**
 * Whether this offer is open to this job at all.
 *
 * Returns a sentence rather than false, because every one of these is
 * something the customer needs told: "that code has expired" and "that code is
 * not for this trade" are the difference between trying again and giving up.
 */
const reasonItCannotApply = (discount, { serviceKey, channel, subtotalPaise }) => {
    if (!discount || !discount.isActive) return "That code is not active.";

    const now = new Date();
    if (discount.startsAt && now < discount.startsAt) return "That offer has not started yet.";
    if (discount.endsAt && now > discount.endsAt) return "That offer has ended.";

    if (discount.usageLimit > 0 && discount.usedCount >= discount.usageLimit) {
        return "That offer has been fully claimed.";
    }

    if (discount.serviceKeys?.length && serviceKey && !discount.serviceKeys.includes(serviceKey)) {
        return "That offer is not for this service.";
    }

    if (discount.channels?.length && channel && !discount.channels.includes(channel)) {
        return "That offer cannot be used here.";
    }

    if (discount.minBillPaise > 0 && subtotalPaise > 0 && subtotalPaise < discount.minBillPaise) {
        return "This job is below the amount that offer needs.";
    }

    return null;
};

/**
 * How many times one customer has already had this offer.
 *
 * Counted off the tickets rather than kept in a ledger of its own. A ticket
 * already records which offer it carried, so a second collection would be a
 * second thing to keep in step with it - and the count is only ever read once,
 * while somebody is typing a code.
 */
const timesUsedBy = async (discountId, customerId) => {
    if (!customerId) return 0;

    return ticketModel.countDocuments({
        customer: customerId,
        "discount.discountId": discountId,
        status: { $ne: "Cancelled" },
    });
};

/**
 * Does an offer apply to this job, and what is it worth?
 *
 * `code` picks one by name; without a code the best automatic offer that
 * matches is used - best meaning worth the most to the customer, because an
 * offer they have to hunt for is not an offer.
 *
 * Returns `{ discount }` on success, `{ error }` when a code was given and
 * cannot be used, and `{}` when nothing applies and nothing was asked for. The
 * three are different: a typed code that fails has to be said out loud, and no
 * automatic offer matching is silent.
 */
const quote = async ({ code, serviceKey, channel, customerId, subtotalPaise = 0 }) => {
    const wanted = String(code || "").trim().toUpperCase();

    if (wanted) {
        const found = await Discount.findOne({ code: wanted });
        if (!found) return { error: "We do not know that code." };

        const why = reasonItCannotApply(found, { serviceKey, channel, subtotalPaise });
        if (why) return { error: why };

        if (found.perCustomerLimit > 0) {
            const already = await timesUsedBy(found._id, customerId);
            if (already >= found.perCustomerLimit) {
                return { error: "You have already used that offer." };
            }
        }

        return { discount: shapeFor(found, subtotalPaise) };
    }

    // Automatic offers only - anything with a code has to be asked for.
    const now = new Date();
    const open = await Discount.find({
        code: null,
        isActive: true,
        $and: [
            { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
            { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
        ],
    }).lean();

    let best = null;

    for (const offer of open) {
        if (reasonItCannotApply(offer, { serviceKey, channel, subtotalPaise })) continue;

        if (offer.perCustomerLimit > 0) {
            // eslint-disable-next-line no-await-in-loop
            const already = await timesUsedBy(offer._id, customerId);
            if (already >= offer.perCustomerLimit) continue;
        }

        const worth = amountOn(offer, subtotalPaise);
        if (!best || worth > best.worth) best = { offer, worth };
    }

    return best ? { discount: shapeFor(best.offer, subtotalPaise) } : {};
};

/**
 * The offer as a ticket carries it.
 *
 * A snapshot, not a reference. The office changing a percentage next month must
 * not rewrite what a customer was promised in March, which is the same reason
 * the commission rate is frozen onto a bill rather than read live.
 */
const shapeFor = (discount, subtotalPaise) => ({
    discountId: discount._id,
    code: discount.code || null,
    label: discount.label,
    kind: discount.kind,
    value: discount.value,
    bornBy: discount.bornBy || "company",
    vendorSharePercent: discount.vendorSharePercent || 0,
    maxDiscountPaise: discount.maxDiscountPaise || 0,

    // Indicative only, on whatever subtotal was known when it was quoted. The
    // real figure is worked out again against the actual bill - a booking has
    // no idea what the job will come to.
    amountPaise: amountOn(discount, subtotalPaise),
});

/**
 * Whose earnings the discount comes out of.
 *
 * The bill is smaller by `discountPaise`, so that money is not collected and
 * somebody earns less. This decides who, and it is deliberately the only
 * function that does.
 *
 * Until Mohan settles the policy, `company` is the default on every offer: the
 * vendor's share is worked out as though the job had been billed in full and
 * the whole reduction lands on the commission. A vendor who never agreed to an
 * offer should not find their earnings cut by it.
 */
const split = (held, discountPaise) => {
    if (!(discountPaise > 0)) return { companyPaise: 0, vendorPaise: 0 };

    const bornBy = held?.bornBy || "company";

    if (bornBy === "vendor") {
        return { companyPaise: 0, vendorPaise: discountPaise };
    }

    if (bornBy === "shared") {
        const vendorPaise = Math.round((discountPaise * Number(held.vendorSharePercent || 0)) / 100);
        return { companyPaise: discountPaise - vendorPaise, vendorPaise };
    }

    return { companyPaise: discountPaise, vendorPaise: 0 };
};

/**
 * Records that an offer was actually used.
 *
 * Called when a bill carrying it is raised, not when it is quoted: a customer
 * who is shown a discount and then does not go ahead has not used anything, and
 * a limited offer burnt on an abandoned booking is an offer the next customer
 * cannot have.
 *
 * Never awaited by anything that has work left to do. A counter that fails to
 * move costs the office a slightly generous offer, which is not worth failing a
 * bill over with a vendor standing in somebody's kitchen.
 */
const claim = async (discountId) => {
    if (!discountId) return;

    await Discount.updateOne({ _id: discountId }, { $inc: { usedCount: 1 } })
        .catch((err) => console.log("[DISCOUNT] could not record a use: " + err.message));
};

/** The other way, for a bill that was corrected off the offer or cancelled. */
const release = async (discountId) => {
    if (!discountId) return;

    await Discount.updateOne(
        { _id: discountId, usedCount: { $gt: 0 } },
        { $inc: { usedCount: -1 } }
    ).catch((err) => console.log("[DISCOUNT] could not give a use back: " + err.message));
};

module.exports = { quote, amountOn, split, claim, release, shapeFor };

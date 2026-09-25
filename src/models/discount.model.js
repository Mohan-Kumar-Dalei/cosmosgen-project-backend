const mongoose = require("mongoose");

/**
 * An offer the office can take off a bill.
 *
 * Nothing in the product creates one of these yet. It is written ahead of the
 * rules because the rules are the cheap part: what a discount is worth, who it
 * applies to and who ends up paying for it are three separate decisions, and
 * the expensive one is threading a number through the bill, the invoice, the
 * commission, the wallet and the gateway link after the fact. That thread is in
 * place now; when Mohan says how the deduction should work it is a value in
 * here, not a change across five files.
 *
 * An empty collection means every bill computes exactly as it did before.
 */
const discountSchema = new mongoose.Schema({
    /*
     * A code the customer types, or nothing at all.
     *
     * Two kinds of offer live in the same collection because they differ only
     * in how they are reached. A code is typed in at booking; an automatic
     * offer - a festival week, a first job, a trade the office wants to push -
     * has no code and applies to whatever matches. Making them two collections
     * would mean writing the matching and the arithmetic twice.
     *
     * Sparse, so the many automatic offers with no code do not collide on null.
     */
    code: {
        type: String,
        uppercase: true,
        trim: true,
        default: null,
        index: { unique: true, sparse: true },
    },

    // What appears on the invoice line and in the app. The customer reads this
    // rather than the code, so it is a sentence, not a slug.
    label: { type: String, required: true, trim: true },

    /*
     * Percent off, or a flat amount off. Nothing else.
     *
     * "Buy one get one" and "free visit charge" are tempting to add here and
     * both are a different shape - they change the line items rather than the
     * total. When one is wanted it gets its own kind and its own branch, rather
     * than being smuggled in as a percent that happens to work out.
     */
    kind: { type: String, enum: ["percent", "flat"], required: true },

    // Percent when kind is percent (0-100), rupees when kind is flat.
    value: { type: Number, required: true, min: 0 },

    // The most a percent offer may take off. 20% with no ceiling on a
    // Rs 40,000 job is Rs 8,000, which is not what anybody means by 20% off.
    // Zero is no ceiling, and is only ever right on a flat offer.
    maxDiscountPaise: { type: Number, default: 0 },

    // The bill has to clear this before the offer applies at all.
    minBillPaise: { type: Number, default: 0 },

    // Which trades it covers. Empty means every trade - the common case, and
    // the reason this is not required.
    serviceKeys: [{ type: String }],

    /*
     * Where the job was booked from.
     *
     * An offer to pull people into the app is worth nothing if it also applies
     * to the same customer booking on WhatsApp. Empty means every channel.
     */
    channels: [{ type: String, enum: ["app", "whatsapp", "web"] }],

    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    /*
     * How many times it may be used, in total and by one customer.
     *
     * Zero means no limit on either. `usedCount` is only ever moved by
     * discount.service - a bill that is corrected downwards puts the claim
     * back, so a customer is not charged a use for a typo the vendor made.
     */
    usageLimit: { type: Number, default: 0 },
    usedCount: { type: Number, default: 0 },
    perCustomerLimit: { type: Number, default: 1 },

    /*
     * Whose money this comes out of, which is the only genuinely hard part.
     *
     * The bill is smaller, so somebody earns less. Three answers, and the
     * default is the one that cannot surprise a vendor:
     *
     *   company - the vendor is paid on what the job would have cost, and the
     *             whole discount lands on the company's commission. A vendor
     *             who never agreed to an offer is not funding it.
     *   vendor  - the vendor carries it, which is only ever right when the
     *             vendor asked for the offer themselves.
     *   shared  - split by `vendorSharePercent`, the rest on the company.
     *
     * Read by discount.service.split(); nothing else is allowed to decide it,
     * so there is one place to change when Mohan settles the policy.
     */
    bornBy: { type: String, enum: ["company", "vendor", "shared"], default: "company" },
    vendorSharePercent: { type: Number, default: 0, min: 0, max: 100 },

    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
}, { timestamps: true });

// The lookup every booking makes: the live offers, newest first.
discountSchema.index({ isActive: 1, startsAt: 1, endsAt: 1 });

module.exports = mongoose.model("Discount", discountSchema);

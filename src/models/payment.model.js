const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
     ticket: { type: mongoose.Schema.Types.ObjectId, ref: "Ticket", default: null, index: true },
    ticketNumber: { type: String },
    invoiceNumber: { type: String },

    amountPaise: { type: Number, required: true },

    /*
     * How the money moved, and it is not a tidy list.
     *
     * Three of these are ours - cash, online and split, chosen by the vendor
     * when the bill is raised. The rest are Razorpay's: the webhook
     * overwrites the method with whatever the gateway says it actually was,
     * so an online bill comes back as "upi" or "card" or "netbanking".
     *
     * The enum said cash, upi, online and had been wrong for as long as
     * splits existed. It never threw, because findOneAndUpdate does not run
     * validators unless asked - so the field quietly held values the schema
     * denied, and the first person to add runValidators would have broken
     * every split in the system. Written down properly instead.
     */
    method: {
        type: String,
        enum: ["cash", "online", "split", "upi", "card", "netbanking", "wallet", "emi", "paylater"],
        default: "cash",
    },

    status: {
        type: String,
        enum: ["pending", "collected", "verified", "failed"],
        default: "pending",
    },

    // Frozen at billing time so a rate change never rewrites past numbers
    commissionPercent: { type: Number },
    commissionPaise: { type: Number, default: 0 },
    technicianSharePaise: { type: Number, default: 0 },

    // Razorpay's cut, captured from the webhook. Without this the company's
    // real margin is invisible - commission looks like profit when 2% of
    // gross has already left the account.
    gatewayFeePaise: { type: Number, default: 0 },
    gatewayTaxPaise: { type: Number, default: 0 },

    // Who collected it (technician) and who reconciled it (admin)
    collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
    collectedAt: { type: Date },
    note: { type: String },

    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    verifiedAt: { type: Date },

    // A trip that was billed but no work was done, because the customer
    // refused after the quote. Kept as a flag rather than inferred from the
    // line items, so the office can pull them out as their own list.
    isVisitCharge: { type: Boolean, default: false },

    // What Razorpay itself said when the office pressed Verify. Kept so the
    // screen can show that the id was actually checked against the gateway
    // rather than simply ticked off by hand - the two look identical
    // afterwards otherwise, and only one of them is evidence.
    gatewayCheck: {
        checkedAt: { type: Date },
        status: { type: String },
        amountPaise: { type: Number },
        // What we expected the gateway to have taken - the whole bill
        // normally, only the company's half on a split
        expectedPaise: { type: Number },
        methodUsed: { type: String },
        matched: { type: Boolean },
        checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
        checkedByName: { type: String },
    },

    razorpayLinkId: { type: String, index: true },
    razorpayLinkUrl: { type: String },
    razorpayPaymentId: { type: String },
    processedEventIds: [{ type: String }],
}, { timestamps: true });

paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ collectedBy: 1, status: 1 });
// The reconciliation queue filters on both at once
paymentSchema.index({ method: 1, status: 1, createdAt: -1 });
// The settlement claim is an upsert on this id from two places at once - the
// webhook and the office's check. Without a unique index a genuinely
// simultaneous pair can both insert, which is the double credit this was
// meant to stop. Partial rather than sparse so the many rows with no gateway
// id at all are left alone.
paymentSchema.index(
    { razorpayPaymentId: 1 },
    { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: "string" } } }
);

module.exports = mongoose.model("Payment", paymentSchema);
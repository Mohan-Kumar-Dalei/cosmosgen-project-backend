const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
     ticket: { type: mongoose.Schema.Types.ObjectId, ref: "Ticket", default: null, index: true },
    ticketNumber: { type: String },
    invoiceNumber: { type: String },

    amountPaise: { type: Number, required: true },

    method: { type: String, enum: ["cash", "upi", "online"], default: "cash" },

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

    razorpayLinkId: { type: String, index: true },
    razorpayLinkUrl: { type: String },
    razorpayPaymentId: { type: String },
    processedEventIds: [{ type: String }],
}, { timestamps: true });

paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ collectedBy: 1, status: 1 });
// The reconciliation queue filters on both at once
paymentSchema.index({ method: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Payment", paymentSchema);
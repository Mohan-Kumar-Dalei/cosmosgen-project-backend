const mongoose = require("mongoose");
const Counter = require("./counter.model");

const ticketSchema = new mongoose.Schema({
    // Human readable - the office can't read an ObjectId out over the phone
    ticketNumber: { type: String, unique: true, index: true },

    channel: { type: String, enum: ["whatsapp", "web"], default: "whatsapp" },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Snapshot taken at booking time. If the customer moves later, old
    // tickets must keep the address the job was actually done at.
    customerSnapshot: {
        name: { type: String },
        phone: { type: String },
        address: { type: String },
        area: { type: String },
        state: { type: String },
        landmark: { type: String },
        lat: { type: Number },
        lon: { type: Number },
    },

    // GeoJSON for $geoNear - [lon, lat] order
    location: {
        type: { type: String, enum: ["Point"], default: "Point" },
        coordinates: { type: [Number], default: undefined },
    },

    serviceKey: { type: String, required: true },
    serviceLabel: { type: String, required: true },

    selectedIssues: [{ type: String }],
    problemDescription: { type: String },
    aiDiagnosis: { type: String },

    technician: { type: mongoose.Schema.Types.ObjectId, ref: "Technician", default: null },
    technicianSnapshot: {
        name: { type: String },
        phone: { type: String },
        profileImage: { type: String },
        rating: { type: Number },
    },

    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
    assignedAt: { type: Date },
    distanceAtAssignment: { type: Number },

    scheduling: {
        scheduledFor: { type: Date },
        slotWindow: { type: String },
        isRescheduled: { type: Boolean, default: false },
        rescheduleHistory: [{
            oldDate: { type: Date },
            newDate: { type: Date },
            reason: { type: String },
            by: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
            at: { type: Date, default: Date.now },
        }],
    },

    queuedAt: { type: Date },

    // Kept after a technician turns a job down. The ticket goes back to
    // Pending, but the office needs to see who declined and why before
    // handing it to someone else. Cleared on the next assignment.
    rejection: {
        rejectedByName: { type: String },
        reason: { type: String },
        rejectedAt: { type: Date },
        wasScheduled: { type: Boolean, default: false },
    },

    status: {
        type: String,
        enum: ["Pending", "Queued", "Assigned", "In-Progress", "Payment-Pending", "Closed", "Cancelled"],
        default: "Pending",
    },

    statusHistory: [{
        from: { type: String },
        to: { type: String },
        actorRole: { type: String },
        actorId: { type: mongoose.Schema.Types.ObjectId },
        reason: { type: String },
        at: { type: Date, default: Date.now },
    }],

    cancelReason: { type: String },

    billing: {
        invoiceNumber: { type: String },
        lineItems: [{
            description: { type: String },
            amountPaise: { type: Number },
        }],
        workDone: { type: String },
        subtotalPaise: { type: Number, default: 0 },
        gstPercent: { type: Number, default: 0 },
        gstPaise: { type: Number, default: 0 },
        totalPaise: { type: Number, default: 0 },

        // Snapshot the commission that applied when this job was billed.
        // Reading the technician's live rate later would silently rewrite
        // every past job's numbers each time the rate changes.
        commissionPercent: { type: Number },
        commissionPaise: { type: Number },
        technicianSharePaise: { type: Number },

        createdByTechnician: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
        billedAt: { type: Date },
    },

    payment: {
        status: {
            type: String,
            enum: ["Pending", "Collected", "Verified", "Failed"],
            default: "Pending",
        },
        method: { type: String, enum: ["cash", "upi", "online"] },
        collectedAt: { type: Date },
        collectedNote: { type: String },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
        verifiedAt: { type: Date },
        razorpayLinkId: { type: String },
        razorpayLinkUrl: { type: String },
        razorpayPaymentId: { type: String },
    },
}, { timestamps: true });

ticketSchema.index({ status: 1, createdAt: -1 });
ticketSchema.index({ technician: 1, status: 1, updatedAt: -1 });
ticketSchema.index({ customer: 1, createdAt: -1 });
ticketSchema.index({ location: "2dsphere" });

// Ticket number: CG-2608-0001
ticketSchema.pre("validate", async function () {
    if (this.ticketNumber) return;

    const now = new Date();
    const prefix = `CG-${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;

    // $inc is atomic - two tickets created in the same millisecond still
    // get different numbers
    const counter = await Counter.findByIdAndUpdate(
        `ticket-${prefix}`,
        { $inc: { seq: 1 } },
        { returnDocument: "after", upsert: true }
    );

    this.ticketNumber = `${prefix}-${String(counter.seq).padStart(4, "0")}`;
});

module.exports = mongoose.model("Ticket", ticketSchema);
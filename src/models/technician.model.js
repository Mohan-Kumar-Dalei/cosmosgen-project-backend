const mongoose = require("mongoose");

const technicianSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    // Phone is the technician's identity - they sign in with it, and a
    // blocked number can never be reused because this stays unique
    phone: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true, select: false },

    state: { type: String, required: true, trim: true },
    area: { type: String, required: true, trim: true },
    pincode: { type: String, required: true, trim: true },

    profileImage: { type: String, default: "" },
        email: { type: String, trim: true, lowercase: true },
    skills: [{ type: String }],
    hasVehicle: { type: Boolean, default: false },
    rating: { type: Number, default: 5.0, min: 0, max: 5 },

    location: {
        // No default on type - Mongoose would stamp { type: "Point" } onto every
        // new document, and the 2dsphere index rejects a location object with
        // a type but no coordinates
        type: { type: String, enum: ["Point"] },
        coordinates: { type: [Number] },
    },
    lastLocationAt: { type: Date },

    completedJobs: { type: Number, default: 0 },
    performanceLevel: {
        type: String,
        enum: ["STARTER", "PRO", "EXPERT"],
        default: "STARTER",
    },

    // Accounts sit here until the office checks them. Nobody signs in
    // or receives work while pending.
    approvalStatus: {
        type: String,
        enum: ["pending", "approved", "rejected"],
        default: "pending",
        index: true,
    },

    walletBalancePaise: { 
        type: Number, 
        default: 0 
    },
    commissionRate: { 
        type: Number, 
        default: () => parseInt(process.env.DEFAULT_COMMISSION_RATE) || 20, // Environment variable driven
        min: 0, 
        max: 100 
    },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    approvedAt: { type: Date },
    rejectionReason: { type: String },

    // A blocked number is permanently barred - login and re-registration
    // both check this before anything else
    isBlacklisted: { type: Boolean, default: false },
    blacklistedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    blacklistedAt: { type: Date },
    blacklistReason: { type: String },

    isAvailable: { type: Boolean, default: false },
    activeTicket: { type: mongoose.Schema.Types.ObjectId, ref: "Ticket", default: null },

        // Where payouts go. The account number is select:false so it can never
    // ride along in a response by accident - anything that needs it has to
    // ask for it explicitly.
    bankDetails: {
        accountHolderName: { type: String, trim: true },
        accountNumber: { type: String, select: false },
        // Kept separately so the panel can show "ending 4417" without
        // touching the full number
        accountLast4: { type: String },
        ifsc: { type: String, uppercase: true, trim: true },
        bankName: { type: String },
        branch: { type: String },
        verifiedAt: { type: Date },
    },

    // Set from the Firebase token, never from the request body
    phoneVerifiedAt: { type: Date },
    firebaseUid: { type: String, index: true, sparse: true },

    isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

technicianSchema.index({ location: "2dsphere" });
technicianSchema.index({ state: 1, area: 1, isAvailable: 1 });
technicianSchema.index({ approvalStatus: 1, isDeleted: 1 });

module.exports = mongoose.model("Technician", technicianSchema);
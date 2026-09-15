const mongoose = require("mongoose");

const technicianSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    // Phone is the technician's identity - they sign in with it, and a
    // blocked number can never be reused because this stays unique
    phone: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true, select: false },

    /*
     * Where the vendor is, in the two halves the office actually uses.
     *
     * `city` is chosen from a list rather than typed, so "Bhubaneswar",
     * "bhubaneshwar" and "BBSR" cannot all exist side by side and be counted
     * as three places - and picking one fills in the state and a starting
     * pincode without a single call to a map provider.
     *
     * `address` is the rest of it in the vendor's own words: house, lane,
     * landmark. The office reads it when a pin lands a few streets off and
     * somebody has to ring back, which is exactly what the client asked for.
     *
     * This replaced a single `area` field. Note that none of these decide who
     * gets a job - dispatch is geographic, a $near query against the 2dsphere
     * index below. These are for reading, searching and ringing back.
     */
    state: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },

    /*
     * Which part of the town, chosen rather than typed.
     *
     * The post office's own name for the locality, picked from the list of
     * everything inside the chosen town. That is the difference between this
     * and the free-text field it replaced: "Patia", "patia bbsr" and "PATIA
     * SQUARE" were three places as far as the office was concerned, and none
     * of them matched what was written on an envelope.
     *
     * Town plus locality is the whole answer - "Rasulgarh, Bhubaneswar" is
     * where a vendor works, and the pincode comes with it rather than being
     * asked for. Which is why there is no street address here: it was a
     * question with no reader, since the pin is what an engineer navigates to.
     */
    area: { type: String, required: true, trim: true },

    // Kept, not asked for. Nothing collects it today; it is here so a record
    // written when the form did ask is not silently dropped.
    address: { type: String, trim: true, default: "" },
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

    /*
     * When the current answer to `isAvailable` began, and how long the last
     * absence lasted.
     *
     * The flag on its own says whether somebody is on duty now and nothing
     * about the shape of their week, which is the thing the office is
     * actually judging: a vendor who went offline an hour ago is having a
     * break, and one who has been offline since Tuesday is a vendor you
     * should stop sending work to. Two numbers answer both - how long this
     * stretch has run, and how long the one before it did.
     *
     * Only the vendor's own switch moves these. Being assigned a job also
     * clears `isAvailable`, and that is not an absence - it is work.
     */
    availabilitySince: { type: Date },
    lastAwayMs: { type: Number },
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


    isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

technicianSchema.index({ location: "2dsphere" });
technicianSchema.index({ state: 1, city: 1, isAvailable: 1 });
technicianSchema.index({ approvalStatus: 1, isDeleted: 1 });

module.exports = mongoose.model("Technician", technicianSchema);
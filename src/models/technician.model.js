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
     * `city` is picked from a suggestion rather than typed, so "Bhubaneswar",
     * "bhubaneshwar" and "BBSR" cannot all exist side by side and be counted
     * as three places - and picking one settles the state with it.
     *
     * `area` is where inside that town, and it carries the whole line rather
     * than a word - see below. Between them they are the answer; there is no
     * separate street address, because that was a third question about the
     * same thing and it came back empty every time.
     *
     * Note that none of these decide who gets a job - dispatch is geographic,
     * a $near query against the 2dsphere index below. These are for reading,
     * searching and ringing somebody back.
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
     * It holds the whole line, not just the name: "Palasuni, Rasulgarh,
     * Bhubaneswar, Odisha, India" rather than "Palasuni". There was a separate
     * address field beside this for a while and nobody ever filled it in,
     * because a vendor who has just picked his locality off a map has already
     * answered the question - asking again read as the form not listening. So
     * the two are one field, and what Google calls the place is what the
     * office reads.
     */
    area: { type: String, required: true, trim: true },
    pincode: { type: String, required: true, trim: true },

    profileImage: { type: String, default: "" },
        email: { type: String, trim: true, lowercase: true },
    skills: [{ type: String }],
    hasVehicle: { type: Boolean, default: false },
    /*
     * The running average, and the number of answers behind it.
     *
     * The default of five is a placeholder for a vendor nobody has rated yet,
     * not a score they earned - which is why the count matters. With no
     * ratings the first one replaces the default outright rather than being
     * averaged into it, so one genuine three does not show as a four.
     */
    rating: { type: Number, default: 5.0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0 },

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

    /**
     * Where to reach this phone when the app is not running.
     *
     * The socket only exists while the app is in front of somebody. Press the
     * home button and Android freezes the process - no socket, no JavaScript,
     * no alert - which is how a job could be assigned to a vendor standing
     * there holding a silent phone. A push goes through the platform instead
     * of through us, so it lands whatever state the app is in.
     *
     * One token, not a list: a vendor signs in on one phone, and a token
     * written by a second device should replace the first rather than ring
     * both. Unset rather than emptied when a device stops accepting it - see
     * DeviceNotRegistered in push.service.js.
     */
    pushToken: { type: String, trim: true },

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

    /*
     * Jobs handed back, counted - because one is a reason and five is a habit.
     *
     * A technician saying "I cannot do this one" is a normal thing to say, and
     * the office would rather hear it than have somebody drive out and waste
     * the trip. What it must not be is free: a vendor who turns down every job
     * that is far, awkward or cheap leaves the good ones for everybody else
     * and the office chasing him.
     *
     * A refusal by the customer is not counted here. That is the customer's
     * decision about a price, arriving through whoever happened to be standing
     * on the doorstep, and holding it against him would teach him to hide it.
     *
     * `today` resets by comparing `dayKey` rather than by a scheduled job -
     * nothing has to run at midnight, and a server that was asleep then still
     * gets the right answer on the first request of the morning. The key is an
     * Indian date, because that is the day the vendor is working.
     */
    declines: {
        total: { type: Number, default: 0 },
        today: { type: Number, default: 0 },
        dayKey: { type: String, default: "" },

        /*
         * The last few, in the vendor's own words.
         *
         * A count tells the office that somebody is refusing a lot; only the
         * reasons tell them whether he is dodging work or whether dispatch
         * keeps sending him jobs across the city. Capped, because this is
         * evidence for a conversation, not an audit log.
         */
        recent: [{
            ticket: { type: mongoose.Schema.Types.ObjectId, ref: "Ticket" },
            ticketNumber: { type: String },
            reason: { type: String },
            at: { type: Date },
        }],
    },

    /*
     * Paused until this moment. Null means working.
     *
     * Set to the start of the next Indian day when the limit is reached, so
     * the rest of that day is lost and the morning is clean. It is one field
     * on purpose: if the client ever wants a fine instead of a lost day, the
     * payment only has to clear this - see liftSuspension in
     * services/discipline.service.js.
     */
    suspendedUntil: { type: Date, default: null },

    /** Every pause, kept so a pattern is visible even after it has expired. */
    suspensions: [{
        at: { type: Date },
        until: { type: Date },
        declines: { type: Number },

        // Only set when a pause was ended early, which is the case somebody
        // reading this list later most needs explained.
        reason: { type: String },
    }],

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

    /*
     * When the account was deleted, and the thing that eventually removes it.
     *
     * Deleting a vendor has always been a flag rather than a removal, which is
     * right - tickets, payouts and a wallet balance all point at this row, and
     * dropping it the moment somebody taps a button would take the office's
     * own history with it. What was missing is the second half: the row then
     * sat there for ever, and the panel had no way to see or finish it.
     *
     * So the date is stamped, the office gets a week to change its mind or
     * clear it out by hand, and Mongo removes whatever is left. The TTL index
     * below is what does that - no cron job, no forgotten script, and it keeps
     * working whether or not anybody is logged in.
     */
    deletedAt: { type: Date },
}, { timestamps: true });

technicianSchema.index({ location: "2dsphere" });
technicianSchema.index({ state: 1, city: 1, isAvailable: 1 });
technicianSchema.index({ approvalStatus: 1, isDeleted: 1 });

/*
 * Seven days after deletion, gone.
 *
 * Mongo checks about once a minute, so "seven days" is seven days and change -
 * which is the right kind of precision for a grace period. Only a deleted row
 * carries `deletedAt`, so nothing else is ever in range of this.
 */
technicianSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model("Technician", technicianSchema);
const mongoose = require("mongoose");
const Counter = require("./counter.model");

const ticketSchema = new mongoose.Schema({
    // Human readable - the office can't read an ObjectId out over the phone
    ticketNumber: { type: String, unique: true, index: true },

    /**
     * Where the job was booked from.
     *
     * "app" is the customer's Android app, and it was missing: the booking
     * service has always stamped tickets with it, so every booking made in the
     * app failed validation and came back to the customer as an internal
     * server error. It is a real channel and it behaves like WhatsApp rather
     * than like "web" - the customer is reachable on their number, so the
     * codes and the invoice still go out to them there.
     */
    channel: { type: String, enum: ["whatsapp", "web", "app"], default: "whatsapp" },

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

    /*
     * When the technician said yes.
     *
     * Assignment is the office's decision; acceptance is his. Until this is
     * set the job is an offer, and the customer has not been told anything at
     * all - not the technician's name, not his number, nothing. That is the
     * whole point: a customer who is told about Ramesh and then about Suresh
     * has been shown our dispatch problem, and they did not ask to see it.
     *
     * Cleared whenever the job changes hands, because the next technician has
     * not agreed to anything yet.
     */
    acceptedAt: { type: Date, default: null },

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

        // "I can't reach this area today" and "the customer heard the price
        // and said no" are not the same event. The first should go back in
        // the queue for someone else; sending a second technician on the
        // second one wastes another trip on a customer who already refused.
        outcome: {
            type: String,
            enum: ["cannot_do", "customer_refused"],
            default: "cannot_do",
        },
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

    // The ride is its own block, not a new status value. Adding "En-Route" to
    // the enum above would mean auditing every $in filter in the codebase -
    // dispatch, analytics, admin lists, technician queries - and a single
    // missed array would silently hide live tickets from a screen. A ticket on
    // the road is still "Assigned"; ride.startedAt is what says it has left.
    ride: {
        startedAt: { type: Date },
        arrivedAt: { type: Date },

        // Where the technician was when they hit start. Kept so we can tell a
        // stale route from a fresh one if they restart the ride.
        origin: {
            lat: { type: Number },
            lon: { type: Number },
        },

        // Snapshot of the Routes API answer at departure. Stored rather than
        // recomputed so the AI can answer "kitni der lagegi" without spending
        // another billed route call on every customer message.
        etaSeconds: { type: Number },
        distanceMeters: { type: Number },
        etaAt: { type: Date },
        encodedPolyline: { type: String },
        computedAt: { type: Date },

        /*
         * Roughly where the technician is, in words.
         *
         * A customer watching a bike cross a map can see it moving and still
         * not know where it is - the one thing they would say out loud is the
         * name of the place. It is stored rather than worked out on demand so
         * that every screen watching this job gets the same answer from one
         * lookup, and `placeAt` is the position it was taken at, which is what
         * stops it being bought again every few seconds.
         */
        nearPlace: { type: String },
        placeAt: {
            lat: { type: Number },
            lon: { type: Number },
        },

        /*
         * When he was first seen off the drawn route, and still is.
         *
         * A single position well away from the line is usually the phone
         * rather than the rider - a city fix jumps thirty metres between two
         * buildings - so one is not enough to act on. Holding the moment it
         * started lets the ride wait for a second one before it believes him,
         * and cleared the moment he is back on the line.
         */
        offRouteSince: { type: Date },
    },

    /**
     * The call placed before anybody is sent out.
     *
     * A technician who arrives at an empty house has cost the company a trip
     * and the customer their slot, so the answer to "will you be in" is worth
     * knowing before the job is assigned rather than after.
     */
    availabilityCheck: {
        calledAt: { type: Date },
        available: { type: Boolean },
        // Free text rather than a parsed date - the office reads this and picks
        // a slot, and a model guessing at an exact timestamp would book the
        // wrong one. Written in English even when the call was in Odia or
        // Hindi, because this is read on an English screen.
        preferredDay: { type: String, default: "" },
        preferredTime: { type: String, default: "" },
        wantsCancel: { type: Boolean, default: false },
        note: { type: String, default: "" },
    },

    /**
     * The call placed after the job closed.
     *
     * Two separate questions on purpose: whether the work was actually done,
     * and how the vendor behaved. A vendor can fix an air conditioner
     * perfectly and still be somebody the company should not send back.
     */
    feedback: {
        calledAt: { type: Date },
        rating: { type: Number, min: 0, max: 5, default: 0 },
        workOk: { type: Boolean },
        behaviourOk: { type: Boolean },
        complaint: { type: String, default: "" },
        note: { type: String, default: "" },
    },

    /**
     * The customer's own window onto the job.
     *
     * A random token rather than the ticket id, because this link is sent
     * over WhatsApp and forwarded on: anyone holding it can watch the
     * technician approach, so it must not be guessable from a ticket number,
     * and it must be revocable without touching the ticket itself.
     */
    tracking: {
        token: { type: String, index: true, sparse: true },
        issuedAt: { type: Date },
    },

    /**
     * The codes the customer reads out at the door.
     *
     * Two of them, because two moments matter. `start` stops a job being
     * marked as begun from the car park, and `close` stops one being finished
     * without the person who is paying for it agreeing that it is. Both are
     * sent to the customer, so the technician has to be in front of them.
     *
     * Kept on the ticket rather than in a codes collection: they are worth
     * nothing once the job moves on, and having them here means the audit of
     * who verified what reads in one place.
     */
    otp: {
        start: {
            code: { type: String },
            sentAt: { type: Date },
            verifiedAt: { type: Date },
            attempts: { type: Number, default: 0 },
        },
        close: {
            code: { type: String },
            sentAt: { type: Date },
            verifiedAt: { type: Date },
            attempts: { type: Number, default: 0 },
        },
    },

    /**
     * The customer said no to the price while the technician was standing
     * there, and the office is calling them back to find out why.
     *
     * Like `ride`, this is its own block rather than a new status value:
     * adding one to the enum means auditing every $in filter in dispatch,
     * analytics and the admin lists, and a single missed array would hide a
     * live ticket from a screen. The technician stays assigned throughout -
     * that is the point. He waits on site, so if the office talks the customer
     * round he simply carries on, with no second trip to arrange.
     */
    refusal: {
        raisedAt: { type: Date },
        raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
        raisedByName: { type: String },
        reason: { type: String },

        status: {
            type: String,
            enum: ["awaiting_verification", "customer_agreed", "customer_declined"],
        },

        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
        verifiedByName: { type: String },
        verifiedAt: { type: Date },
        officeNote: { type: String },

        // Set once the technician has raised the visit charge for the wasted
        // trip, so the ticket knows it is waiting on that rather than on a
        // full job before it can be closed off.
        visitChargeBilled: { type: Boolean, default: false },
    },

    cancelReason: { type: String },

    billing: {
        invoiceNumber: { type: String },

        /**
         * Where the customer's copy of the invoice lives.
         *
         * Written once, when the job closes, and never worked out from the
         * invoice number: ImageKit appends its own suffix when a file name is
         * already taken, so the only address that reliably points at this
         * ticket's document is the one it handed back on upload.
         *
         * Absent on an older ticket, and on one whose upload failed - both
         * mean the same thing to a screen, which is that there is no document
         * to offer yet.
         */
        invoicePdfUrl: { type: String },
        lineItems: [{
            description: { type: String },
            amountPaise: { type: Number },

            // Which price-list row this came from, so a correction can put
            // the same selection back on screen. Without it an edit would
            // have to rebuild every line as free text, and a catalogue price
            // the office controls would become a number the technician types.
            catalogItemId: { type: String, default: null },
            qty: { type: Number, default: 1 },
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

        // A bill used to be final the moment it was generated, so a
        // technician who mistyped a line had to phone the office with the
        // customer standing there. Corrections are allowed, capped, and kept
        // - an honest slip looks nothing like a bill rewritten four times.
        editCount: { type: Number, default: 0 },
        editHistory: [{
            at: { type: Date, default: Date.now },
            byTechnician: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
            reason: { type: String },
            fromTotalPaise: { type: Number },
            toTotalPaise: { type: Number },
        }],
    },

    payment: {
        status: {
            type: String,
            enum: ["Pending", "Collected", "Verified", "Failed"],
            default: "Pending",
        },

        // "split" is the cheapest way to take a bill. The technician takes
        // his own share in cash straight from the customer, and the customer
        // pays the company's commission through Razorpay. The gateway then
        // charges 2% of the commission instead of 2% of the whole bill, and
        // no money has to travel between company and technician afterwards -
        // so there is no second gateway fee and nothing left to chase.
        method: { type: String, enum: ["cash", "upi", "online", "split"] },

        // Only used by "split". Two halves land separately and the job is
        // not finished until both have.
        split: {
            technicianCashPaise: { type: Number },
            companyOnlinePaise: { type: Number },
            onlinePaidAt: { type: Date },
            cashConfirmedAt: { type: Date },
        },

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

/*
 * Ticket number: CG-2608-0001
 *
 * $inc is atomic, so two tickets created in the same millisecond cannot take
 * the same number - but that only holds while the counter and the tickets
 * agree. They stopped agreeing once: "E11000 duplicate key ... ticketNumber:
 * CG-2609-0001" means the counter handed out 1 for a month that already had a
 * ticket 1, which is what happens when the counters are cleared and the
 * tickets are not, or a database is restored from a point the counter is
 * behind.
 *
 * A booking is too expensive to lose to that. So a number that is already
 * taken is walked past rather than thrown: the counter is pushed forward and
 * asked again, and the loop is bounded because a hundred collisions in a row
 * is not a clash, it is something else entirely.
 */
const NUMBER_TRIES = 100;

ticketSchema.pre("validate", async function () {
    if (this.ticketNumber) return;

    const now = new Date();
    const prefix = `CG-${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;

    for (let i = 0; i < NUMBER_TRIES; i += 1) {
        const counter = await Counter.findByIdAndUpdate(
            `ticket-${prefix}`,
            { $inc: { seq: 1 } },
            { returnDocument: "after", upsert: true }
        );

        const candidate = `${prefix}-${String(counter.seq).padStart(4, "0")}`;

        // eslint-disable-next-line no-await-in-loop
        const taken = await mongoose.model("Ticket").exists({ ticketNumber: candidate });
        if (!taken) {
            this.ticketNumber = candidate;
            return;
        }

        console.warn("[TICKET] " + candidate + " is already taken, moving the counter on");
    }

    throw new Error("Could not find a free ticket number for " + prefix);
});

module.exports = mongoose.model("Ticket", ticketSchema);
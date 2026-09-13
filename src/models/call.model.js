const mongoose = require("mongoose");

/**
 * One phone call the system placed.
 *
 * Kept as its own collection rather than a block on the ticket because a call
 * has a life of its own: it rings, it is answered or it is not, it is retried,
 * and the office needs to see that history even when the answer never came.
 * A ticket wants the conclusion, not the attempts.
 */
const callSchema = new mongoose.Schema({
    ticket: { type: mongoose.Schema.Types.ObjectId, ref: "Ticket", index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Kept flat as well as on the ticket, because a call is placed to a number
    // and that number is what the office will ask about later
    phone: { type: String, required: true },

    /**
     * availability - before anyone is sent out, so a technician is not
     *                dispatched to an empty house
     * feedback     - after the job closed: was it fixed, how did the vendor
     *                behave, and a rating
     */
    purpose: {
        type: String,
        enum: ["availability", "feedback"],
        required: true,
    },

    status: {
        type: String,
        enum: ["queued", "ringing", "talking", "completed", "no_answer", "failed"],
        default: "queued",
        index: true,
    },

    language: { type: String, enum: ["english", "hinglish", "odenglish"], default: "odenglish" },

    // The carrier's id for the call, so a support question can be traced to their
    // console without guessing from timestamps
    providerCallSid: { type: String, index: true, sparse: true },

    /** What was actually said, in order. The office reads this, not a summary. */
    turns: [{
        role: { type: String, enum: ["assistant", "customer"] },
        text: { type: String },
        at: { type: Date, default: Date.now },
    }],

    /**
     * The structured answer the assistant reported at the end of the call.
     * Shape depends on purpose - see the tool declarations in voice.service.
     */
    outcome: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * The greeting, made while the phone was still ringing.
     *
     * On the record rather than in memory because the process that places a
     * call is not always the process that answers it - a call triggered from a
     * script, or from a second server behind a load balancer, would find an
     * empty cache and leave the customer listening to silence while it built
     * the line again. Cleared the moment it is played.
     */
    opening: {
        text: { type: String },
        audio: { type: String },
    },

    attempts: { type: Number, default: 0 },
    lastError: { type: String },

    startedAt: { type: Date },
    endedAt: { type: Date },
}, { timestamps: true });

// The office asks "what happened on this ticket", so that is the index
callSchema.index({ ticket: 1, purpose: 1, createdAt: -1 });

module.exports = mongoose.model("Call", callSchema);

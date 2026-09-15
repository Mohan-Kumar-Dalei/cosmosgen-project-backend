const mongoose = require("mongoose");

/**
 * The catalogue, in the database rather than in a file.
 *
 * It used to live in config/services.js, which meant adding a trade was a code
 * change and a deploy - and the office, who are the only people who actually
 * know when the company starts doing carpentry, could not do it. That file is
 * still the seed: every service in it is written in here on first boot, so
 * nothing that already worked stops working, and from then on this collection
 * is what the WhatsApp menu, the assistant, the app and the website all read.
 *
 * Everything except the picture is written by the assistant from the service's
 * own name. That is deliberate: the office has an image and a name, and asking
 * them to also compose a description, invent issue keys in three languages and
 * keep the wording consistent with four existing services is asking them to do
 * a job they did not sign up for and will do inconsistently.
 */
const issueSchema = new mongoose.Schema({
    key: { type: String, required: true, trim: true, uppercase: true },
    // The canonical wording. This is what goes on the ticket, so the office and
    // the engineer always read the same words whichever language the customer
    // picked.
    en: { type: String, required: true, trim: true },
    hinglish: { type: String, trim: true },
    odia: { type: String, trim: true },
}, { _id: false });

const applianceSchema = new mongoose.Schema({
    key: { type: String, required: true, trim: true, uppercase: true },
    label: { type: String, required: true, trim: true },
    labelHinglish: { type: String, trim: true },
    labelOdia: { type: String, trim: true },
    image: { type: String, default: "" },
    issues: [issueSchema],
}, { _id: false });

const serviceSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, uppercase: true, trim: true },

    label: { type: String, required: true, trim: true },
    labelHinglish: { type: String, trim: true },
    labelOdia: { type: String, trim: true },

    // What to call the person on this job. "Technician" everywhere sounds wrong
    // when somebody books a house cleaning.
    worker: { type: String, default: "technician", trim: true },

    // Matched against an engineer's free-text skills, so a service nobody is
    // approved for can never be dispatched to the wrong trade
    keywords: [{ type: String, trim: true, lowercase: true }],

    /* ---------- what the customer sees ---------- */

    // The one field the office fills in by hand
    image: { type: String, default: "" },

    blurb: { type: String, default: "", trim: true },

    // Short tags under the service on the website - "Same-day", "Gas refill",
    // "Parts from the list". Written by the assistant, editable by the office.
    badges: [{ type: String, trim: true }],

    appliances: [applianceSchema],
    issues: [issueSchema],

    /* ---------- housekeeping ---------- */

    order: { type: Number, default: 100 },
    isActive: { type: Boolean, default: true },

    // "config" for the four that came from the original file, "admin" for
    // anything the office added afterwards. Only the provenance differs -
    // both are read exactly the same way.
    source: { type: String, enum: ["config", "admin"], default: "admin" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
}, { timestamps: true });

serviceSchema.index({ isActive: 1, order: 1 });

module.exports = mongoose.model("Service", serviceSchema);

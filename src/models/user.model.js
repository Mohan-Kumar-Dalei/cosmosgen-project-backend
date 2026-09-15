const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true, trim: true },
    name: { type: String, default: "", trim: true },

    // WhatsApp hands us a profile nickname - "VICKY", emoji and all - which
    // is what used to land on tickets and invoices. This marks a name the
    // customer typed out themselves, so we only ever ask once.
    nameConfirmedAt: { type: Date },
    address: { type: String, default: "" },

    state: { type: String, default: "", trim: true },
    area: { type: String, default: "", trim: true },

    // Worked out from the pin, not typed. These are what the office reads
    // back when a dropped pin lands a few streets off and somebody has to
    // ring the customer to sort it out.
    city: { type: String, default: "", trim: true },
    pincode: { type: String, default: "", trim: true },
    lat: { type: Number },
    lon: { type: Number },

    /*
     * No default on `type`.
     *
     * It used to default to "Point", and on an upsert with
     * setDefaultsOnInsert that produced `location: { type: "Point" }` with no
     * coordinates at all - a shape the 2dsphere index below refuses, so the
     * insert failed and the customer's first sign-in came back a 500. It only
     * ever bit a brand new customer, which is why it survived a laptop and
     * showed up on the first day of real traffic.
     *
     * A point with no coordinates is not a point. The field is written whole,
     * both parts at once, when a customer sets their address.
     */
    location: {
        type: { type: String, enum: ["Point"] },
        coordinates: { type: [Number], default: undefined }, // [lon, lat]
    },
    /*
     * English until they say otherwise.
     *
     * This defaulted to Odenglish - Odia is the house language - and the
     * effect was that anybody who had never been asked was written to in
     * Roman-script Odia, including in the very first message the company ever
     * sends them. A house language is what we offer, not what we assume.
     *
     * Changing the default only affects accounts made from here on. Nothing
     * reads this field on its own any more, though: `languageConfirmedAt`
     * below is the test everywhere, so an older account carrying the old
     * default is still written to in English until somebody picks.
     */
    language: {
        type: String,
        enum: ["english", "hinglish", "odenglish"],
        default: "english",
    },

    // Language is never empty, so it cannot double as "have they chosen yet".
    // This is what says they picked it, and it is what every caller tests.
    languageConfirmedAt: { type: Date },

    role: { type: String, default: "customer" },
}, { timestamps: true });

userSchema.index({ location: "2dsphere" });
const userModel = mongoose.model('User', userSchema);
module.exports = userModel
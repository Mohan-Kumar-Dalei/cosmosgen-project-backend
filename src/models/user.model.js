const mongoose = require("mongoose");
const { LANGUAGE_ENUM } = require("../config/languages");

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
     * Every place this customer might want somebody sent.
     *
     * The account used to hold exactly one address - the one given at sign-up
     * - and every job went there. So a customer who registered at home and
     * then wanted the office AC looked at had no way to say so: the booking
     * went to the house, and the technician drove to an empty flat.
     *
     * The fields above are still the customer's main address, and still what
     * registration, the WhatsApp flow and the web panel read. They stay in
     * step with whichever entry here is marked default, so nothing that
     * already worked has to learn about this list. What the list adds is the
     * others, and the ability to point a single booking at one of them
     * without changing where the customer lives.
     *
     * Each carries its own pin, because a label without coordinates is a note
     * to a driver rather than a destination - the technician's map needs a
     * point, and the arrival test measures against it.
     */
    /*
     * Where to reach this phone when the app is not open.
     *
     * The same idea as the technician's, and for the same reason: the socket
     * only exists while somebody is looking at the app, so "your technician
     * has arrived" reached them on WhatsApp and nowhere else. One token, not a
     * list - a customer signs in on one phone, and a token written by a second
     * device should replace the first rather than ring both.
     */
    pushToken: { type: String, trim: true },

    /*
     * When this customer last opened the bell.
     *
     * One date rather than a read flag per notice. The bell holds a handful of
     * things the office broadcast to everybody, and a customer who has looked
     * at the list has looked at all of it - keeping a row per customer per
     * notice would be a join and a write on every open to answer a question a
     * timestamp already answers.
     *
     * Absent on a customer who has never opened it, which reads correctly as
     * "everything is unread".
     */
    noticesSeenAt: { type: Date, default: null },

    addresses: [{
        // What the customer calls it: Home, Office, Mum's place.
        label: { type: String, default: "", trim: true },

        address: { type: String, default: "", trim: true },
        area: { type: String, default: "", trim: true },
        city: { type: String, default: "", trim: true },
        state: { type: String, default: "", trim: true },
        pincode: { type: String, default: "", trim: true },

        lat: { type: Number },
        lon: { type: Number },

        /*
         * Exactly one of these is true, and the account's own address fields
         * mirror it. Enforced where they are written rather than here: a
         * schema cannot say "one of these, and keep those in step".
         */
        isDefault: { type: Boolean, default: false },

        createdAt: { type: Date, default: Date.now },
    }],

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
        enum: LANGUAGE_ENUM,
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
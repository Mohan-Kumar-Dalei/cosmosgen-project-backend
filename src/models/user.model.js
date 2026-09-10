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

    location: {
        type: { type: String, enum: ["Point"], default: "Point" },
        coordinates: { type: [Number], default: undefined }, // [lon, lat]
    },
    // Odia is the house language, so a customer who never picks one still
    // gets served in it rather than in English.
    language: {
        type: String,
        enum: ["english", "hinglish", "odenglish"],
        default: "odenglish",
    },

    // The default above means language is never empty, so it cannot double
    // as "have they chosen yet". This is what says they picked it.
    languageConfirmedAt: { type: Date },

    role: { type: String, default: "customer" },
}, { timestamps: true });

userSchema.index({ location: "2dsphere" });
const userModel = mongoose.model('User', userSchema);
module.exports = userModel
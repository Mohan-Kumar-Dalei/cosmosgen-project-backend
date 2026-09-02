const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true, trim: true },
    name: { type: String, default: "", trim: true },
    address: { type: String, default: "" },

    state: { type: String, default: "", trim: true },
    area: { type: String, default: "", trim: true },
    lat: { type: Number },
    lon: { type: Number },

    location: {
        type: { type: String, enum: ["Point"], default: "Point" },
        coordinates: { type: [Number], default: undefined }, // [lon, lat]
    },
    role: { type: String, default: "customer" },
}, { timestamps: true });

userSchema.index({ location: "2dsphere" });
const userModel = mongoose.model('User', userSchema);
module.exports = userModel
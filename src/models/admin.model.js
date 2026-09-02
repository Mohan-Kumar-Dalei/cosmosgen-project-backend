const mongoose = require("mongoose");

const adminSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    phone: { type: String, trim: true },

    // backoffice = ticket assign kar sakta hai
    // superadmin = admin bana/hata sakta hai + analytics (baad mein)
    role: { type: String, enum: ["backoffice", "superadmin"], default: "backoffice" },

    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model("Admin", adminSchema);
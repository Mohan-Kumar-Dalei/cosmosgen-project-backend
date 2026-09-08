const mongoose = require("mongoose");

/**
 * Numbers the owner is allowed to change without a deploy.
 *
 * These used to be constants in the code, which meant "let a technician fix a
 * bill three times" could only be changed by editing a file and restarting
 * the server. One document per setting, read through getSetting so a missing
 * row falls back to the built-in default rather than breaking the flow.
 */
const settingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
}, { timestamps: true });

module.exports = mongoose.model("Setting", settingSchema);

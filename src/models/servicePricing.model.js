const mongoose = require("mongoose");

// Each item gets its own _id automatically - technicians reference that
// when billing, and it stays stable across edits to other items.
const pricingItemSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: ["labour", "part", "service"], default: "part" },
    pricePaise: { type: Number, required: true, min: 0 },

    // Pre-selected on the technician's invoice form
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
});

// One document per service, holding the whole catalog for that service.
// Pricing is always read as a set, so embedding beats a separate collection.
const servicePricingSchema = new mongoose.Schema({
    serviceKey: { type: String, required: true, unique: true, index: true },
    serviceLabel: { type: String },
    itemsList: [pricingItemSchema],
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
}, { timestamps: true });

module.exports = mongoose.model("ServicePricing", servicePricingSchema);
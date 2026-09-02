const mongoose = require("mongoose");

/**
 * WhatsApp is stateless - every message arrives as a separate HTTP POST with
 * no memory of what came before. This tracks where each phone number is in
 * the booking flow so the webhook knows what to do with the next message.
 */
const conversationSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true, index: true },

step: {
        type: String,
        enum: [
            "NEW",
            "AWAITING_LOCATION",
            "AWAITING_SERVICE",
            "AWAITING_APPLIANCE",
            "AWAITING_ISSUE",
            "IN_DIAGNOSIS",
            "TICKET_CREATED",
            "IDLE",
        ],
        default: "NEW",
    },

    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    profileName: { type: String },

    selectedServiceKey: { type: String },
    // Which machine, for services that cover more than one
    selectedApplianceKey: { type: String },
    selectedIssues: [{ type: String }],

    location: {
        lat: { type: Number },
        lon: { type: Number },
        address: { type: String },
        capturedAt: { type: Date },
    },

    activeTicket: { type: mongoose.Schema.Types.ObjectId, ref: "Ticket" },

    // Meta retries a webhook it thinks failed, so the same message can land
    // twice. Keeping the recent ids lets us drop duplicates.
    processedMessageIds: [{ type: String }],

    lastInboundAt: { type: Date },
    lastOutboundAt: { type: Date },
}, { timestamps: true });

// Only the last few ids matter for dedupe - trim so the array can't grow forever
conversationSchema.pre("save", function () {
    if (this.processedMessageIds.length > 30) {
        this.processedMessageIds = this.processedMessageIds.slice(-30);
    }
});

module.exports = mongoose.model("Conversation", conversationSchema);
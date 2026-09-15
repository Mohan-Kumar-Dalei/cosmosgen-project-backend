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

            /*
             * Waiting for them to go and make an account on the app.
             *
             * WhatsApp no longer registers anybody itself: it checks whether
             * the number already has an account and, when it does not, parks
             * the conversation here until one appears.
             */
            "AWAITING_APP_SIGNUP",

            /*
             * Neither of these is reached any more - the location and the name
             * both come off the app record now. They stay in the list because
             * conversations already parked on one of them are still in the
             * database, and a row that cannot pass validation is a row that
             * cannot be saved when that customer next says hello.
             */
            "AWAITING_LOCATION",
            "AWAITING_NAME",

            "AWAITING_LANGUAGE",
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

    // Which of the three the customer picked. Mirrored from the user record
    // so the flow can check it without a lookup on every turn.
    language: { type: String, enum: ["english", "hinglish", "odenglish"] },

    // The name they typed, kept here so greetings can use it without
    // reloading the user on every turn.
    customerName: { type: String },

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
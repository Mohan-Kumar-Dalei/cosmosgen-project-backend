const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
    chat: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true },
    role: { type: String, enum: ["user", "model"], required: true },
}, { timestamps: true });

// Chat history hamesha (chat + user) se nikalti hai
messageSchema.index({ chat: 1, user: 1, createdAt: -1 });

/*
 * Six months, and then gone.
 *
 * Nothing reads a message older than the last handful. The assistant is given
 * the last eight turns of the conversation it is in - see HISTORY_LIMIT - and
 * for anything older it reads the customer's TICKETS instead, which are a
 * different collection and are not touched by this. So a customer who comes
 * back after a year is still recognised, still has their jobs quoted back to
 * them with amounts and invoice numbers; what is gone is the small talk.
 *
 * It is the largest thing that grows here - about half of everything a job
 * leaves behind - and the only one with no reader.
 */
messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const messageModel = mongoose.model('Message', messageSchema);
module.exports = messageModel;
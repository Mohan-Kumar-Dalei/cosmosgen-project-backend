const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
    chat: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true },
    role: { type: String, enum: ["user", "model"], required: true },
}, { timestamps: true });

// Chat history hamesha (chat + user) se nikalti hai
messageSchema.index({ chat: 1, user: 1, createdAt: -1 });

const messageModel = mongoose.model('Message', messageSchema);
module.exports = messageModel;
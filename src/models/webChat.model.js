const mongoose = require("mongoose");

/**
 * One conversation with the assistant on the website.
 *
 * Separate from the WhatsApp `Conversation`, which tracks where a phone number
 * is in the booking flow and is a permanent record of a customer. This is the
 * other kind of thing entirely: a browser tab talking to a model, often from
 * somebody who has no account at all, kept only so that a refresh or a second
 * visit does not throw the thread away.
 *
 * It clears itself out. Mongo's TTL monitor deletes a document the moment
 * `expiresAt` passes, and every message pushes that three days further out, so
 * a chat lives for three days after the last thing said in it and then costs
 * nothing. Without that, the busiest page on the site would quietly become the
 * largest collection in the database.
 */
const turnSchema = new mongoose.Schema({
    role: { type: String, enum: ["user", "model"], required: true },
    text: { type: String, required: true },
    at: { type: Date, default: Date.now },
}, { _id: false });

const webChatSchema = new mongoose.Schema({
    /**
     * The browser's own handle on the conversation.
     *
     * Random, kept in the tab's local storage, and the only thing needed to
     * read the thread back - which is the trade being made for letting a
     * visitor talk to the assistant without an account. Nothing sensitive is
     * ever in here: the assistant cannot book, cannot take a payment, and
     * reads a signed-in customer's jobs from the session rather than from
     * anything stored in this document.
     */
    chatId: { type: String, required: true, unique: true, index: true },

    /** Set when the person was signed in, so their own chats can be found. */
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },

    turns: { type: [turnSchema], default: [] },

    expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

module.exports = mongoose.model("WebChat", webChatSchema);

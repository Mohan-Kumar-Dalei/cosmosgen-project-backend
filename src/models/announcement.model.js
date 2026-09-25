const mongoose = require("mongoose");

/**
 * Something the office wants to say to every customer at once.
 *
 * Two shapes, one collection, because they differ only in where they surface:
 * a poster is a picture on the home screen that nobody has to acknowledge, and
 * a notice is an item in the bell with a push behind it. The festival that gets
 * a poster this week is the same festival that gets a notice on the day, and
 * making them two collections would mean the office writing it twice.
 *
 * Deliberately not a notification log. Job updates - assigned, on the way, paid
 * - are not in here: those belong to one customer, they already arrive as push
 * and live on the job itself. This is the office broadcasting, and the bell
 * shows only what the office actually sent.
 */
const announcementSchema = new mongoose.Schema({
    /*
     * Where it appears.
     *
     *   poster - the carousel above the area card on the home screen. Picture
     *            first; the title is an overlay, and most posters carry the
     *            whole message inside the artwork.
     *   notice - the bell beside the customer's avatar, and a push to every
     *            phone when the office presses Send.
     */
    placement: { type: String, enum: ["poster", "notice"], required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 80 },

    // The line under the title in the bell. A poster rarely needs one - the
    // artwork is the message - so it is not required.
    body: { type: String, trim: true, maxlength: 300, default: "" },

    /*
     * The artwork, as a link rather than a file.
     *
     * Mohan puts the pictures on ImageKit himself and pastes the URL, which is
     * how every other image in this system is managed. An upload box here would
     * be a second place for the same pictures to live and a second thing to
     * keep tidy.
     */
    imageUrl: { type: String, trim: true, default: "" },

    /*
     * Where a tap goes.
     *
     * A poster advertising a discount on air conditioning that opens nothing is
     * an advertisement the customer cannot act on, so the common case is a
     * service key and the booking flow for it.
     */
    action: {
        kind: { type: String, enum: ["none", "service", "url"], default: "none" },
        serviceKey: { type: String, default: null },
        url: { type: String, default: null },
    },

    // Lowest first, so the office decides what leads the carousel rather than
    // whichever poster happened to be typed in last.
    order: { type: Number, default: 0 },

    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },

    /*
     * When the push actually went out, and to how many phones.
     *
     * Kept because sending is the one irreversible thing on that screen. A
     * notice with no `pushedAt` is a draft sitting in the bell for anybody who
     * opens it; one with a date on it has been on thirty thousand lock screens
     * and cannot be taken back, which is exactly what the office needs to see
     * before pressing the button a second time.
     */
    pushedAt: { type: Date, default: null },
    pushedCount: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    createdByName: { type: String, default: "" },
}, { timestamps: true });

// What the app asks for on every home screen: the live ones, in the office's
// own order.
announcementSchema.index({ placement: 1, isActive: 1, order: 1, createdAt: -1 });

module.exports = mongoose.model("Announcement", announcementSchema);

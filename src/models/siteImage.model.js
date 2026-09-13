const mongoose = require("mongoose");

/**
 * One picture on the customer website, addressed by the slot it fills.
 *
 * The website's own drawings - the hero, the doorstep, the phone in a hand -
 * were URLs typed into a source file, which made changing one a developer's
 * job and a deploy. A service's picture already lived in the database; these
 * had no reason not to.
 *
 * Only overrides are stored. The website still ships a default for every slot,
 * so an empty collection is the site as drawn, and a row here is the office
 * having chosen something else.
 */
const siteImageSchema = new mongoose.Schema({
    // A name from the slot list in config/siteImages.js - not free text, or
    // the website ends up asking for pictures nobody has heard of
    slot: { type: String, required: true, unique: true, index: true },
    url: { type: String, required: true, trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
}, { timestamps: true });

module.exports = mongoose.model("SiteImage", siteImageSchema);

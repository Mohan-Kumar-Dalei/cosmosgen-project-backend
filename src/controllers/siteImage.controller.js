const SiteImage = require("../models/siteImage.model");
const ServiceModel = require("../models/service.model");
const catalog = require("../services/catalog.service");
const {
    SITE_IMAGES, SITE_IMAGE_BY_SLOT, SERVICE_IMAGE_DEFAULTS, APPLIANCE_IMAGE_DEFAULTS,
} = require("../config/siteImages");
const uploadImage = require("../utils/imagekit");

/**
 * The pictures the website shows, as a list the office can work through.
 *
 * Two kinds sit side by side here because to the person changing them they are
 * the same job: the site's own drawings, which live in their own small
 * collection, and the pictures belonging to a service or one of its
 * appliances, which live on the service. The screen does not make the office
 * learn that distinction - it asks for a slot or a service key and puts the
 * picture where it belongs.
 */

/** A file if they picked one, otherwise the URL they pasted. */
const urlFrom = async (req, name) => {
    if (req.file) {
        const result = await uploadImage(
            req.file.buffer,
            "site_" + String(name).toLowerCase() + "_" + Date.now(),
            "SiteImages"
        );
        return result.url;
    }

    const typed = String(req.body.url || req.body.image || "").trim();
    return typed;
};

/**
 * The same address, with the moment it was last saved on the end.
 *
 * Drawings are re-uploaded to ImageKit under the same file name all the time,
 * which leaves the address identical and every browser happily showing the
 * picture it already had. Stamping the save time onto the URL that gets
 * *displayed* makes each save a new address as far as a cache is concerned.
 * The stored URL is never touched - only what a screen is told to fetch - so
 * the link the office reads and copies stays exactly as they typed it.
 */
const stamp = (url, at) => {
    if (!url) return "";
    const when = new Date(at || Date.now()).getTime();
    return url + (url.includes("?") ? "&" : "?") + "v=" + when;
};

/** A picture has to be a web address we can put in an `img` tag. */
const looksLikeUrl = (value) => /^https?:\/\/\S+$/i.test(value);

/**
 * GET /api/admin/images
 *
 * Everything in one response: the site's slots with whatever overrides exist,
 * then every service and every appliance under it. The office sees the whole
 * set of pictures the customer ever sees, each with the address it loads from.
 */
const listImages = async (req, res) => {
    try {
        const [overrides, services] = await Promise.all([
            SiteImage.find().lean(),
            ServiceModel.find().sort({ order: 1, createdAt: 1 }).lean(),
        ]);

        const chosen = Object.fromEntries(overrides.map((row) => [row.slot, row]));

        const site = SITE_IMAGES.map((row) => {
            const saved = chosen[row.slot];
            const url = saved?.url || row.url;

            return {
                slot: row.slot,
                label: row.label,
                group: row.group,
                note: row.note,
                url,
                // What the thumbnail should actually fetch. Without this the
                // office saved a new drawing, the website showed it, and this
                // screen carried on showing the one the browser already had -
                // which reads as the save having failed.
                preview: saved ? stamp(url, saved.updatedAt) : url,
                fallback: row.url,
                // So the screen can show which ones the office has actually
                // changed, and offer to put a default back
                overridden: Boolean(saved),
            };
        });

        /*
         * The shipped drawing stands in where nothing has been chosen.
         *
         * Without this the panel showed an empty square for every service
         * while the website showed a picture - the website was falling back to
         * its own copy of these and the panel had no copy to fall back to.
         * `overridden` is what tells the two apart on screen.
         */
        const catalogue = services.map((service) => {
            const url = service.image || SERVICE_IMAGE_DEFAULTS[service.key] || "";

            return {
                key: service.key,
                label: service.label,
                url,
                preview: service.image ? stamp(url, service.updatedAt) : url,
                overridden: Boolean(service.image),
                isActive: service.isActive,
                appliances: (service.appliances || []).map((appliance) => {
                    const picture = appliance.image || APPLIANCE_IMAGE_DEFAULTS[appliance.key] || "";

                    return {
                        key: appliance.key,
                        label: appliance.label,
                        url: picture,
                        preview: appliance.image ? stamp(picture, service.updatedAt) : picture,
                        overridden: Boolean(appliance.image),
                    };
                }),
            };
        });

        return res.status(200).json({ success: true, data: { site, catalogue } });
    } catch (error) {
        console.error("List images error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/** PUT /api/admin/images/:slot - one of the site's own drawings. */
const saveSiteImage = async (req, res) => {
    try {
        const slot = String(req.params.slot || "").toUpperCase();

        if (!SITE_IMAGE_BY_SLOT[slot]) {
            return res.status(404).json({ success: false, message: "The website has no picture called that." });
        }

        const url = await urlFrom(req, slot);

        if (!url) {
            // An empty box means "put the drawing back", which is a delete
            await SiteImage.deleteOne({ slot });
            return res.status(200).json({
                success: true,
                data: { slot, url: SITE_IMAGE_BY_SLOT[slot].url, overridden: false },
                message: "Back to the original drawing.",
            });
        }

        if (!looksLikeUrl(url)) {
            return res.status(400).json({ success: false, message: "That does not look like a link. It should start with https://" });
        }

        await SiteImage.findOneAndUpdate(
            { slot },
            // The time is set explicitly rather than left to the schema, so
            // that saving the very same address again still counts as a change
            // - which is the whole point of being allowed to press Save twice
            { $set: { url, updatedBy: req.admin?._id, updatedAt: new Date() } },
            { upsert: true, new: true }
        );

        return res.status(200).json({
            success: true,
            data: { slot, url, overridden: true },
            message: "Picture saved.",
        });
    } catch (error) {
        console.error("Save site image error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * PUT /api/admin/images/appliance/:key/:appliance
 *
 * An appliance's picture is a field inside an array inside a service, which is
 * why it cannot go through the ordinary service update - that one replaces the
 * whole array, and sending the array back to change one picture is how the
 * rest of it gets lost.
 */
const saveApplianceImage = async (req, res) => {
    try {
        const key = String(req.params.key || "").toUpperCase();
        const applianceKey = String(req.params.appliance || "").toUpperCase();

        const url = await urlFrom(req, key + "_" + applianceKey);

        if (url && !looksLikeUrl(url)) {
            return res.status(400).json({ success: false, message: "That does not look like a link. It should start with https://" });
        }

        const service = await ServiceModel.findOneAndUpdate(
            { key, "appliances.key": applianceKey },
            { $set: { "appliances.$.image": url, updatedBy: req.admin?._id } },
            { new: true }
        );

        if (!service) {
            return res.status(404).json({ success: false, message: "No such appliance." });
        }

        await catalog.refresh();

        return res.status(200).json({ success: true, data: { key, applianceKey, url }, message: "Picture saved." });
    } catch (error) {
        console.error("Save appliance image error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * GET /api/customer/images
 *
 * What the website asks for on load: only the slots that have been changed,
 * because it already holds the defaults. A failure here is not worth an error
 * - the site simply keeps its own drawings.
 */
const publicImages = async (req, res) => {
    try {
        const overrides = await SiteImage.find().lean();

        return res.status(200).json({
            success: true,
            data: Object.fromEntries(
                overrides
                    .filter((row) => SITE_IMAGE_BY_SLOT[row.slot])
                    .map((row) => [row.slot, stamp(row.url, row.updatedAt || row.createdAt)])
            ),
        });
    } catch (error) {
        console.error("Public images error:", error.message);
        return res.status(200).json({ success: true, data: {} });
    }
};

module.exports = { listImages, saveSiteImage, saveApplianceImage, publicImages };

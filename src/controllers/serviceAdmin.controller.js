const ServiceModel = require("../models/service.model");
const Ticket = require("../models/ticket.model");
const ServicePricing = require("../models/servicePricing.model");
const catalog = require("../services/catalog.service");
const author = require("../services/serviceAuthor.service");
const booking = require("../services/booking.service");
const uploadImage = require("../utils/imagekit");

/**
 * The office's own control over what the company sells.
 *
 * Every write here ends with a reload of the in-memory catalogue, because that
 * array is what the WhatsApp menu, the assistant's prompt and the engineer
 * matching all read. A service saved but not reloaded would appear on the
 * website and be unbookable anywhere else, which is worse than not appearing
 * at all.
 */

/**
 * The picture, which is the one thing the office supplies by hand.
 *
 * A file if they picked one, otherwise whatever URL was typed, otherwise
 * nothing - and nothing is survivable, because the website falls back to a
 * tinted panel rather than a broken image.
 */
const pictureFrom = async (req, key) => {
    if (req.file) {
        const result = await uploadImage(req.file.buffer, "service_" + key.toLowerCase() + "_" + Date.now(), "ServiceImages");
        return result.url;
    }
    return req.body.image !== undefined ? String(req.body.image).trim() : undefined;
};

/**
 * Multipart sends everything as text.
 *
 * The picture has to travel with the service, so the form is multipart - and
 * that turns the issue list, the appliances, the badges and the keywords into
 * JSON strings on the way. They are put back here rather than at each use, so
 * nothing downstream has to know how the request happened to be encoded.
 */
const LISTS = ["issues", "appliances", "badges", "keywords"];

const unpack = (body) => {
    const out = { ...body };

    LISTS.forEach((field) => {
        if (typeof out[field] !== "string") return;
        try {
            const parsed = JSON.parse(out[field]);
            out[field] = Array.isArray(parsed) ? parsed : [];
        } catch {
            out[field] = [];
        }
    });

    if (typeof out.isActive === "string") out.isActive = out.isActive === "true";
    if (typeof out.order === "string") out.order = Number(out.order) || 0;

    return out;
};

/** GET /api/admin/services */
const listServices = async (req, res) => {
    try {
        const services = await ServiceModel.find()
            .sort({ order: 1, createdAt: 1 })
            .lean();

        /*
         * A thumbnail the browser will actually refetch.
         *
         * A drawing re-uploaded to ImageKit under the same name leaves the
         * address identical, so this screen would go on showing the picture it
         * already had while the website showed the new one - which reads as the
         * save having done nothing. The preview carries the moment the service
         * was last touched; the image field stays exactly as it is stored,
         * because that is what the office reads and copies.
         */
        const withPreview = services.map((service) => ({
            ...service,
            preview: service.image
                ? service.image + (service.image.includes("?") ? "&" : "?")
                    + "v=" + new Date(service.updatedAt || service.createdAt || Date.now()).getTime()
                : "",
        }));

        return res.status(200).json({ success: true, data: withPreview });
    } catch (error) {
        console.error("List services error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/admin/services/draft
 *
 * Writes the entry but saves nothing. The office sees what the assistant came
 * up with, corrects the name or the wording if it read the trade wrongly, and
 * only then saves - because the first customer to be shown an invented fault
 * is a customer who stops believing the rest of the list.
 */
const draftService = async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();

        if (name.length < 3) {
            return res.status(400).json({ success: false, message: "Give the service a name first." });
        }

        const existing = await ServiceModel.findOne({ label: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }).lean();
        if (existing) {
            return res.status(409).json({
                success: false,
                message: "\"" + existing.label + "\" is already on the list.",
            });
        }

        const drafted = await author.draft(name, String(req.body.note || "").trim());

        // A clash on the key rather than the name - two different names can
        // still reduce to the same handle
        const taken = await ServiceModel.findOne({ key: drafted.key }).lean();
        if (taken) drafted.key = drafted.key + "_2";

        return res.status(200).json({ success: true, data: drafted });
    } catch (error) {
        console.error("Draft service error:", error.message);
        return res.status(502).json({
            success: false,
            message: "Could not draft that one. Try a plainer name, or write the details yourself.",
        });
    }
};

/** POST /api/admin/services */
const createService = async (req, res) => {
    try {
        const body = unpack(req.body || {});
        const key = String(body.key || "").toUpperCase().replace(/[^A-Z0-9_]/g, "_").trim();

        if (!key || !String(body.label || "").trim()) {
            return res.status(400).json({ success: false, message: "A key and a label are required." });
        }

        if (!Array.isArray(body.issues) || body.issues.length === 0) {
            if (!Array.isArray(body.appliances) || body.appliances.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "A service needs either a list of jobs or a list of appliances.",
                });
            }
        }

        if (await ServiceModel.exists({ key })) {
            return res.status(409).json({ success: false, message: "That key is already in use." });
        }

        const last = await ServiceModel.findOne().sort({ order: -1 }).select("order").lean();
        const image = await pictureFrom(req, key);

        const service = await ServiceModel.create({
            ...body,
            image: image || "",
            key,
            source: "admin",
            order: (last?.order ?? 0) + 10,
            createdBy: req.admin?._id,
            updatedBy: req.admin?._id,
        });

        await catalog.refresh();

        return res.status(201).json({ success: true, data: service, message: service.label + " is live." });
    } catch (error) {
        console.error("Create service error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * PUT /api/admin/services/:key
 *
 * The picture is the field the office changes most often, and the only one
 * they are expected to fill in themselves, so it is the one thing that can be
 * sent on its own.
 */
const updateService = async (req, res) => {
    try {
        const allowed = [
            "label", "labelHinglish", "labelOdenglish", "worker", "keywords",
            "image", "blurb", "badges", "appliances", "issues", "order", "isActive",
        ];

        const body = unpack(req.body || {});
        const patch = {};
        allowed.forEach((field) => {
            if (body[field] !== undefined) patch[field] = body[field];
        });

        const image = await pictureFrom(req, String(req.params.key));
        if (image !== undefined) patch.image = image;

        if (!Object.keys(patch).length) {
            return res.status(400).json({ success: false, message: "Nothing to change." });
        }

        patch.updatedBy = req.admin?._id;

        const service = await ServiceModel.findOneAndUpdate(
            { key: String(req.params.key).toUpperCase() },
            { $set: patch },
            { new: true }
        );

        if (!service) {
            return res.status(404).json({ success: false, message: "No such service." });
        }

        await catalog.refresh();

        return res.status(200).json({ success: true, data: service, message: "Saved." });
    } catch (error) {
        console.error("Update service error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * DELETE /api/admin/services/:key
 *
 * Deleted means deleted. The first version of this only flipped `isActive`,
 * which meant the office pressed a bin, read "removed", and found the row still
 * sitting there - so the row goes, and its price list goes with it, or a key
 * added again a year later would quietly inherit last year's prices.
 *
 * Old jobs are not the reason to keep it. A ticket stores the service's label
 * as well as its key, so a closed job from March still reads correctly with
 * nothing in this collection behind it. A job still *running* is a different
 * matter and blocks the delete outright: the customer is waiting for something
 * the company would no longer admit to doing.
 *
 * Hiding is still there, and it is the other button - `isActive` on the update
 * route takes a service off the website without losing it.
 */
const removeService = async (req, res) => {
    try {
        const key = String(req.params.key).toUpperCase();

        const open = await Ticket.countDocuments({
            serviceKey: key,
            status: { $in: booking.OPEN_STATUSES },
        });

        if (open > 0) {
            return res.status(409).json({
                success: false,
                message: open + " job" + (open === 1 ? " is" : "s are") + " still running on this service. Close them first.",
            });
        }

        const service = await ServiceModel.findOne({ key });

        if (!service) {
            return res.status(404).json({ success: false, message: "No such service." });
        }

        // Only the live ones count. Two hidden services and one live one still
        // leaves a company with nothing to sell the moment that last one goes.
        const active = await ServiceModel.countDocuments({ isActive: true });
        if (service.isActive && active <= 1) {
            return res.status(409).json({
                success: false,
                message: "This is the only service left. The company has to sell something.",
            });
        }

        await ServiceModel.deleteOne({ _id: service._id });
        await ServicePricing.deleteOne({ serviceKey: key });

        await catalog.refresh();

        return res.status(200).json({
            success: true,
            message: service.label + " is deleted. Past jobs keep their own record of it.",
        });
    } catch (error) {
        console.error("Remove service error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

module.exports = { listServices, draftService, createService, updateService, removeService };

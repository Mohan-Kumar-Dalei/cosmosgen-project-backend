const Announcement = require("../models/announcement.model");
const push = require("../services/push.service");
const { SERVICE_CATALOG } = require("../config/services");

/**
 * The office's own broadcasts: the posters on the app's home screen and the
 * notices behind the bell.
 *
 * One screen edits both because to whoever is writing them they are one job -
 * the same Diwali week gets a poster on the first day and a notice on the last.
 * What separates them is only where they surface, and that is a field.
 *
 * Sending is deliberately a separate action from saving. A notice is written,
 * read back, corrected, and only then pushed; a screen where typing a title and
 * pressing Save puts it on thirty thousand lock screens is a screen nobody
 * should have to be careful in front of.
 */

const KINDS = ["poster", "notice"];

/** Everything the app is allowed to see about one row, and nothing else. */
const shape = (row) => ({
    id: String(row._id),
    placement: row.placement,
    title: row.title,
    body: row.body || "",
    imageUrl: row.imageUrl || "",
    action: {
        kind: row.action?.kind || "none",
        serviceKey: row.action?.serviceKey || null,
        url: row.action?.url || null,
    },
    order: row.order || 0,
    startsAt: row.startsAt || null,
    endsAt: row.endsAt || null,
    isActive: row.isActive !== false,
    pushedAt: row.pushedAt || null,
    pushedCount: row.pushedCount || 0,
    createdByName: row.createdByName || "",
    createdAt: row.createdAt,
});

/**
 * What the office typed, cleaned up into what the schema will take.
 *
 * A service key that is not in the catalogue becomes no action at all rather
 * than an error: the alternative is a poster the office cannot save because a
 * trade was renamed last month, and a poster that opens the home screen is
 * better than a poster that does not exist.
 */
const readBody = (body = {}) => {
    const kind = ["none", "service", "url"].includes(body?.action?.kind)
        ? body.action.kind
        : "none";

    const serviceKey = String(body?.action?.serviceKey || "").trim();
    const known = SERVICE_CATALOG.some((s) => s.key === serviceKey);

    const url = String(body?.action?.url || "").trim();

    return {
        title: String(body.title || "").trim().slice(0, 80),
        body: String(body.body || "").trim().slice(0, 300),
        imageUrl: String(body.imageUrl || "").trim(),

        action: {
            kind: (kind === "service" && !known) || (kind === "url" && !/^https?:\/\//i.test(url))
                ? "none"
                : kind,
            serviceKey: kind === "service" && known ? serviceKey : null,
            url: kind === "url" && /^https?:\/\//i.test(url) ? url : null,
        },

        order: Number.isFinite(Number(body.order)) ? Number(body.order) : 0,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        isActive: body.isActive !== false,
    };
};

/** GET /api/admin/announcements - everything, live or not, newest first. */
const list = async (_req, res) => {
    try {
        const rows = await Announcement.find({}).sort({ placement: 1, order: 1, createdAt: -1 }).lean();
        return res.status(200).json({ success: true, data: rows.map(shape) });
    } catch (error) {
        console.error("Announcement list error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/** POST /api/admin/announcements */
const create = async (req, res) => {
    try {
        const placement = KINDS.includes(req.body?.placement) ? req.body.placement : null;
        if (!placement) {
            return res.status(400).json({ success: false, message: "Say whether this is a poster or a notice." });
        }

        const fields = readBody(req.body);

        if (!fields.title) {
            return res.status(400).json({ success: false, message: "Give it a title." });
        }

        // A poster with no picture is an empty card in a carousel. A notice can
        // live without one - the bell shows the words - so only the poster is
        // held to it.
        if (placement === "poster" && !fields.imageUrl) {
            return res.status(400).json({ success: false, message: "A poster needs a picture. Paste its ImageKit link." });
        }

        const row = await Announcement.create({
            ...fields,
            placement,
            createdBy: req.admin?._id,
            createdByName: req.admin?.name || "",
        });

        return res.status(201).json({ success: true, data: shape(row.toObject()) });
    } catch (error) {
        console.error("Announcement create error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * PUT /api/admin/announcements/:id
 *
 * The placement is not editable. A notice that has been pushed and is then
 * turned into a poster leaves a send record attached to something that was
 * never sent, and the office reading that screen later has no way to tell.
 * Delete it and write the poster.
 */
const update = async (req, res) => {
    try {
        const fields = readBody(req.body);

        if (!fields.title) {
            return res.status(400).json({ success: false, message: "Give it a title." });
        }

        const row = await Announcement.findByIdAndUpdate(
            req.params.id,
            fields,
            { new: true, runValidators: true }
        ).lean();

        if (!row) return res.status(404).json({ success: false, message: "It is not there any more." });

        return res.status(200).json({ success: true, data: shape(row) });
    } catch (error) {
        console.error("Announcement update error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/** DELETE /api/admin/announcements/:id */
const remove = async (req, res) => {
    try {
        const row = await Announcement.findByIdAndDelete(req.params.id).lean();
        if (!row) return res.status(404).json({ success: false, message: "It is not there any more." });

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Announcement delete error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/admin/announcements/:id/push
 *
 * Puts a notice on every customer's phone.
 *
 * The one irreversible button in this part of the panel, so it is its own route
 * rather than a flag on Save, and it answers the office immediately rather than
 * holding the request open while three hundred batches go out. The count on the
 * row is filled in when the send finishes.
 *
 * Posters cannot be pushed. A poster is something a customer comes across; a
 * notice is something that interrupts them, and the difference is the whole
 * reason there are two kinds.
 */
const send = async (req, res) => {
    try {
        const row = await Announcement.findById(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: "It is not there any more." });

        if (row.placement !== "notice") {
            return res.status(400).json({
                success: false,
                message: "Only a notice is pushed. A poster is seen on the home screen.",
            });
        }

        // Stamped before the sending starts, so the notice appears in the bell
        // for anybody who opens the app while the batches are still going out.
        row.pushedAt = new Date();
        await row.save();

        push.sendToAllCustomers({
            title: row.title,
            body: row.body || "",
            data: { kind: "notice", id: String(row._id) },
        })
            .then((count) => Announcement.updateOne({ _id: row._id }, { pushedCount: count }))
            .catch((err) => console.error("[PUSH] broadcast failed: " + err.message));

        return res.status(200).json({
            success: true,
            message: "Sending. It is in the bell already and the phones follow.",
            data: shape(row.toObject()),
        });
    } catch (error) {
        console.error("Announcement push error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

module.exports = { list, create, update, remove, send };

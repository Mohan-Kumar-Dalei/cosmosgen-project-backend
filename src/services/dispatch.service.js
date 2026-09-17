const ticketModel = require("../models/ticket.model");
const technicianModel = require("../models/technician.model");
const notification = require("./notification.service");

/**
 * Called when a technician finishes a job. Pulls in their next job if one
 * is actually due today.
 *
 * A ticket scheduled for next week must NOT jump in just because it was
 * queued first - the technician needs to stay free for whatever the office
 * assigns them right now.
 */
const promoteQueuedTicket = async (technicianId) => {
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const dueNow = await ticketModel
        .findOne({
            technician: technicianId,
            status: "Queued",
            $or: [
                // Nothing scheduled - queued right behind the current job
                { "scheduling.scheduledFor": { $exists: false } },
                { "scheduling.scheduledFor": null },
                // Or scheduled for today (or overdue)
                { "scheduling.scheduledFor": { $lte: endOfToday } },
            ],
        })
        // Dated work first, then whatever was queued earliest
        .sort({ "scheduling.scheduledFor": 1, queuedAt: 1 })
        .lean();

    if (!dueNow) {
        // Future-dated jobs stay queued. The technician goes free so the
        // office can hand them something for today.
        await technicianModel.updateOne(
            { _id: technicianId },
            { isAvailable: true, activeTicket: null }
        );
        return null;
    }

    const promoted = await ticketModel.findByIdAndUpdate(
        dueNow._id,
        {
            status: "Assigned",
            assignedAt: new Date(),
            $push: {
                statusHistory: {
                    from: "Queued",
                    to: "Assigned",
                    actorRole: "system",
                    reason: "Started automatically after the previous job closed",
                    at: new Date(),
                },
            },
        },
        { returnDocument: "after" }
    ).lean();

    await technicianModel.updateOne(
        { _id: technicianId },
        { isAvailable: false, activeTicket: promoted._id }
    );

    // The customer hears when the technician accepts, not when the queue
    // moves - he may still hand this one back.
    notification.notifyTechnicianAssigned(promoted);

    return promoted;
};

/**
 * Runs on a schedule so tomorrow's work becomes today's work on its own.
 * Without this, a job scheduled for Tuesday sits in Queued forever unless
 * the technician happens to close another job that same day.
 */
const promoteDueScheduledTickets = async () => {
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    // Only technicians who are free right now
    const freeTechnicians = await technicianModel
        .find({ activeTicket: null, isDeleted: false, isBlacklisted: false, approvalStatus: "approved" })
        .select("_id")
        .lean();

    let promotedCount = 0;

    for (const tech of freeTechnicians) {
        const due = await ticketModel
            .findOne({
                technician: tech._id,
                status: "Queued",
                "scheduling.scheduledFor": { $lte: endOfToday },
            })
            .sort({ "scheduling.scheduledFor": 1 })
            .lean();

        if (!due) continue;

        // Filter on activeTicket again so two runs can't double-assign
        const locked = await technicianModel.findOneAndUpdate(
            { _id: tech._id, activeTicket: null },
            { isAvailable: false, activeTicket: due._id },
            { returnDocument: "after" }
        ).lean();

        if (!locked) continue;

        const promoted = await ticketModel.findByIdAndUpdate(
            due._id,
            {
                status: "Assigned",
                assignedAt: new Date(),
                $push: {
                    statusHistory: {
                        from: "Queued",
                        to: "Assigned",
                        actorRole: "system",
                        reason: "Scheduled date reached",
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

    notification.notifyTechnicianAssigned(promoted);
    // The technician is on the road when this fires - their panel is closed,
    // so WhatsApp is the only channel that reaches them
    await notification.notifyTechnicianAssignedOnWhatsApp(promoted);
        promotedCount += 1;
    }

    if (promotedCount > 0) {
        console.log("Promoted " + promotedCount + " scheduled ticket(s) to active");
    }
    return promotedCount;
};

/**
 * Give a technician's queued jobs back to the office.
 *
 * Used when he stops being able to work at all - today, that is a vendor
 * paused for turning too many jobs down. The jobs themselves are fine; it is
 * only the person they were parked behind who is not, and a customer should
 * not wait until tomorrow to find that out.
 *
 * Only Queued ones. A job he is standing in front of is his to finish.
 */
const releaseQueueOf = async (technicianId, reason) => {
    const queued = await ticketModel
        .find({ technician: technicianId, status: "Queued" })
        .select("_id status")
        .lean();

    if (!queued.length) return [];

    const at = new Date();

    await ticketModel.updateMany(
        { _id: { $in: queued.map((t) => t._id) } },
        {
            status: "Pending",
            technician: null,
            technicianSnapshot: {},
            assignedBy: null,
            assignedAt: null,
            acceptedAt: null,
            queuedAt: null,
            $push: {
                statusHistory: {
                    from: "Queued",
                    to: "Pending",
                    actorRole: "system",
                    reason,
                    at,
                },
            },
        }
    );

    return queued.map((t) => t._id);
};

module.exports = { promoteQueuedTicket, promoteDueScheduledTickets, releaseQueueOf };
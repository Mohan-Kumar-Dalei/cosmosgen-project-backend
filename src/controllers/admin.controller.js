const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const adminModel = require("../models/admin.model");
const ticketModel = require("../models/ticket.model");
const technicianModel = require("../models/technician.model");
const Payment = require("../models/payment.model");
const ServicePricing = require("../models/servicePricing.model");
const { buildSkillRegex } = require("../config/services");
const { SERVICE_CATALOG } = require("../config/services");
const notification = require("../services/notification.service");
const { paiseToRupees } = require("../services/payment.service");
const { promoteQueuedTicket } = require("../services/dispatch.service");
const walletService = require("../services/wallet.service");

const isProd = process.env.NODE_ENV === "production";

const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 12 * 60 * 60 * 1000,
    path: "/",
};

const clearOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
};

// const ACTIVE_STATUSES = ["Queued", "Assigned", "In-Progress", "Payment-Pending"];

/* ================= AUTH ================= */

const registerAdmin = async (req, res) => {
    try {
        const { name, email, password, role, secret } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ success: false, message: "Name, email and password are required" });
        }
        if (String(password).length < 6) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
        }

        const wantsOwner = role === "superadmin";

        if (wantsOwner && secret !== process.env.ADMIN_REGISTRATION_SECRET) {
            return res.status(403).json({ success: false, message: "Invalid security key" });
        }

        const cleanEmail = String(email).toLowerCase().trim();
        const exists = await adminModel.findOne({ email: cleanEmail }).select("_id").lean();
        if (exists) {
            return res.status(400).json({ success: false, message: "This email is already registered" });
        }

        const admin = await adminModel.create({
            name: String(name).trim(),
            email: cleanEmail,
            password: await bcrypt.hash(password, 10),
            role: wantsOwner ? "superadmin" : "backoffice",
        });

        return res.status(201).json({
            success: true,
            message: "Account created",
            data: { _id: admin._id, name: admin.name, email: admin.email, role: admin.role },
        });
    } catch (error) {
        console.error("Admin register error:", error);
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: "This email is already registered" });
        }
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};


const loginAdmin = async (req, res) => {
    try {
        const { email, password, secret, portal } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: "Email and password are required" });
        }

        const expectedRole = portal === "owner" ? "superadmin" : "backoffice";

        const admin = await adminModel
            .findOne({ email: String(email).toLowerCase().trim() })
            .select("+password");

        if (!admin || !admin.isActive || admin.role !== expectedRole) {
            return res.status(401).json({ success: false, message: "Invalid email or password" });
        }

        const isValid = await bcrypt.compare(password, admin.password);
        if (!isValid) {
            return res.status(401).json({ success: false, message: "Invalid email or password" });
        }

        // Owners carry a second factor - they manage staff and see the money
        if (expectedRole === "superadmin" && secret !== process.env.ADMIN_REGISTRATION_SECRET) {
            return res.status(401).json({ success: false, message: "Invalid security key" });
        }

        await adminModel.updateOne({ _id: admin._id }, { lastLoginAt: new Date() });

        const token = jwt.sign(
            { adminId: admin._id, role: admin.role },
            process.env.ADMIN_JWT_SECRET,
            { expiresIn: "12h" }
        );
        res.cookie("adminToken", token, cookieOptions);

        return res.status(200).json({
            success: true,
            message: "Login successful",
            data: { _id: admin._id, name: admin.name, email: admin.email, role: admin.role },
        });
    } catch (error) {
        console.error("Admin login error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const logoutAdmin = (req, res) => {
    res.clearCookie("adminToken", clearOptions);
    return res.status(200).json({ success: true, message: "Logged out successfully" });
};

const getAdminProfile = async (req, res) => {
    return res.status(200).json({ success: true, data: req.admin });
};

/* ================= DASHBOARD ================= */

const getDashboardStats = async (req, res) => {
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const [ticketStats, techStats, todayCount, awaitingReconcile, rejectedCount, cashHeld, awaitingPayment] =
            await Promise.all([
                ticketModel.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),

                technicianModel.aggregate([
                    { $match: { isDeleted: false } },
                    {
                        $group: {
                            _id: null,
                            total: { $sum: 1 },
                            available: { $sum: { $cond: [{ $eq: ["$isAvailable", true] }, 1, 0] } },
                            onJob: { $sum: { $cond: [{ $ne: ["$activeTicket", null] }, 1, 0] } },
                        },
                    },
                ]),

                ticketModel.countDocuments({ createdAt: { $gte: startOfDay } }),

                // Online payments that reached the company account but haven't
                // been matched against the bank statement yet. Cash is excluded
                // on purpose - it never entered the account, so there is
                // nothing to reconcile.
                Payment.aggregate([
                    { $match: { status: "collected", method: { $ne: "cash" } } },
                    { $group: { _id: null, count: { $sum: 1 }, totalPaise: { $sum: "$amountPaise" } } },
                ]),

                // Pending tickets that came back from a technician - these need
                // a decision, not just an assignment
                ticketModel.countDocuments({ status: "Pending", "rejection.reason": { $exists: true } }),

                // Cash sitting with technicians. This is the number that
                // actually needs chasing, and it's settled in Wallets.
                Payment.aggregate([
                    { $match: { status: "collected", method: "cash" } },
                    { $group: { _id: null, count: { $sum: 1 }, totalPaise: { $sum: "$amountPaise" } } },
                ]),

                // Payments that are completely unpaid yet (awaiting payment)
                Payment.aggregate([
                    { $match: { status: "pending" } },
                    { $group: { _id: null, count: { $sum: 1 }, totalPaise: { $sum: "$amountPaise" } } },
                ]),
            ]);

        const byStatus = {};
        ticketStats.forEach((s) => { byStatus[s._id] = s.count; });

        return res.status(200).json({
            success: true,
            data: {
                tickets: {
                    pending: byStatus.Pending || 0,
                    rejected: rejectedCount,
                    scheduled: byStatus.Queued || 0,
                    assigned: byStatus.Assigned || 0,
                    inProgress: byStatus["In-Progress"] || 0,
                    paymentPending: byStatus["Payment-Pending"] || 0,
                    closed: byStatus.Closed || 0,
                    cancelled: byStatus.Cancelled || 0,
                    today: todayCount,
                },

                technicians: techStats[0] || { total: 0, available: 0, onJob: 0 },

                awaitingReconcile: {
                    count: awaitingReconcile[0]?.count || 0,
                    amountDisplay: paiseToRupees(awaitingReconcile[0]?.totalPaise || 0),
                },

                awaitingPayment: {
                    count: awaitingPayment[0]?.count || 0,
                    amountDisplay: paiseToRupees(awaitingPayment[0]?.totalPaise || 0),
                },

                cashWithTechnicians: {
                    count: cashHeld[0]?.count || 0,
                    amountDisplay: paiseToRupees(cashHeld[0]?.totalPaise || 0),
                },

                // Kept so the sidebar badge doesn't break while the panels
                // move over to awaitingReconcile
                unverifiedCash: {
                    count: awaitingReconcile[0]?.count || 0,
                    amountDisplay: paiseToRupees(awaitingReconcile[0]?.totalPaise || 0),
                },
            },
        });
    } catch (error) {
        console.error("Dashboard stats error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/* ================= TICKETS ================= */

const getTickets = async (req, res) => {
    try {
        const status = req.query.status || "Pending";
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(50, Number(req.query.limit) || 20);

        let filter = {};
        if (status === "active") {
            filter = { status: { $in: ["Assigned", "In-Progress", "Payment-Pending"] } };
        } else if (status === "scheduled") {
            // Booked for a future date, technician already on it
            filter = { status: "Queued", "scheduling.scheduledFor": { $ne: null } };
        } else if (status === "queued") {
            // Waiting behind a technician's current job, no date set
            filter = { status: "Queued", "scheduling.scheduledFor": { $in: [null, undefined] } };
        } else if (status !== "all") {
            filter = { status };
        }

        const [tickets, total] = await Promise.all([
            ticketModel
                .find(filter)
                .select("ticketNumber channel serviceLabel serviceKey selectedIssues problemDescription customerSnapshot status technicianSnapshot scheduling rejection billing.totalPaise payment.status createdAt assignedAt queuedAt")
                .sort(status === "scheduled" ? { "scheduling.scheduledFor": 1 } : { createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            ticketModel.countDocuments(filter),
        ]);

        return res.status(200).json({
            success: true,
            data: tickets,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error("Get tickets error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const getTicketById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid ticket id" });
        }

        const ticket = await ticketModel.findById(id).populate("assignedBy", "name email").lean();
        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found" });
        }

        const lat = ticket.customerSnapshot?.lat;
        const lon = ticket.customerSnapshot?.lon;

        return res.status(200).json({
            success: true,
            data: {
                ...ticket,
                mapsUrl: notification.buildPinUrl(lat, lon),
                totalDisplay: ticket.billing?.totalPaise ? paiseToRupees(ticket.billing.totalPaise) : null,
            },
        });
    } catch (error) {
        console.error("Get ticket error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * GET /api/admin/tickets/:id/nearby-technicians?radius=15000
 * Returns busy technicians too - the admin can queue behind them.
 */
const getNearbyTechnicians = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid ticket id" });
        }

        const ticket = await ticketModel.findById(id).select("serviceKey customerSnapshot").lean();
        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found" });
        }

        const lat = Number(ticket.customerSnapshot?.lat);
        const lon = Number(ticket.customerSnapshot?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return res.status(400).json({
                success: false,
                message: "Customer location missing on this ticket. Cannot search nearby technicians.",
            });
        }

        const radius = Math.min(100000, Math.max(1000, Number(req.query.radius) || 15000));
        const skillRegex = buildSkillRegex(ticket.serviceKey);

        // Busy technicians are included so the admin can queue behind them.
        // Offline and deleted ones stay out.
        const matchQuery = { isDeleted: false };
        if (skillRegex) matchQuery.skills = { $regex: skillRegex };

        const technicians = await technicianModel.aggregate([
            {
                $geoNear: {
                    near: { type: "Point", coordinates: [lon, lat] },
                    distanceField: "distanceInMeters",
                    maxDistance: radius,
                    query: matchQuery,
                    spherical: true,
                },
            },
            { $limit: 20 },
            {
                $project: {
                    name: 1, phone: 1, profileImage: 1, skills: 1, rating: 1,
                    completedJobs: 1, performanceLevel: 1, area: 1, state: 1,
                    hasVehicle: 1, lastLocationAt: 1, isAvailable: 1, activeTicket: 1,
                    distanceInMeters: { $round: ["$distanceInMeters", 0] },
                    distanceKm: { $round: [{ $divide: ["$distanceInMeters", 1000] }, 2] },
                },
            },
        ]);

        // How many queued jobs each busy technician already has
        const techIds = technicians.map((t) => t._id);
        const queueCounts = techIds.length
            ? await ticketModel.aggregate([
                { $match: { technician: { $in: techIds }, status: "Queued" } },
                { $group: { _id: "$technician", count: { $sum: 1 } } },
            ])
            : [];
        const queueMap = new Map(queueCounts.map((q) => [String(q._id), q.count]));

        const withStatus = technicians.map((t) => ({
            ...t,
            liveStatus: t.activeTicket ? "on_job" : t.isAvailable ? "available" : "offline",
            scheduledJobs: queueMap.get(String(t._id)) || 0,
        }));

        const noLocationCount = await technicianModel.countDocuments({
            isDeleted: false,
            ...(skillRegex ? { skills: { $regex: skillRegex } } : {}),
            "location.coordinates": { $exists: false },
        });

        return res.status(200).json({
            success: true,
            data: withStatus,
            meta: {
                searchedRadiusKm: radius / 1000,
                found: withStatus.length,
                availableNow: withStatus.filter((t) => t.liveStatus === "available").length,
                noLocationSet: noLocationCount,
                customerLocation: { lat, lon },
            },
        });
    } catch (error) {
        console.error("Nearby technicians error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/admin/tickets/:id/assign
 * body: { technicianId, distanceInMeters, allowQueue }
 *
 * Free technician -> Assigned. Busy technician + allowQueue -> Queued,
 * promoted automatically when their current job closes.
 */
const assignTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { technicianId, distanceInMeters, allowQueue } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(technicianId)) {
            return res.status(400).json({ success: false, message: "Invalid ticket or technician id" });
        }

        const tech = await technicianModel
            .findOne({ _id: technicianId, isDeleted: false })
            .select("name phone profileImage rating isAvailable activeTicket")
            .lean();



        if (!tech) {
            return res.status(404).json({ success: false, message: "Technician not found" });
        }

        // 👇 NAYA WALLET LOCK CODE 👇
        if (tech.walletBalancePaise <= -100000) {
            return res.status(403).json({
                success: false,
                message: `Cannot assign! ${tech.name}'s wallet balance is in negative (limit reached). They need to clear dues first.`
            });
        }
        // 👆 NAYA WALLET LOCK CODE END 👆

        const isBusy = Boolean(tech.activeTicket);

        if (isBusy && !allowQueue) {
            return res.status(409).json({
                success: false,
                message: "This technician is on another job. Queue it instead?",
                canQueue: true,
            });
        }

        const targetStatus = isBusy ? "Queued" : "Assigned";

        if (!isBusy) {
            const locked = await technicianModel.findOneAndUpdate(
                { _id: technicianId, activeTicket: null, isDeleted: false },
                { isAvailable: false, activeTicket: id },
                { returnDocument: "after" }
            ).lean();

            if (!locked) {
                return res.status(409).json({
                    success: false,
                    message: "This technician was just assigned to another job. Refresh and try again.",
                });
            }
        }

        const ticket = await ticketModel.findOneAndUpdate(
            { _id: id, status: "Pending" },
            {
                status: targetStatus,
                technician: technicianId,
                technicianSnapshot: {
                    name: tech.name,
                    phone: tech.phone,
                    profileImage: tech.profileImage,
                    rating: tech.rating,
                },
                assignedBy: req.admin._id,
                assignedAt: isBusy ? null : new Date(),
                queuedAt: isBusy ? new Date() : null,
                distanceAtAssignment: Number(distanceInMeters) || undefined,
                $push: {
                    statusHistory: {
                        from: "Pending",
                        to: targetStatus,
                        actorRole: "admin",
                        actorId: req.admin._id,
                        reason: isBusy ? "Queued behind the technician's current job" : undefined,
                        at: new Date(),
                    },
                },
                rejection: null,
            },
            { new: true }
        ).lean();

        if (!ticket) {
            if (!isBusy) {
                await technicianModel.updateOne(
                    { _id: technicianId },
                    { isAvailable: true, activeTicket: null }
                );
            }
            return res.status(409).json({ success: false, message: "This ticket was already assigned by someone else." });
        }

        notification.notifyAdminsTicketTaken(ticket._id, req.admin.name);

        if (!isBusy) {
            notification.notifyTechnicianAssigned(ticket);
            await notification.notifyTechnicianAssignedOnWhatsApp(ticket);
            await notification.notifyCustomerAssigned(ticket);
        } else {
            notification.notifyTechnicianQueued(ticket);
            await notification.notifyCustomer({
                ticket,
                text:
                    "Your request " + ticket.ticketNumber + " has been assigned to " + tech.name + ".\n\n" +
                    "They're finishing another job right now and will reach you soon. " +
                    "We'll message you as soon as they're on the way.",
            });
        }

        return res.status(200).json({
            success: true,
            message: isBusy
                ? `Queued for ${tech.name} - starts after their current job`
                : `Ticket assigned to ${tech.name}`,
            data: ticket,
        });
    } catch (error) {
        console.error("Assign ticket error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const unassignTicket = async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || String(reason).trim().length < 3) {
            return res.status(400).json({ success: false, message: "A reason is required" });
        }

        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            status: { $in: ["Queued", "Assigned", "In-Progress"] },
        }).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found or cannot be unassigned at this stage" });
        }

        const oldTechnicianId = ticket.technician;
        const wasActive = ticket.status !== "Queued";

        const updated = await ticketModel.findByIdAndUpdate(
            ticket._id,
            {
                status: "Pending",
                technician: null,
                technicianSnapshot: {},
                assignedBy: null,
                assignedAt: null,
                queuedAt: null,
                $push: {
                    statusHistory: {
                        from: ticket.status,
                        to: "Pending",
                        actorRole: "admin",
                        actorId: req.admin._id,
                        reason: String(reason).trim(),
                        at: new Date(),
                    },
                },
            },
            { new: true }
        ).lean();

        if (oldTechnicianId) {
            if (wasActive) {
                const { promoteQueuedTicket } = require("../services/dispatch.service");
                await promoteQueuedTicket(oldTechnicianId);
            }
            notification.notifyTechnicianUnassigned(oldTechnicianId, updated);
        }

        notification.notifyAdminsNewTicket(updated);

        return res.status(200).json({ success: true, message: "Ticket unassigned and back in queue", data: updated });
    } catch (error) {
        console.error("Unassign error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const reassignTicket = async (req, res) => {
    try {
        const { technicianId, reason, allowQueue } = req.body;

        if (!mongoose.Types.ObjectId.isValid(technicianId)) {
            return res.status(400).json({ success: false, message: "Invalid technician id" });
        }
        if (!reason || String(reason).trim().length < 3) {
            return res.status(400).json({ success: false, message: "A reason is required" });
        }

        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            status: { $in: ["Queued", "Assigned", "In-Progress"] },
        }).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found or not reassignable" });
        }
        if (String(ticket.technician) === String(technicianId)) {
            return res.status(400).json({ success: false, message: "Same technician already assigned" });
        }

        const newTech = await technicianModel
            .findOne({ _id: technicianId, isDeleted: false })
            .select("name phone profileImage rating activeTicket")
            .lean();

        if (!newTech) {
            return res.status(404).json({ success: false, message: "Technician not found" });
        }

        const isBusy = Boolean(newTech.activeTicket);
        if (isBusy && !allowQueue) {
            return res.status(409).json({
                success: false,
                message: "This technician is on another job. Queue it instead?",
                canQueue: true,
            });
        }

        if (!isBusy) {
            const locked = await technicianModel.findOneAndUpdate(
                { _id: technicianId, activeTicket: null, isDeleted: false },
                { isAvailable: false, activeTicket: ticket._id },
                { new: true }
            ).lean();
            if (!locked) {
                return res.status(409).json({ success: false, message: "Selected technician is no longer available" });
            }
        }

        const targetStatus = isBusy ? "Queued" : "Assigned";

        const updated = await ticketModel.findByIdAndUpdate(
            ticket._id,
            {
                status: targetStatus,
                technician: technicianId,
                technicianSnapshot: {
                    name: newTech.name,
                    phone: newTech.phone,
                    profileImage: newTech.profileImage,
                    rating: newTech.rating,
                },
                assignedBy: req.admin._id,
                assignedAt: isBusy ? null : new Date(),
                queuedAt: isBusy ? new Date() : null,
                $push: {
                    statusHistory: {
                        from: ticket.status,
                        to: targetStatus,
                        actorRole: "admin",
                        actorId: req.admin._id,
                        reason: `Reassigned: ${String(reason).trim()}`,
                        at: new Date(),
                    },
                },
            },
            { new: true }
        ).lean();

        // Free the old technician and pull in their next queued job
        if (ticket.technician && ticket.status !== "Queued") {
            const { promoteQueuedTicket } = require("../services/dispatch.service");
            await promoteQueuedTicket(ticket.technician);
            notification.notifyTechnicianUnassigned(ticket.technician, updated);
        }

        if (!isBusy) {
            notification.notifyTechnicianAssigned(updated);
            await notification.notifyCustomerAssigned(updated);
        } else {
            notification.notifyTechnicianQueued(updated);
        }

        return res.status(200).json({
            success: true,
            message: isBusy ? `Queued for ${newTech.name}` : `Ticket reassigned to ${newTech.name}`,
            data: updated,
        });
    } catch (error) {
        console.error("Reassign error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/admin/tickets/:id/reschedule
 * body: { scheduledFor, slotWindow, reason, technicianId }
 *
 * A rescheduled ticket always ends up Queued with a date - never Pending.
 * That keeps the technician free today while the job waits for its date.
 */
const rescheduleTicket = async (req, res) => {
    try {
        const { scheduledFor, slotWindow, reason, technicianId } = req.body;

        const newDate = new Date(scheduledFor);
        if (isNaN(newDate.getTime())) {
            return res.status(400).json({ success: false, message: "Valid date required" });
        }
        if (newDate < new Date(Date.now() - 60 * 60 * 1000)) {
            return res.status(400).json({ success: false, message: "Date cannot be in the past" });
        }

        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            status: { $in: ["Pending", "Queued", "Assigned"] },
        }).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found or cannot be rescheduled" });
        }

        // Keep whoever is already on it unless the office picks someone else
        const targetTechnicianId = technicianId || ticket.technician;

        if (!targetTechnicianId) {
            return res.status(400).json({
                success: false,
                message: "Pick a technician for this date before rescheduling",
            });
        }

        const tech = await technicianModel
            .findOne({ _id: targetTechnicianId, isDeleted: false, isBlacklisted: false })
            .select("name phone profileImage rating activeTicket")
            .lean();

        if (!tech) {
            return res.status(404).json({ success: false, message: "Technician not found" });
        }

        const wasTheirActiveJob = String(ticket.technician) === String(targetTechnicianId)
            && ticket.status === "Assigned";

        const update = {
            status: "Queued",
            technician: targetTechnicianId,
            technicianSnapshot: {
                name: tech.name,
                phone: tech.phone,
                profileImage: tech.profileImage,
                rating: tech.rating,
            },
            assignedBy: req.admin._id,
            assignedAt: null,
            queuedAt: new Date(),
            "scheduling.scheduledFor": newDate,
            "scheduling.slotWindow": slotWindow || undefined,
            "scheduling.isRescheduled": true,
            $push: {
                "scheduling.rescheduleHistory": {
                    oldDate: ticket.scheduling?.scheduledFor,
                    newDate,
                    reason: reason ? String(reason).trim() : undefined,
                    by: req.admin._id,
                    at: new Date(),
                },
                statusHistory: {
                    from: ticket.status,
                    to: "Queued",
                    actorRole: "admin",
                    actorId: req.admin._id,
                    reason: "Rescheduled: " + (reason || "new date set"),
                    at: new Date(),
                },
            },
        };

        const updated = await ticketModel.findByIdAndUpdate(
            ticket._id, update, { returnDocument: "after" }
        ).lean();

        // Pushing today's job to a later date frees the technician up now,
        // so pull in whatever else is due for them
        if (wasTheirActiveJob) {
            await promoteQueuedTicket(targetTechnicianId);
        }

        const dateStr = newDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

        await notification.notifyCustomer({
            ticket: updated,
            text:
                "Your service visit has been moved.\n\n" +
                "Ticket: " + updated.ticketNumber + "\n" +
                "New date: " + dateStr + (slotWindow ? " (" + slotWindow + ")" : "") + "\n" +
                "Technician: " + tech.name + " (" + tech.phone + ")\n\n" +
                "Reply to this message if the new time doesn't work for you.",
        });

        notification.notifyTechnicianQueued(updated);

        notification.notifyAdminsTicketRescheduled(updated, req.admin.name);

        return res.status(200).json({
            success: true,
            message: "Moved to " + dateStr + " with " + tech.name,
            data: updated,
        });
    } catch (error) {
        console.error("Reschedule error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const cancelTicket = async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || String(reason).trim().length < 3) {
            return res.status(400).json({ success: false, message: "Cancellation reason is required" });
        }

        const ticket = await ticketModel.findOneAndUpdate(
            { _id: req.params.id, status: { $in: ["Pending", "Queued", "Assigned", "In-Progress"] } },
            {
                status: "Cancelled",
                cancelReason: String(reason).trim(),
                $push: {
                    statusHistory: {
                        to: "Cancelled",
                        actorRole: "admin",
                        actorId: req.admin._id,
                        reason: String(reason).trim(),
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found or cannot be cancelled now" });
        }

        if (ticket.technician) {
            const wasActive = ticket.status !== "Queued";
            if (wasActive) {
                const { promoteQueuedTicket } = require("../services/dispatch.service");
                await promoteQueuedTicket(ticket.technician);
            }
            notification.notifyTechnicianUnassigned(ticket.technician, ticket);
        }

        await notification.notifyCustomerCancelled(ticket);

        // Puts the WhatsApp conversation back on the service menu. Without
        // this their next message hits a step that assumes a live ticket.
        await notification.resetConversation(ticket);

        notification.notifyAdminsTicketCancelled(ticket, req.admin.name, String(reason).trim());

        return res.status(200).json({ success: true, message: "Ticket cancelled", data: ticket });
    } catch (error) {
        console.error("Cancel ticket error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const forceCloseTicket = async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || String(reason).trim().length < 5) {
            return res.status(400).json({ success: false, message: "A reason is required" });
        }

        const ticket = await ticketModel.findOneAndUpdate(
            { _id: req.params.id, status: "Payment-Pending" },
            {
                status: "Closed",
                "payment.status": "Failed",
                $push: {
                    statusHistory: {
                        from: "Payment-Pending",
                        to: "Closed",
                        actorRole: "admin",
                        actorId: req.admin._id,
                        reason: String(reason).trim(),
                        at: new Date(),
                    },
                },
            },
            { new: true }
        ).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found or not pending payment" });
        }

        await Payment.findOneAndUpdate(
            { ticket: ticket._id, status: "pending" },
            { status: "failed", note: String(reason).trim() }
        );

        if (ticket.technician) {
            const { promoteQueuedTicket } = require("../services/dispatch.service");
            await promoteQueuedTicket(ticket.technician);
            notification.notifyTechnicianUnassigned(ticket.technician, ticket);
        }

        return res.status(200).json({ success: true, message: "Ticket force closed", data: ticket });
    } catch (error) {
        console.error("Force close error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/* ================= TECHNICIANS ================= */

const getAllTechnicians = async (req, res) => {
    try {
        const { status, skill, search, approval } = req.query;
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(60, Number(req.query.limit) || 24);

        const filter = {};

        // Pending applications are their own view - everything else defaults
        // to approved technicians so the roster stays clean
        if (approval === "pending") {
            filter.approvalStatus = "pending";
            filter.isBlacklisted = false;
        } else if (approval === "blocked") {
            filter.isBlacklisted = true;
        } else if (approval === "rejected") {
            filter.approvalStatus = "rejected";
        } else {
            filter.approvalStatus = "approved";
            filter.isDeleted = false;
            filter.isBlacklisted = false;

            if (status === "available") {
                filter.isAvailable = true;
                filter.activeTicket = null;
            } else if (status === "busy") {
                filter.activeTicket = { $ne: null };
            } else if (status === "offline") {
                filter.isAvailable = false;
                filter.activeTicket = null;
            }
        }

        if (skill) {
            const regex = buildSkillRegex(skill);
            if (regex) filter.skills = { $regex: regex };
        }

        if (search) {
            const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            filter.$or = [
                { name: { $regex: safe, $options: "i" } },
                { phone: { $regex: safe, $options: "i" } },
                { area: { $regex: safe, $options: "i" } },
            ];
        }

        const [technicians, total, pendingCount] = await Promise.all([
            technicianModel
                .find(filter)
                .select("name phone profileImage skills rating completedJobs performanceLevel area state isAvailable activeTicket hasVehicle lastLocationAt location approvalStatus isBlacklisted isDeleted createdAt")
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            technicianModel.countDocuments(filter),
            technicianModel.countDocuments({ approvalStatus: "pending", isBlacklisted: false }),
        ]);

        const data = technicians.map((t) => ({
            ...t,
            liveStatus: t.activeTicket ? "on_job" : t.isAvailable ? "available" : "offline",
            hasLocation: Array.isArray(t.location?.coordinates) && t.location.coordinates.length === 2,
        }));

        return res.status(200).json({
            success: true,
            data,
            pendingCount,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error("Get technicians error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const approveTechnician = async (req, res) => {
    try {
        const technician = await technicianModel.findOne({
            _id: req.params.id,
            isBlacklisted: false,
        }).select("name approvalStatus").lean();

        if (!technician) {
            return res.status(404).json({ success: false, message: "Technician not found" });
        }
        if (technician.approvalStatus === "approved") {
            return res.status(400).json({ success: false, message: "This account is already approved" });
        }

        const updated = await technicianModel.findByIdAndUpdate(
            req.params.id,
            {
                approvalStatus: "approved",
                approvedBy: req.admin._id,
                approvedAt: new Date(),
                rejectionReason: undefined,
                isDeleted: false,
            },
            { returnDocument: "after" }
        ).select("name phone approvalStatus").lean();

        return res.status(200).json({
            success: true,
            message: updated.name + " can now sign in",
            data: updated,
        });
    } catch (error) {
        console.error("Approve technician error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const rejectTechnician = async (req, res) => {
    try {
        const { reason } = req.body;

        if (!reason || String(reason).trim().length < 5) {
            return res.status(400).json({ success: false, message: "Give a reason so they know what to fix" });
        }

        const updated = await technicianModel.findOneAndUpdate(
            { _id: req.params.id, approvalStatus: "pending" },
            {
                approvalStatus: "rejected",
                rejectionReason: String(reason).trim(),
                approvedBy: req.admin._id,
                approvedAt: new Date(),
                isAvailable: false,
            },
            { returnDocument: "after" }
        ).select("name approvalStatus").lean();

        if (!updated) {
            return res.status(404).json({ success: false, message: "Technician not found or already reviewed" });
        }

        return res.status(200).json({ success: true, message: "Application rejected", data: updated });
    } catch (error) {
        console.error("Reject technician error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const blockTechnician = async (req, res) => {
    try {
        const { reason } = req.body;

        if (!reason || String(reason).trim().length < 5) {
            return res.status(400).json({ success: false, message: "A reason is required to block an account" });
        }

        const technician = await technicianModel.findById(req.params.id)
            .select("name activeTicket isBlacklisted")
            .lean();

        if (!technician) {
            return res.status(404).json({ success: false, message: "Technician not found" });
        }
        if (technician.isBlacklisted) {
            return res.status(400).json({ success: false, message: "This account is already blocked" });
        }
        if (technician.activeTicket) {
            return res.status(400).json({
                success: false,
                message: "Reassign their current job before blocking this account",
            });
        }

        const undeposited = await Payment.countDocuments({
            collectedBy: req.params.id, method: "cash", status: "collected",
        });
        if (undeposited > 0) {
            return res.status(400).json({
                success: false,
                message: "They still hold undeposited cash. Settle that first.",
            });
        }

        const updated = await technicianModel.findByIdAndUpdate(
            req.params.id,
            {
                isBlacklisted: true,
                blacklistedBy: req.admin._id,
                blacklistedAt: new Date(),
                blacklistReason: String(reason).trim(),
                isDeleted: true,
                isAvailable: false,
                activeTicket: null,
            },
            { returnDocument: "after" }
        ).select("name phone isBlacklisted").lean();

        // Any live session dies on their next request - the auth middleware
        // rechecks this flag every time
        notification.notifyTechnicianBlocked(req.params.id);

        return res.status(200).json({
            success: true,
            message: updated.name + " has been blocked",
            data: updated,
        });
    } catch (error) {
        console.error("Block technician error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const unblockTechnician = async (req, res) => {
    try {
        const updated = await technicianModel.findOneAndUpdate(
            { _id: req.params.id, isBlacklisted: true },
            {
                isBlacklisted: false,
                isDeleted: false,
                blacklistReason: undefined,
                blacklistedBy: undefined,
                blacklistedAt: undefined,
                // Back to review rather than straight to active
                approvalStatus: "pending",
            },
            { returnDocument: "after" }
        ).select("name isBlacklisted approvalStatus").lean();

        if (!updated) {
            return res.status(404).json({ success: false, message: "Technician not found or not blocked" });
        }

        return res.status(200).json({
            success: true,
            message: updated.name + " unblocked - approve them to restore access",
            data: updated,
        });
    } catch (error) {
        console.error("Unblock technician error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const getTechnicianById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid technician id" });
        }

        const [technician, activeTicket, scheduled, recentJobs, cashHeld, totalEarnings] = await Promise.all([
            technicianModel.findById(id)
                .select("name phone email profileImage skills rating completedJobs performanceLevel area state pincode isAvailable activeTicket hasVehicle lastLocationAt location isDeleted createdAt approvalStatus isBlacklisted blacklistReason rejectionReason approvedAt walletBalancePaise commissionRate bankDetails.accountHolderName bankDetails.accountNumber bankDetails.accountLast4 bankDetails.ifsc bankDetails.bankName bankDetails.branch")
                .lean(),

            ticketModel.findOne({ technician: id, status: { $in: ["Assigned", "In-Progress", "Payment-Pending"] } })
                .select("ticketNumber serviceLabel customerSnapshot status createdAt")
                .lean(),

            ticketModel.find({ technician: id, status: "Queued" })
                .select("ticketNumber serviceLabel customerSnapshot scheduling queuedAt")
                .sort({ "scheduling.scheduledFor": 1, queuedAt: 1 })
                .lean(),

            ticketModel.find({ technician: id, status: "Closed" })
                .select("ticketNumber serviceLabel billing.totalPaise customerSnapshot payment.method updatedAt")
                .sort({ updatedAt: -1 })
                .limit(10)
                .lean(),

            Payment.aggregate([
                { $match: { collectedBy: new mongoose.Types.ObjectId(id), method: "cash", status: "collected" } },
                { $group: { _id: null, count: { $sum: 1 }, totalPaise: { $sum: "$amountPaise" } } },
            ]),

            Payment.aggregate([
                { $match: { collectedBy: new mongoose.Types.ObjectId(id), status: { $in: ["collected", "verified"] } } },
                { $group: { _id: null, techShare: { $sum: "$technicianSharePaise" }, compCommission: { $sum: "$commissionPaise" } } }
            ]),
        ]);

        if (!technician) {
            return res.status(404).json({ success: false, message: "Technician not found" });
        }

        const lat = technician.location?.coordinates?.[1];
        const lon = technician.location?.coordinates?.[0];

        return res.status(200).json({
            success: true,
            data: {
                ...technician,
                liveStatus: technician.activeTicket ? "on_job" : technician.isAvailable ? "available" : "offline",
                hasLocation: Array.isArray(technician.location?.coordinates),
                mapsUrl: notification.buildPinUrl(lat, lon),
                activeTicket: activeTicket || null,
                scheduledTickets: scheduled,
                financials: {
                    walletBalance: paiseToRupees(Math.abs(technician.walletBalancePaise || 0)),
                    walletDirection: (technician.walletBalancePaise || 0) > 0 ? "company_owes" : "technician_owes",
                    totalEarned: paiseToRupees(totalEarnings[0]?.techShare || 0),
                    companyProfit: paiseToRupees(totalEarnings[0]?.compCommission || 0),
                    commissionRate: technician.commissionRate || 20,
                    cashHeld: {
                        count: cashHeld[0]?.count || 0,
                        amount: paiseToRupees(cashHeld[0]?.totalPaise || 0)
                    }
                },
                recentJobs: recentJobs.map((j) => ({
                    ...j,
                    amountDisplay: paiseToRupees(j.billing?.totalPaise || 0),
                })),
                cashHeld: {
                    count: cashHeld[0]?.count || 0,
                    amountDisplay: paiseToRupees(cashHeld[0]?.totalPaise || 0),
                },
            },
        });
    } catch (error) {
        console.error("Get technician error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};


/* ================= PAYMENTS ================= */

// GET /api/admin/payments?status=collected&method=cash
// GET /api/admin/payments?status=collected&method=online
const getPayments = async (req, res) => {
    try {
        const status = req.query.status || "all";
        const method = req.query.method;
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(50, Number(req.query.limit) || 20);

        const filter = {};
        if (status !== "all") filter.status = status;
        if (method === "cash") filter.method = "cash";
        else if (method === "online") filter.method = { $ne: "cash" };

        const [payments, total, summary, awaitingReconcile] = await Promise.all([
            Payment.find(filter)
                .populate("collectedBy", "name phone")
                .populate("verifiedBy", "name")
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),

            Payment.countDocuments(filter),

            Payment.aggregate([
                {
                    $group: {
                        _id: { status: "$status", isCash: { $eq: ["$method", "cash"] } },
                        count: { $sum: 1 },
                        totalPaise: { $sum: "$amountPaise" },
                    },
                },
            ]),

            // Only online payments need reconciling against the bank. Cash
            // never touched the company account - the technician holds it,
            // and settling that happens in Wallets, not here.
            Payment.countDocuments({ status: "collected", method: { $ne: "cash" } }),
        ]);

        const totals = { cash: {}, online: {} };
        summary.forEach((s) => {
            const bucket = s._id.isCash ? "cash" : "online";
            totals[bucket][s._id.status] = {
                count: s.count,
                amountDisplay: paiseToRupees(s.totalPaise),
            };
        });

        return res.status(200).json({
            success: true,
            data: payments.map((p) => ({
                ...p,
                amountDisplay: paiseToRupees(p.amountPaise),
                commissionDisplay: paiseToRupees(p.commissionPaise || 0),
                technicianShareDisplay: paiseToRupees(p.technicianSharePaise || 0),
                gatewayFeeDisplay: paiseToRupees((p.gatewayFeePaise || 0) + (p.gatewayTaxPaise || 0)),
            })),
            summary: totals,
            awaitingReconcile,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error("Get payments error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/admin/payments/:id/verify
 *
 * Reconciliation for online payments only: the money reached the company
 * account and matches the settlement. Cash never entered the company
 * account, so there is nothing to reconcile - what matters there is whether
 * the technician deposited the commission, which lives in Wallets.
 */
const verifyPayment = async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.id).select("method status").lean();

        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found" });
        }

        if (payment.method === "cash") {
            return res.status(400).json({
                success: false,
                message: "Cash goes to the technician, not the company. Settle the commission in Wallets instead.",
            });
        }

        const updated = await Payment.findOneAndUpdate(
            { _id: req.params.id, status: "collected" },
            { status: "verified", verifiedBy: req.admin._id, verifiedAt: new Date() },
            { returnDocument: "after" }
        ).lean();

        if (!updated) {
            return res.status(400).json({ success: false, message: "Already reconciled" });
        }

        await ticketModel.updateOne(
            { _id: updated.ticket },
            {
                "payment.status": "Verified",
                "payment.verifiedBy": req.admin._id,
                "payment.verifiedAt": new Date(),
            }
        );

        return res.status(200).json({ success: true, message: "Reconciled", data: updated });
    } catch (error) {
        console.error("Verify payment error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/* ================= STAFF (superadmin) ================= */

const getAllStaff = async (req, res) => {
    try {
        const staff = await adminModel
            .find({})
            .select("name email role isActive lastLoginAt createdAt")
            .sort({ createdAt: -1 })
            .lean();

        return res.status(200).json({ success: true, data: staff });
    } catch (error) {
        console.error("Get staff error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const createStaff = async (req, res) => {
    try {
        const { name, email, password, role } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ success: false, message: "Name, email and password are required" });
        }
        if (String(password).length < 6) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
        }

        const cleanEmail = String(email).toLowerCase().trim();
        const exists = await adminModel.findOne({ email: cleanEmail }).select("_id").lean();
        if (exists) {
            return res.status(400).json({ success: false, message: "Email already registered" });
        }

        const admin = await adminModel.create({
            name: String(name).trim(),
            email: cleanEmail,
            password: await bcrypt.hash(password, 10),
            role: role === "superadmin" ? "superadmin" : "backoffice",
        });

        return res.status(201).json({
            success: true,
            message: `${admin.name} added as ${admin.role}`,
            data: { _id: admin._id, name: admin.name, email: admin.email, role: admin.role, isActive: admin.isActive },
        });
    } catch (error) {
        console.error("Create staff error:", error);
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: "Email already registered" });
        }
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const toggleStaffActive = async (req, res) => {
    try {
        const { id } = req.params;

        if (String(id) === String(req.admin._id)) {
            return res.status(400).json({ success: false, message: "You cannot deactivate your own account" });
        }

        const staff = await adminModel.findById(id).select("_id name isActive role").lean();
        if (!staff) {
            return res.status(404).json({ success: false, message: "Staff not found" });
        }

        if (staff.role === "superadmin" && staff.isActive) {
            const activeSupers = await adminModel.countDocuments({ role: "superadmin", isActive: true });
            if (activeSupers <= 1) {
                return res.status(400).json({ success: false, message: "Cannot deactivate the last active superadmin" });
            }
        }

        const updated = await adminModel
            .findByIdAndUpdate(id, { isActive: !staff.isActive }, { new: true })
            .select("name email role isActive")
            .lean();

        return res.status(200).json({
            success: true,
            message: `${updated.name} ${updated.isActive ? "activated" : "deactivated"}`,
            data: updated,
        });
    } catch (error) {
        console.error("Toggle staff error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/* ================= ANALYTICS (superadmin) ================= */

const getRevenueAnalytics = async (req, res) => {
    try {
        const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        since.setHours(0, 0, 0, 0);

        // Long periods group by month - 365 daily points is unreadable
        const groupByMonth = days > 92;

        const paidMatch = {
            createdAt: { $gte: since },
            status: { $in: ["collected", "verified"] },
        };

        const [pnl, byTechnician, byService, series, ticketCounts, pendingAgg] = await Promise.all([
            // One pass over paid invoices gives the whole P&L. Splitting
            // cash from online matters because only online carries a
            // gateway fee.
            Payment.aggregate([
                { $match: paidMatch },
                {
                    $group: {
                        _id: { $eq: ["$method", "cash"] },
                        jobs: { $sum: 1 },
                        grossPaise: { $sum: "$amountPaise" },
                        commissionPaise: { $sum: "$commissionPaise" },
                        technicianSharePaise: { $sum: "$technicianSharePaise" },
                        gatewayFeePaise: { $sum: { $add: [{ $ifNull: ["$gatewayFeePaise", 0] }, { $ifNull: ["$gatewayTaxPaise", 0] }] } },
                    },
                },
            ]),

            Payment.aggregate([
                { $match: paidMatch },
                {
                    $group: {
                        _id: "$collectedBy",
                        jobs: { $sum: 1 },
                        grossPaise: { $sum: "$amountPaise" },
                        sharePaise: { $sum: "$technicianSharePaise" },
                    },
                },
                { $sort: { grossPaise: -1 } },
                { $limit: 10 },
                { $lookup: { from: "technicians", localField: "_id", foreignField: "_id", as: "tech" } },
                {
                    $project: {
                        jobs: 1, grossPaise: 1, sharePaise: 1,
                        name: { $arrayElemAt: ["$tech.name", 0] },
                    },
                },
            ]),

            ticketModel.aggregate([
                { $match: { createdAt: { $gte: since }, status: "Closed" } },
                {
                    $group: {
                        _id: "$serviceLabel",
                        jobs: { $sum: 1 },
                        grossPaise: { $sum: "$billing.totalPaise" },
                        commissionPaise: { $sum: "$billing.commissionPaise" },
                    },
                },
                { $sort: { grossPaise: -1 } },
            ]),

            Payment.aggregate([
                { $match: paidMatch },
                {
                    $group: {
                        _id: {
                            $dateToString: {
                                format: groupByMonth ? "%Y-%m" : "%Y-%m-%d",
                                date: "$createdAt",
                                timezone: "Asia/Kolkata",
                            },
                        },
                        grossPaise: { $sum: "$amountPaise" },
                        commissionPaise: { $sum: "$commissionPaise" },
                        technicianSharePaise: { $sum: "$technicianSharePaise" },
                        gatewayFeePaise: { $sum: { $add: [{ $ifNull: ["$gatewayFeePaise", 0] }, { $ifNull: ["$gatewayTaxPaise", 0] }] } },
                        cashPaise: {
                            $sum: { $cond: [{ $eq: ["$method", "cash"] }, "$amountPaise", 0] },
                        },
                        onlinePaise: {
                            $sum: { $cond: [{ $ne: ["$method", "cash"] }, "$amountPaise", 0] },
                        },
                        jobs: { $sum: 1 },
                    },
                },
                { $sort: { _id: 1 } },
            ]),

            ticketModel.aggregate([
                { $match: { createdAt: { $gte: since } } },
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),

            Payment.aggregate([
                { $match: { createdAt: { $gte: since } } },
                { $group: { _id: "$status", totalPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
            ]),
        ]);

        const cash = pnl.find((p) => p._id === true) || {};
        const online = pnl.find((p) => p._id === false) || {};

        const grossPaise = (cash.grossPaise || 0) + (online.grossPaise || 0);
        const commissionPaise = (cash.commissionPaise || 0) + (online.commissionPaise || 0);
        const technicianSharePaise = (cash.technicianSharePaise || 0) + (online.technicianSharePaise || 0);
        const gatewayFeePaise = online.gatewayFeePaise || 0;

        // What the company actually keeps: its commission minus what the
        // gateway took. Commission alone overstates the margin.
        const netCompanyPaise = commissionPaise - gatewayFeePaise;

        const toRupees = (paise) => Math.round((paise || 0) / 100);

        const statusCounts = {};
        ticketCounts.forEach((s) => { statusCounts[s._id] = s.count; });

        const statusTotals = {};
        pendingAgg.forEach((s) => {
            statusTotals[s._id] = s.totalPaise;
        });

        return res.status(200).json({
            success: true,
            data: {
                periodDays: days,
                groupedBy: groupByMonth ? "month" : "day",

                summary: {
                    totalEarnedDisplay: paiseToRupees(grossPaise),
                    verifiedDisplay: paiseToRupees(statusTotals["verified"] || 0),
                    collectedDisplay: paiseToRupees(statusTotals["collected"] || 0),
                    pendingDisplay: paiseToRupees(statusTotals["pending"] || 0),
                },

                pnl: {
                    grossDisplay: paiseToRupees(grossPaise),
                    technicianShareDisplay: paiseToRupees(technicianSharePaise),
                    commissionDisplay: paiseToRupees(commissionPaise),
                    gatewayFeeDisplay: paiseToRupees(gatewayFeePaise),
                    netCompanyDisplay: paiseToRupees(netCompanyPaise),

                    gross: toRupees(grossPaise),
                    technicianShare: toRupees(technicianSharePaise),
                    commission: toRupees(commissionPaise),
                    gatewayFee: toRupees(gatewayFeePaise),
                    netCompany: toRupees(netCompanyPaise),

                    marginPercent: grossPaise > 0
                        ? Number(((netCompanyPaise / grossPaise) * 100).toFixed(1))
                        : 0,
                },

                split: {
                    cash: {
                        jobs: cash.jobs || 0,
                        grossDisplay: paiseToRupees(cash.grossPaise || 0),
                        gross: toRupees(cash.grossPaise),
                        commissionDisplay: paiseToRupees(cash.commissionPaise || 0),
                    },
                    online: {
                        jobs: online.jobs || 0,
                        grossDisplay: paiseToRupees(online.grossPaise || 0),
                        gross: toRupees(online.grossPaise),
                        commissionDisplay: paiseToRupees(online.commissionPaise || 0),
                        gatewayFeeDisplay: paiseToRupees(gatewayFeePaise),
                    },
                },

                pending: {
                    count: pendingAgg[0]?.count || 0,
                    display: paiseToRupees(pendingAgg[0]?.totalPaise || 0),
                },

                tickets: {
                    closed: statusCounts.Closed || 0,
                    cancelled: statusCounts.Cancelled || 0,
                    open: (statusCounts.Pending || 0) + (statusCounts.Queued || 0) +
                        (statusCounts.Assigned || 0) + (statusCounts["In-Progress"] || 0) +
                        (statusCounts["Payment-Pending"] || 0),
                },

                series: (() => {
                    const skeleton = [];
                    const now = new Date();
                    if (groupByMonth) {
                        let curr = new Date(since);
                        curr.setDate(1);
                        while (curr <= now) {
                            const id = curr.getFullYear() + "-" + String(curr.getMonth() + 1).padStart(2, "0");
                            skeleton.push({ _id: id, grossPaise: 0, commissionPaise: 0, technicianSharePaise: 0, gatewayFeePaise: 0, cashPaise: 0, onlinePaise: 0, jobs: 0 });
                            curr.setMonth(curr.getMonth() + 1);
                        }
                    } else {
                        let curr = new Date(since);
                        while (curr <= now) {
                            const id = curr.getFullYear() + "-" + String(curr.getMonth() + 1).padStart(2, "0") + "-" + String(curr.getDate()).padStart(2, "0");
                            skeleton.push({ _id: id, grossPaise: 0, commissionPaise: 0, technicianSharePaise: 0, gatewayFeePaise: 0, cashPaise: 0, onlinePaise: 0, jobs: 0 });
                            curr.setDate(curr.getDate() + 1);
                        }
                    }
                    
                    const seriesMap = new Map(series.map(s => [s._id, s]));
                    const fullSeries = skeleton.map(s => seriesMap.get(s._id) || s);

                    // Crop leading empty days so the graph expands and looks bigger,
                    // but keep at least 2 days so Recharts can draw an area.
                    let firstIndex = fullSeries.findIndex(s => s.grossPaise > 0 || s.jobs > 0);
                    if (firstIndex === -1) firstIndex = fullSeries.length - 1;
                    if (firstIndex === fullSeries.length - 1) {
                        firstIndex = Math.max(0, fullSeries.length - 7); // Show a week of context if only 1 day has data
                    } else {
                        firstIndex = Math.max(0, firstIndex - 1); // Give 1 day of padding before the first data point
                    }

                    const trimmedSeries = fullSeries.slice(firstIndex);

                    return trimmedSeries.map((s) => ({
                        period: s._id,
                        gross: toRupees(s.grossPaise),
                        commission: toRupees(s.commissionPaise),
                        technicianShare: toRupees(s.technicianSharePaise),
                        gatewayFee: toRupees(s.gatewayFeePaise),
                        netCompany: toRupees(s.commissionPaise - s.gatewayFeePaise),
                        cash: toRupees(s.cashPaise),
                        online: toRupees(s.onlinePaise),
                        jobs: s.jobs,
                    }));
                })(),

                byTechnician: byTechnician.map((t) => ({
                    name: t.name || "Unknown",
                    jobs: t.jobs,
                    gross: toRupees(t.grossPaise),
                    grossDisplay: paiseToRupees(t.grossPaise),
                    earned: toRupees(t.sharePaise),
                    earnedDisplay: paiseToRupees(t.sharePaise),
                })),

                byService: byService.map((s) => ({
                    service: s._id,
                    jobs: s.jobs,
                    revenue: toRupees(s.grossPaise),
                    revenueDisplay: paiseToRupees(s.grossPaise || 0),
                    commissionDisplay: paiseToRupees(s.commissionPaise || 0),
                })),
            },
        });
    } catch (error) {
        console.error("Revenue analytics error:", error.message, error.stack);
        return res.status(500).json({ success: false, message: "Could not load analytics — " + (error.message || "Internal Server Error") });
    }
};

/* ================= SERVICE PRICING ================= */

// GET /api/admin/pricing
const getPricingList = async (req, res) => {
    try {
        const docs = await ServicePricing.find({}).lean();
        const byKey = new Map(docs.map((d) => [d.serviceKey, d]));

        // Return every service, even ones with no items yet, so the UI can
        // show empty tabs instead of hiding the service entirely
        const data = SERVICE_CATALOG.map((s) => {
            const doc = byKey.get(s.key);
            return {
                serviceKey: s.key,
                serviceLabel: s.label,
                itemsList: (doc?.itemsList || []).map((i) => ({
                    ...i,
                    priceDisplay: paiseToRupees(i.pricePaise),
                })),
            };
        });

        return res.status(200).json({ success: true, data });
    } catch (error) {
        console.error("Get pricing list error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// POST /api/admin/pricing/:serviceKey/items
const addPricingItem = async (req, res) => {
    try {
        const { serviceKey } = req.params;
        const { name, category, priceRupees, isDefault, subCategory } = req.body;

        const service = SERVICE_CATALOG.find((s) => s.key === serviceKey);
        if (!service) {
            return res.status(400).json({ success: false, message: "Unknown service" });
        }
        if (!name || priceRupees === undefined) {
            return res.status(400).json({ success: false, message: "Name and price are required" });
        }

        const rupees = Number(priceRupees);
        if (!Number.isFinite(rupees) || rupees < 0 || rupees > 50000) {
            return res.status(400).json({ success: false, message: "Price must be between 0 and 50000" });
        }

        const item = {
            name: String(name).trim(),
            category: ["labour", "part", "service"].includes(category) ? category : "part",
            pricePaise: Math.round(rupees * 100),
            isDefault: Boolean(isDefault),
            isActive: true,
        };

        if (subCategory) {
            item.subCategory = String(subCategory).trim();
        }

        // upsert so the first item for a service creates the document
        const doc = await ServicePricing.findOneAndUpdate(
            { serviceKey },
            {
                $set: { serviceLabel: service.label, updatedBy: req.admin._id },
                $push: { itemsList: item },
            },
            { new: true, upsert: true }
        ).lean();

        return res.status(201).json({ success: true, message: "Item added", data: doc });
    } catch (error) {
        console.error("Add pricing item error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// PUT /api/admin/pricing/:serviceKey/items/:itemId
const updatePricingItem = async (req, res) => {
    try {
        const { serviceKey, itemId } = req.params;
        const { name, category, priceRupees, isActive, isDefault, subCategory } = req.body;

        const set = { updatedBy: req.admin._id };
        if (name) set["itemsList.$.name"] = String(name).trim();
        if (["labour", "part", "service"].includes(category)) set["itemsList.$.category"] = category;
        if (typeof isActive === "boolean") set["itemsList.$.isActive"] = isActive;
        if (typeof isDefault === "boolean") set["itemsList.$.isDefault"] = isDefault;
        if (subCategory !== undefined) set["itemsList.$.subCategory"] = subCategory ? String(subCategory).trim() : null;

        if (priceRupees !== undefined) {
            const rupees = Number(priceRupees);
            if (!Number.isFinite(rupees) || rupees < 0 || rupees > 50000) {
                return res.status(400).json({ success: false, message: "Price must be between 0 and 50000" });
            }
            set["itemsList.$.pricePaise"] = Math.round(rupees * 100);
        }

        // The positional $ operator updates only the matched array element
        const doc = await ServicePricing.findOneAndUpdate(
            { serviceKey, "itemsList._id": itemId },
            { $set: set },
            { new: true }
        ).lean();

        if (!doc) {
            return res.status(404).json({ success: false, message: "Item not found" });
        }

        return res.status(200).json({ success: true, message: "Item updated", data: doc });
    } catch (error) {
        console.error("Update pricing item error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// DELETE /api/admin/pricing/:serviceKey/items/:itemId
const deletePricingItem = async (req, res) => {
    try {
        const { serviceKey, itemId } = req.params;

        // Hard delete is safe here - past invoices snapshot the item name
        // and price into ticket.billing.lineItems, so history stays intact
        const doc = await ServicePricing.findOneAndUpdate(
            { serviceKey },
            { $pull: { itemsList: { _id: itemId } }, $set: { updatedBy: req.admin._id } },
            { new: true }
        ).lean();

        if (!doc) {
            return res.status(404).json({ success: false, message: "Service not found" });
        }

        return res.status(200).json({ success: true, message: "Item removed", data: doc });
    } catch (error) {
        console.error("Delete pricing item error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

//wallet
const issueTechnicianPayout = async (req, res) => {
    try {
        const { technicianId, amountPaise, referenceNote } = req.body;

        if (!technicianId) {
            return res.status(400).json({ success: false, message: "Technician ID is required" });
        }
        if (!referenceNote || String(referenceNote).trim().length < 3) {
            return res.status(400).json({
                success: false,
                message: "Enter the UTR or transaction reference so this can be traced later",
            });
        }

        const transaction = await walletService.processPayout(
            technicianId,
            amountPaise ? Number(amountPaise) : null,
            String(referenceNote).trim()
        );

        return res.status(200).json({
            success: true,
            message: "Payout recorded and wallet settled",
            data: transaction,
        });
    } catch (error) {
        console.error("Payout error:", error.message);
        return res.status(400).json({ success: false, message: error.message || "Payout failed" });
    }
};

const getWalletSummary = async (req, res) => {
    try {
        const technicians = await technicianModel
            .find({ isDeleted: false, walletBalancePaise: { $ne: 0 } })
            .select("name phone walletBalancePaise commissionRate area")
            .sort({ walletBalancePaise: -1 })
            .lean();

        let owedToTechnicians = 0;
        let owedByTechnicians = 0;

        const rows = technicians.map((t) => {
            const balance = t.walletBalancePaise || 0;
            if (balance > 0) owedToTechnicians += balance;
            else owedByTechnicians += Math.abs(balance);

            return {
                _id: t._id,
                name: t.name,
                phone: t.phone,
                area: t.area,
                commissionRate: t.commissionRate,
                balancePaise: balance,
                balanceDisplay: paiseToRupees(Math.abs(balance)),
                direction: balance > 0 ? "company_owes" : "technician_owes",
            };
        });

        return res.status(200).json({
            success: true,
            data: rows,
            summary: {
                owedToTechniciansDisplay: paiseToRupees(owedToTechnicians),
                owedByTechniciansDisplay: paiseToRupees(owedByTechnicians),
                netDisplay: paiseToRupees(owedToTechnicians - owedByTechnicians),
            },
        });
    } catch (error) {
        console.error("Wallet summary error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// GET /api/admin/wallets/:technicianId
const getTechnicianWallet = async (req, res) => {
    try {
        const WalletTransaction = require("../models/walletTransaction.model");

        const [tech, transactions] = await Promise.all([
            technicianModel.findById(req.params.technicianId)
                .select("name phone walletBalancePaise commissionRate")
                .lean(),
            WalletTransaction.find({ technician: req.params.technicianId })
                .sort({ createdAt: -1 })
                .limit(100)
                .populate("ticket", "ticketNumber serviceLabel")
                .lean(),
        ]);

        if (!tech) {
            return res.status(404).json({ success: false, message: "Technician not found" });
        }

        return res.status(200).json({
            success: true,
            data: {
                technician: tech,
                balancePaise: tech.walletBalancePaise || 0,
                balanceDisplay: paiseToRupees(Math.abs(tech.walletBalancePaise || 0)),
                direction: (tech.walletBalancePaise || 0) > 0 ? "company_owes" : "technician_owes",
                transactions: transactions.map((t) => ({
                    ...t,
                    amountDisplay: paiseToRupees(t.amountPaise),
                    balanceAfterDisplay: paiseToRupees(Math.abs(t.balanceAfterPaise)),
                })),
            },
        });
    } catch (error) {
        console.error("Technician wallet error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// POST /api/admin/wallets/:technicianId/collect
// Technician office aaya aur negative balance settle kiya
const collectFromTechnician = async (req, res) => {
    try {
        const { amountPaise, referenceNote } = req.body;

        const amount = Number(amountPaise);
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: "Enter a valid amount" });
        }
        if (!referenceNote || String(referenceNote).trim().length < 3) {
            return res.status(400).json({ success: false, message: "Note how it was received - cash, UPI, or a reference" });
        }

        // Positive delta because the technician owed us and has now paid,
        // which moves their negative balance back towards zero
        const transaction = await walletService.adjustBalance(
            req.params.technicianId,
            amount,
            "Collected from technician: " + String(referenceNote).trim()
        );

        return res.status(200).json({
            success: true,
            message: "Collection recorded",
            data: transaction,
        });
    } catch (error) {
        console.error("Collect from technician error:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
};


/**
 * GET /api/admin/analytics/export?days=90
 *
 * Streams a CSV of every closed job in the period. This is what gets opened
 * in Excel or imported into a Google Sheet - a JSON endpoint would need
 * conversion first, and the accountant just wants a file.
 */
const exportRevenueCsv = async (req, res) => {
    try {
        const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const tickets = await ticketModel
            .find({ status: "Closed", updatedAt: { $gte: since } })
            .select("ticketNumber serviceLabel customerSnapshot technicianSnapshot billing payment createdAt updatedAt")
            .sort({ updatedAt: -1 })
            .limit(5000)
            .lean();

        // Anything with a comma, quote or newline breaks the column layout,
        // so quote every field and double any inner quotes
        const cell = (value) => {
            const str = value === null || value === undefined ? "" : String(value);
            return '"' + str.replace(/"/g, '""') + '"';
        };

        const header = [
            "Invoice", "Ticket", "Closed on", "Service",
            "Customer", "Phone", "Area",
            "Technician", "Payment method", "Payment status",
            "Subtotal", "GST", "Total",
            "Commission %", "Commission", "Technician share",
        ];

        const rows = tickets.map((t) => [
            t.billing?.invoiceNumber || "",
            t.ticketNumber,
            new Date(t.updatedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
            t.serviceLabel,
            t.customerSnapshot?.name || "",
            t.customerSnapshot?.phone || "",
            t.customerSnapshot?.area || "",
            t.technicianSnapshot?.name || "",
            t.payment?.method || "",
            t.payment?.status || "",
            paiseToRupees(t.billing?.subtotalPaise || 0),
            paiseToRupees(t.billing?.gstPaise || 0),
            paiseToRupees(t.billing?.totalPaise || 0),
            t.billing?.commissionPercent ?? "",
            paiseToRupees(t.billing?.commissionPaise || 0),
            paiseToRupees(t.billing?.technicianSharePaise || 0),
        ]);

        const csv = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");

        const stamp = new Date().toISOString().split("T")[0];
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="cosmosgen-revenue-' + stamp + '.csv"');

        // BOM so Excel opens rupee symbols and Indian names correctly
        return res.status(200).send("\uFEFF" + csv);
    } catch (error) {
        console.error("Export CSV error:", error);
        return res.status(500).json({ success: false, message: "Could not build the export" });
    }
};


module.exports = {
    registerAdmin,
    loginAdmin,
    logoutAdmin,
    getAdminProfile,
    getDashboardStats,
    getTickets,
    getTicketById,
    getNearbyTechnicians,
    assignTicket,
    unassignTicket,
    reassignTicket,
    rescheduleTicket,
    cancelTicket,
    forceCloseTicket,
    getAllTechnicians,
    getPayments,
    verifyPayment,
    getAllStaff,
    createStaff,
    toggleStaffActive,
    getRevenueAnalytics,
    getPricingList,
    addPricingItem,
    updatePricingItem,
    deletePricingItem,
    getTechnicianById,
    approveTechnician,
    rejectTechnician,
    blockTechnician,
    unblockTechnician,
    issueTechnicianPayout,
    getWalletSummary,
    getTechnicianWallet,
    collectFromTechnician,
    exportRevenueCsv
};
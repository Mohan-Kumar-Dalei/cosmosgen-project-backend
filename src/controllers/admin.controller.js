const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const adminModel = require("../models/admin.model");
const ticketModel = require("../models/ticket.model");
const technicianModel = require("../models/technician.model");
const Payment = require("../models/payment.model");
const WalletTransaction = require("../models/walletTransaction.model");
const ServicePricing = require("../models/servicePricing.model");
const { buildSkillRegex, escapeRegex } = require("../config/services");
// Blocking or purging a vendor has to reach the socket he already holds - the
// connect-time check cannot, having already run
const { techRoom, dropRoom } = require("../sockets/socket.instance");
const { metresBetween } = require("../services/ride.service");
const { lookupPlace } = require("./map.controller");
const routeService = require("../services/route.service");
const voiceController = require("./voice.controller");
const { SERVICE_CATALOG } = require("../config/services");
const notification = require("../services/notification.service");
const paymentService = require("../services/payment.service");
const { paiseToRupees } = require("../services/payment.service");
const { promoteQueuedTicket } = require("../services/dispatch.service");
const walletService = require("../services/wallet.service");
const settingsService = require("../services/settings.service");
const {
    estimateGatewayFee, GATEWAY_FEE_PERCENT,
    getRazorpay, isConfigured: razorpayConfigured,
} = require("../config/razorpay");

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

        const [
            ticketStats, techStats, todayCount, paymentGroups, rejectedCount,
            cashHeld, queuedSplit, visitsToCheck, walletsToSettle, techApplications,
        ] = await Promise.all([
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

            // Every bill, grouped by its status and by whether it was
            // paid in cash.
            //
            // This used to fetch the To verify queue alone, which left
            // each tab on the payments screen to count its own rows out of
            // whatever list it happened to have loaded - so a tab nobody
            // had opened carried no number. One shape here answers for all
            // of them, whether or not anyone is looking at that tab.
            Payment.aggregate([
                // Bills only. A commission coming back is not a queue item
                // - it is settled on the job it belongs to.
                { $match: { ticket: { $ne: null } } },
                {
                    $group: {
                        _id: { status: "$status", isCash: { $eq: ["$method", "cash"] } },
                        count: { $sum: 1 },
                        totalPaise: { $sum: "$amountPaise" },
                    },
                },
            ]),

            // Pending tickets that came back from a technician - these need
            // a decision, not just an assignment
            ticketModel.countDocuments({ status: "Pending", "rejection.reason": { $exists: true } }),

            // What technicians still have to hand back on cash jobs.
            //
            // This used to sum the whole bill, so a Rs 1,000 cash job at
            // 30% read as "Rs 1,000 still with technicians" when the
            // company was only owed Rs 300 of it - and the card calling it
            // "commission" made the overstatement look deliberate. Visit
            // charges are excluded outright: the company takes nothing on
            // them, so there is nothing to chase.
            Payment.aggregate([
                {
                    $match: {
                        status: "collected",
                        method: "cash",
                        isVisitCharge: { $ne: true },
                        commissionPaise: { $gt: 0 },
                    },
                },
                { $group: { _id: null, count: { $sum: 1 }, totalPaise: { $sum: "$commissionPaise" } } },
            ]),

            // "Next up" and "Scheduled" are the same status - the
            // difference is whether a date was put on it. Counting them
            // together gave the Scheduled tab a number that included work
            // nobody had booked, and left Next up with no number at all.
            ticketModel.aggregate([
                { $match: { status: "Queued" } },
                {
                    $group: {
                        _id: {
                            $cond: [
                                { $ifNull: ["$scheduling.scheduledFor", false] },
                                "scheduled",
                                "queued",
                            ],
                        },
                        count: { $sum: 1 },
                    },
                },
            ]),

            // Visit-only trips still waiting for the office to confirm the
            // figure. The tab used to count every visit charge ever
            // raised, which is a total - not something anybody has to do.
            Payment.countDocuments({ isVisitCharge: true, status: "collected" }),

            // Technicians whose balance is not square. Somebody has to
            // collect from them or pay them, and until this was counted
            // here the wallet tab only admitted to it once it was opened.
            technicianModel.countDocuments({ isDeleted: false, walletBalancePaise: { $ne: 0 } }),

            // Applications waiting to be approved. The same filter the
            // Applications tab lists by, so the badge and the list agree.
            technicianModel.countDocuments({ approvalStatus: "pending", isBlacklisted: false }),
        ]);

        const byStatus = {};
        ticketStats.forEach((s) => { byStatus[s._id] = s.count; });

        const bucket = (status, isCash) =>
            paymentGroups.find((g) => g._id.status === status && g._id.isCash === isCash) || {};

        const verifyCash = bucket("collected", true);
        const verifyOnline = bucket("collected", false);
        const verifyCount = (verifyCash.count || 0) + (verifyOnline.count || 0);

        // Raised but not paid at all yet - the customer still owes the bill.
        const pendingCash = bucket("pending", true);
        const pendingOnline = bucket("pending", false);
        const awaitingCount = (pendingCash.count || 0) + (pendingOnline.count || 0);
        const awaitingPaise = (pendingCash.totalPaise || 0) + (pendingOnline.totalPaise || 0);

        const queuedBy = {};
        queuedSplit.forEach((q) => { queuedBy[q._id] = q.count; });

        const activeCount =
            (byStatus.Assigned || 0) + (byStatus["In-Progress"] || 0) + (byStatus["Payment-Pending"] || 0);

        return res.status(200).json({
            success: true,
            data: {
                tickets: {
                    pending: byStatus.Pending || 0,
                    rejected: rejectedCount,
                    // Booked for a date. "Next up" is the same status with
                    // no date on it, which is a different queue and a
                    // different tab.
                    scheduled: queuedBy.scheduled || 0,
                    queued: queuedBy.queued || 0,
                    assigned: byStatus.Assigned || 0,
                    inProgress: byStatus["In-Progress"] || 0,
                    paymentPending: byStatus["Payment-Pending"] || 0,
                    closed: byStatus.Closed || 0,
                    cancelled: byStatus.Cancelled || 0,
                    today: todayCount,
                },

                technicians: techStats[0] || { total: 0, available: 0, onJob: 0 },

                // The whole queue - this is the badge number
                toVerify: {
                    count: verifyCount,
                    amountDisplay: paiseToRupees((verifyCash.totalPaise || 0) + (verifyOnline.totalPaise || 0)),
                },

                // Online only: money that reached the company account and has
                // to be matched against the statement. Cash never entered the
                // account, so it is not part of this card.
                awaitingReconcile: {
                    count: verifyOnline.count || 0,
                    amountDisplay: paiseToRupees(verifyOnline.totalPaise || 0),
                },

                awaitingPayment: {
                    count: awaitingCount,
                    amountDisplay: paiseToRupees(awaitingPaise),
                },

                cashWithTechnicians: {
                    count: cashHeld[0]?.count || 0,
                    amountDisplay: paiseToRupees(cashHeld[0]?.totalPaise || 0),
                },

                // Cash bills waiting to be checked. This said "cash" and
                // returned the online figure, which is how the two numbers
                // could never be added up correctly by anyone reading them.
                unverifiedCash: {
                    count: verifyCash.count || 0,
                    amountDisplay: paiseToRupees(verifyCash.totalPaise || 0),
                },

                // Every badge in the panel, counted in one place.
                //
                // Each screen used to work its own tab numbers out of the list
                // it had just fetched, so a tab only knew what was waiting on
                // it once somebody opened it - the wallet stayed silent about
                // a record that needed saving until you were already standing
                // on the wallet tab, which is too late to be told.
                badges: {
                    ticketsNew: Math.max(0, (byStatus.Pending || 0) - rejectedCount),
                    ticketsReturned: rejectedCount,
                    ticketsQueued: queuedBy.queued || 0,
                    ticketsScheduled: queuedBy.scheduled || 0,
                    ticketsActive: activeCount,

                    // Cash and visits are counted separately as well as inside
                    // the queue, because the tabs that hold them are the ones
                    // the office actually works from.
                    paymentsToVerify: verifyCount,
                    paymentsCash: verifyCash.count || 0,
                    paymentsOnline: pendingOnline.count || 0,
                    paymentsVisits: visitsToCheck,
                    wallets: walletsToSettle,

                    // Somebody has applied and cannot sign in until the office
                    // says yes. This had no badge anywhere - the sidebar was
                    // silent and the tab counted it out of its own list.
                    techniciansPending: techApplications,
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
        } else if (status === "returned") {
            // Came back after being assigned - a technician could not do it,
            // or the customer refused once they heard the price. These need a
            // decision rather than an assignment, and mixing them in with
            // never-touched requests is how they got assigned again blindly.
            filter = { status: "Pending", "rejection.reason": { $exists: true } };
        } else if (status === "Pending") {
            // Genuinely new: nobody has been out to these yet
            filter = { status: "Pending", "rejection.reason": { $exists: false } };
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
                .select("ticketNumber channel serviceLabel serviceKey selectedIssues problemDescription customerSnapshot status technicianSnapshot scheduling rejection cancelReason billing.totalPaise payment.status createdAt assignedAt queuedAt updatedAt")
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
        const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

        // Two ways to find someone, because the geo search comes up empty more
        // often than you would like - a customer outside the usual radius, or
        // a technician who has never opened the app and so has no coordinates
        // at all. The area search reaches those; it matches what they typed
        // when they registered rather than where their phone last was.
        const mode = req.query.mode === "area" ? "area" : "nearby";
        const radius = Math.min(100000, Math.max(1000, Number(req.query.radius) || 15000));
        const skillRegex = buildSkillRegex(ticket.serviceKey);

        // Busy technicians are included so the admin can queue behind them.
        // Deleted ones stay out.
        const matchQuery = { isDeleted: false };
        if (skillRegex) matchQuery.skills = { $regex: skillRegex };

        const PROJECTION = {
            name: 1, phone: 1, profileImage: 1, skills: 1, rating: 1,
            completedJobs: 1, performanceLevel: 1, city: 1, area: 1, state: 1, pincode: 1,
            hasVehicle: 1, lastLocationAt: 1, isAvailable: 1, activeTicket: 1,
        };

        let technicians;
        let searchTerm = "";

        if (mode === "area") {
            searchTerm = String(req.query.q || ticket.customerSnapshot?.area || "").trim();

            // A WhatsApp booking is a dropped pin with no address text on it,
            // so `area` is usually empty and the panel would open blank. Ask
            // the geocoder which city that pin is in: technicians register
            // with a city name far more often than a locality, so the city is
            // the term most likely to match somebody.
            if (!searchTerm && hasCoords) {
                try {
                    const place = (await lookupPlace(lat, lon))?.results?.[0];
                    searchTerm = String(place?.city || place?.locality || place?.state || "").trim();
                } catch (err) {
                    // A name we could not resolve is not worth failing over -
                    // the admin can type one.
                    console.error("Assign panel place lookup failed:", err.message);
                }
            }

            if (!searchTerm) searchTerm = String(ticket.customerSnapshot?.state || "").trim();

            if (!searchTerm) {
                return res.status(400).json({
                    success: false,
                    message: "Type a city or pincode to search.",
                });
            }

            const term = new RegExp(escapeRegex(searchTerm), "i");
            const rows = await technicianModel
                .find({ ...matchQuery, $or: [{ city: term }, { state: term }, { pincode: term }] })
                .select({ ...PROJECTION, location: 1 })
                .limit(20)
                .lean();

            // No $geoNear here, so distance is worked out in JS - and only for
            // the ones that actually have a position to measure from.
            technicians = rows.map((t) => {
                const tLon = t.location?.coordinates?.[0];
                const tLat = t.location?.coordinates?.[1];
                if (!hasCoords || !Number.isFinite(tLat) || !Number.isFinite(tLon)) return t;
                const metres = Math.round(metresBetween(lat, lon, tLat, tLon));
                return { ...t, distanceInMeters: metres, distanceKm: Math.round(metres / 10) / 100 };
            });
        } else {
            if (!hasCoords) {
                return res.status(400).json({
                    success: false,
                    message: "Customer location missing on this ticket. Search by area instead.",
                });
            }

            technicians = await technicianModel.aggregate([
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
                        ...PROJECTION,
                        // Kept only long enough to ask for a road distance
                        // below, then dropped - the panel has no use for a
                        // technician's exact position and should not carry it
                        location: 1,
                        distanceInMeters: { $round: ["$distanceInMeters", 0] },
                        distanceKm: { $round: [{ $divide: ["$distanceInMeters", 1000] }, 2] },
                    },
                },
            ]);
        }

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

        /*
         * A real road figure for the few the office will actually look at.
         *
         * The ranking above is straight line, which is free and almost always
         * the same order. It is a poor thing to dispatch on, though - eight
         * hundred metres away across a river is not near - so the nearest
         * handful get an actual driving distance and time, in one request.
         *
         * Capped on purpose. Route Matrix bills per pair, so asking for all
         * twenty rows would bill twenty every time this screen opened, for
         * names nobody was going to click. Five is what fits on the screen
         * without scrolling, which is the same five somebody chooses from.
         */
        const measurable = withStatus
            .map((t, at) => ({ at, t }))
            .filter(({ t }) =>
                Number.isFinite(t.location?.coordinates?.[1])
                && Number.isFinite(t.location?.coordinates?.[0]))
            .sort((a, b) =>
                (a.t.distanceInMeters ?? Infinity) - (b.t.distanceInMeters ?? Infinity))
            .slice(0, routeService.MATRIX_MAX);

        if (hasCoords && measurable.length) {
            const roads = await routeService.computeRouteMatrix(
                { lat, lon },
                measurable.map(({ t }) => ({
                    lat: t.location.coordinates[1],
                    lon: t.location.coordinates[0],
                }))
            );

            measurable.forEach(({ at }, i) => {
                const road = roads[i];
                if (!road) return;

                withStatus[at].roadMeters = road.distanceMeters;
                withStatus[at].roadSeconds = road.durationSeconds;
                withStatus[at].roadKm = Number.isFinite(road.distanceMeters)
                    ? Math.round(road.distanceMeters / 10) / 100
                    : null;
            });
        }

        // And the positions go no further than this function
        for (const row of withStatus) delete row.location;

        const noLocationCount = await technicianModel.countDocuments({
            isDeleted: false,
            ...(skillRegex ? { skills: { $regex: skillRegex } } : {}),
            "location.coordinates": { $exists: false },
        });

        return res.status(200).json({
            success: true,
            data: withStatus,
            meta: {
                mode,
                searchTerm: mode === "area" ? searchTerm : "",
                searchedRadiusKm: mode === "nearby" ? radius / 1000 : null,
                found: withStatus.length,
                availableNow: withStatus.filter((t) => t.liveStatus === "available").length,
                noLocationSet: noLocationCount,
                customerLocation: hasCoords ? { lat, lon } : null,
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
            return res.status(400).json({ success: false, message: "Invalid ticket or vendor id" });
        }

        const tech = await technicianModel
            .findOne({ _id: technicianId, isDeleted: false })
            .select("name phone profileImage rating isAvailable activeTicket")
            .lean();



        if (!tech) {
            return res.status(404).json({ success: false, message: "Vendor not found" });
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
                message: "This vendor is on another job. Queue it instead?",
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
                    message: "This vendor was just assigned to another job. Refresh and try again.",
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
                // A reassigned ticket must start its ride from scratch. Any
                // ride left on it describes a different technician's drive.
                $unset: { ride: 1 },
            },
            { returnDocument: "after" }
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
            { returnDocument: "after" }
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
            return res.status(400).json({ success: false, message: "Invalid vendor id" });
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
            return res.status(400).json({ success: false, message: "Same vendor already assigned" });
        }

        const newTech = await technicianModel
            .findOne({ _id: technicianId, isDeleted: false })
            .select("name phone profileImage rating activeTicket")
            .lean();

        if (!newTech) {
            return res.status(404).json({ success: false, message: "Vendor not found" });
        }

        const isBusy = Boolean(newTech.activeTicket);
        if (isBusy && !allowQueue) {
            return res.status(409).json({
                success: false,
                message: "This vendor is on another job. Queue it instead?",
                canQueue: true,
            });
        }

        if (!isBusy) {
            const locked = await technicianModel.findOneAndUpdate(
                { _id: technicianId, activeTicket: null, isDeleted: false },
                { isAvailable: false, activeTicket: ticket._id },
                { returnDocument: "after" }
            ).lean();
            if (!locked) {
                return res.status(409).json({ success: false, message: "Selected vendor is no longer available" });
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
            { returnDocument: "after" }
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
/**
 * Rings the customer about one ticket and asks whether today suits them.
 *
 * Started by hand from the ticket rather than fired when the booking lands:
 * the office decides which bookings are worth confirming by phone, and a call
 * placed automatically on every one of them is a cost and a nuisance.
 *
 * Returns as soon as the call is dialling. The conversation takes a minute and
 * its answer arrives on the ticket over the socket, so holding the request
 * open would only leave the admin watching a spinner.
 */
const callCustomer = async (req, res) => {
    try {
        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            status: { $in: ["Pending", "Queued", "Assigned"] },
        }).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found or already closed" });
        }

        const phone = ticket.customerSnapshot?.phone;
        if (!phone) {
            return res.status(400).json({ success: false, message: "This ticket has no phone number" });
        }

        const call = await voiceController.placeCall({ ticket, purpose: "availability" });

        if (!call) {
            return res.status(502).json({
                success: false,
                message: "The call could not be placed. Check the voice settings.",
            });
        }

        await ticketModel.updateOne(
            { _id: ticket._id },
            { $set: { "availabilityCheck.calledAt": new Date(), "availabilityCheck.available": null } }
        );

        return res.status(202).json({
            success: true,
            message: "Calling " + phone + " now. The answer will appear on this ticket.",
        });
    } catch (err) {
        /*
         * The whole error, and the reason said out loud.
         *
         * This used to log err.message and answer "Could not place the call",
         * which is the same sentence for a bad number, an Exotel rejection and
         * a bug in our own code - so a 500 in the panel told the office
         * nothing and told us nothing either. There is no customer on the far
         * side of this route; it is the backoffice asking the system why it
         * would not do something, and the answer belongs on their screen.
         */
        console.error("callCustomer failed for ticket " + req.params.id + ":", err);

        return res.status(500).json({
            success: false,
            message: "Could not place the call: " + (err.message || "unknown error"),
        });
    }
};

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
                message: "Pick a vendor for this date before rescheduling",
            });
        }

        const tech = await technicianModel
            .findOne({ _id: targetTechnicianId, isDeleted: false, isBlacklisted: false })
            .select("name phone profileImage rating activeTicket")
            .lean();

        if (!tech) {
            return res.status(404).json({ success: false, message: "Vendor not found" });
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

/**
 * POST /api/admin/tickets/:id/refusal   { decision: "agreed" | "declined", note }
 *
 * The customer said no to the price and the technician is waiting on their
 * doorstep while the office rings them back. This is the answer.
 *
 * "agreed" clears the hold and he carries straight on - which is the whole
 * point of keeping him there rather than sending him away and arranging a
 * second visit. "declined" ends the job, and he raises the visit charge for
 * the trip before leaving.
 *
 * Either way the decision is the office's. The technician can report what
 * happened; he cannot close the job himself.
 */
const resolveRefusal = async (req, res) => {
    try {
        const decision = req.body.decision === "agreed" ? "customer_agreed" : "customer_declined";
        const note = String(req.body.note || "").trim().slice(0, 300);

        const updated = await ticketModel.findOneAndUpdate(
            { _id: req.params.id, "refusal.status": "awaiting_verification" },
            {
                "refusal.status": decision,
                "refusal.verifiedBy": req.admin._id,
                "refusal.verifiedByName": req.admin.name,
                "refusal.verifiedAt": new Date(),
                "refusal.officeNote": note || undefined,
                $push: {
                    statusHistory: {
                        from: "In-Progress",
                        to: "In-Progress",
                        actorRole: "admin",
                        actorId: req.admin._id,
                        reason: decision === "customer_agreed"
                            ? "Office spoke to the customer, going ahead" + (note ? ": " + note : "")
                            : "Office spoke to the customer, not going ahead" + (note ? ": " + note : ""),
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        if (!updated) {
            return res.status(404).json({
                success: false,
                message: "This ticket isn't waiting on a customer call",
            });
        }

        notification.notifyTechnicianRefusalResolved(updated, decision, note);

        return res.status(200).json({
            success: true,
            message: decision === "customer_agreed"
                ? "Technician told to carry on"
                : "Technician told to take the visit charge and leave",
            data: updated,
        });
    } catch (error) {
        console.error("Resolve refusal error:", error);
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
            { returnDocument: "after" }
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
            filter.isDeleted = false;
        } else if (approval === "blocked") {
            filter.isBlacklisted = true;
            filter.isDeleted = false;
        } else if (approval === "rejected") {
            filter.approvalStatus = "rejected";
            filter.isDeleted = false;
        } else if (approval === "deleted") {
            // The recycle bin. Everything else on this screen hides these.
            filter.isDeleted = true;
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
                { city: { $regex: safe, $options: "i" } },
            ];
        }

        const [technicians, total] = await Promise.all([
            technicianModel
                .find(filter)
                .select("name phone profileImage skills rating completedJobs performanceLevel city area state isAvailable availabilitySince lastAwayMs activeTicket hasVehicle lastLocationAt location approvalStatus isBlacklisted isDeleted deletedAt createdAt")
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            technicianModel.countDocuments(filter),
        ]);

        const data = technicians.map((t) => ({
            ...t,
            liveStatus: t.activeTicket ? "on_job" : t.isAvailable ? "available" : "offline",
            hasLocation: Array.isArray(t.location?.coordinates) && t.location.coordinates.length === 2,
        }));

        return res.status(200).json({
            success: true,
            data,
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
            return res.status(404).json({ success: false, message: "Vendor not found" });
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
            return res.status(404).json({ success: false, message: "Vendor not found or already reviewed" });
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
            return res.status(404).json({ success: false, message: "Vendor not found" });
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

        /*
         * The REST session dies on his next request, because the auth
         * middleware rechecks this flag every time. A socket does not: it was
         * authorised once, when it opened, and would sit there reporting him
         * as reachable until the app happened to close. So it is cut here.
         */
        dropRoom(techRoom(req.params.id));

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
            return res.status(404).json({ success: false, message: "Vendor not found or not blocked" });
        }

        return res.status(200).json({
            success: true,
            message: updated.name + " unblocked. Approve them to restore access.",
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
            return res.status(400).json({ success: false, message: "Invalid vendor id" });
        }

        const [technician, activeTicket, scheduled, recentJobs, cashHeld, totalEarnings] = await Promise.all([
            technicianModel.findById(id)
                .select("name phone email profileImage skills rating completedJobs performanceLevel city area state pincode isAvailable activeTicket hasVehicle lastLocationAt location isDeleted createdAt approvalStatus isBlacklisted blacklistReason rejectionReason approvedAt walletBalancePaise commissionRate bankDetails.accountHolderName bankDetails.accountNumber bankDetails.accountLast4 bankDetails.ifsc bankDetails.bankName bankDetails.branch")
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
            return res.status(404).json({ success: false, message: "Vendor not found" });
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
/**
 * What the company actually keeps out of one job, end to end.
 *
 * The commission on its own is not the earning. Razorpay takes a cut on the
 * way in, and which side pays it depends on how the customer paid:
 *
 *   cash   - the customer handed over notes, so nothing was lost there. The
 *            technician then sends the commission back over Razorpay, and the
 *            gateway takes 2% (plus GST on that fee) of the commission.
 *   online - the customer paid through the gateway, so the fee came off the
 *            whole bill before the money ever reached the account. The
 *            technician's share is paid out by bank transfer afterwards.
 *
 * So there are two possible gateway hits and never both. Netting them off the
 * commission is the only figure that answers "what did we earn on this job".
 *
 * The technician-side number is an estimate until the settlement webhook
 * lands: the commission has not been sent yet at the moment the office is
 * looking at the card.
 */
const settlementFor = (payment, billing) => {
    const isCash = payment.method === "cash";
    const grossPaise = payment.amountPaise || 0;
    const commissionPaise = payment.commissionPaise || 0;

    // Already charged and recorded by the webhook, on the customer's payment
    const customerGatewayPaise = (payment.gatewayFeePaise || 0) + (payment.gatewayTaxPaise || 0);

    // Still to come, on the technician's commission transfer
    const onCommission = isCash ? estimateGatewayFee(commissionPaise) : { feePaise: 0, taxPaise: 0 };
    const technicianGatewayPaise = onCommission.feePaise + onCommission.taxPaise;

    // The bill already charged the customer GST, so part of the commission is
    // tax the company collected on the government's behalf rather than margin.
    const billTotalPaise = billing.totalPaise || grossPaise;
    const gstInCommissionPaise = billTotalPaise > 0
        ? Math.round((commissionPaise * (billing.gstPaise || 0)) / billTotalPaise)
        : 0;

    return {
        collectedIn: isCash ? "cash" : "online",
        grossDisplay: paiseToRupees(grossPaise),

        commissionPercent: payment.commissionPercent ?? null,
        commissionDisplay: paiseToRupees(commissionPaise),
        gstInCommissionDisplay: paiseToRupees(gstInCommissionPaise),
        technicianShareDisplay: paiseToRupees(payment.technicianSharePaise || 0),

        gatewayPercent: GATEWAY_FEE_PERCENT,
        customerGatewayDisplay: paiseToRupees(customerGatewayPaise),
        technicianGatewayDisplay: paiseToRupees(technicianGatewayPaise),
        technicianGatewayIsEstimate: isCash && commissionPaise > 0,
        gatewayTotalDisplay: paiseToRupees(customerGatewayPaise + technicianGatewayPaise),

        netEarningPaise: commissionPaise - customerGatewayPaise - technicianGatewayPaise,
        netEarningDisplay: paiseToRupees(commissionPaise - customerGatewayPaise - technicianGatewayPaise),
    };
};

/**
 * Mongo's own $round breaks ties towards the even number, while Math.round -
 * which estimateGatewayFee uses - breaks them upwards. Adding a half and
 * flooring is Math.round exactly, on the same doubles, so the aggregate and
 * the per-job figure can never disagree.
 */
const roundHalfUp = (expr) => ({ $floor: { $add: [expr, 0.5] } });

/** The same netting as settlementFor, rolled up across every paid job. */
const earningsFrom = (row) => {
    const commissionPaise = row?.commissionPaise || 0;
    const customerGatewayPaise = row?.customerGatewayPaise || 0;
    const technicianGatewayPaise = row?.technicianGatewayPaise || 0;
    const netPaise = commissionPaise - customerGatewayPaise - technicianGatewayPaise;

    return {
        commissionDisplay: paiseToRupees(commissionPaise),
        customerGatewayDisplay: paiseToRupees(customerGatewayPaise),
        technicianGatewayDisplay: paiseToRupees(technicianGatewayPaise),
        gatewayTotalDisplay: paiseToRupees(customerGatewayPaise + technicianGatewayPaise),
        netDisplay: paiseToRupees(netPaise),
        gatewayPercent: GATEWAY_FEE_PERCENT,
    };
};

/**
 * Narrows a payment list down to what someone typed into the search box.
 *
 * A payment does not carry the technician's name - only an id, and on an
 * online payment not even that, because the gateway settled it rather than a
 * person. So the name is resolved to technicians first, then to their
 * tickets, and the payment is matched on either. The invoice and ticket
 * numbers go in too: a box that ignores an invoice number pasted into it is
 * more annoying than no box at all.
 */
const paymentSearchFilter = async (term) => {
    const text = String(term || "").trim();
    if (text.length < 2) return null;

    const rx = new RegExp(escapeRegex(text), "i");

    const techIds = (
        await technicianModel.find({ name: rx }).select("_id").lean()
    ).map((t) => t._id);

    const ticketIds = (
        await ticketModel
            .find({
                $or: [
                    ...(techIds.length ? [{ technician: { $in: techIds } }] : []),
                    { "technicianSnapshot.name": rx },
                    { "customerSnapshot.name": rx },
                    { ticketNumber: rx },
                ],
            })
            .select("_id")
            .lean()
    ).map((t) => t._id);

    return {
        $or: [
            ...(techIds.length ? [{ collectedBy: { $in: techIds } }] : []),
            ...(ticketIds.length ? [{ ticket: { $in: ticketIds } }] : []),
            { invoiceNumber: rx },
            { ticketNumber: rx },
            { razorpayPaymentId: rx },
        ],
    };
};

const getPayments = async (req, res) => {
    try {
        const status = req.query.status || "all";
        const method = req.query.method;
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(50, Number(req.query.limit) || 20);

        // A technician sending his commission back is not a bill, and it was
        // never something to work through on its own: it is the evidence that
        // a cash job has been paid for, and it belongs on that job's row.
        // Listing it here gave the office a second card for the same money,
        // with no customer and no ticket on it, and nothing sensible to do
        // with it. It is still recorded - the Check payment button and the
        // reference list in the wallet both read it - just not queued.
        const filter = { ticket: { $ne: null } };
        if (status !== "all") filter.status = status;
        if (method === "cash") filter.method = "cash";
        else if (method === "online") filter.method = { $ne: "cash" };

        // Trips where the customer refused and only the visit was billed.
        // Worth their own list: a technician who keeps coming back with just
        // a visit charge is either being sent to the wrong jobs or quoting
        // in a way nobody accepts.
        if (req.query.kind === "visit") filter.isVisitCharge = true;
        else if (req.query.kind === "jobs") filter.isVisitCharge = { $ne: true };

        // The headline cards stay on the whole business - only the list below
        // narrows - so the office can search one technician without losing
        // sight of what is outstanding overall.
        const search = await paymentSearchFilter(req.query.search);
        if (search) Object.assign(filter, search);

        const [payments, total, summary, earnings] = await Promise.all([
            // The ticket carries everything the office needs to check a bill
            // against: who the customer is, where the job was, what the
            // technician actually charged for, and the name frozen at
            // assignment. The payment row on its own is just an amount.
            Payment.find(filter)
                .populate("collectedBy", "name phone")
                .populate("verifiedBy", "name")
                .populate("ticket", "ticketNumber serviceLabel customerSnapshot location billing technicianSnapshot technician payment")
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),

            Payment.countDocuments(filter),

            Payment.aggregate([
                { $match: { ticket: { $ne: null } } },
                {
                    $group: {
                        _id: { status: "$status", isCash: { $eq: ["$method", "cash"] } },
                        count: { $sum: 1 },
                        totalPaise: { $sum: "$amountPaise" },
                    },
                },
            ]),

            // Commission is what the company charged; it is not what the
            // company kept. The gateway lands on a different side depending
            // on how the customer paid - see settlementFor.
            //
            // The technician-side fee is rounded per job here rather than once
            // on the total, so this strip and the cards underneath it add up
            // to the same number. Rounding the sum instead drifted a few paise
            // away from the rows, which is exactly the sort of gap that makes
            // an office stop trusting the screen.
            Payment.aggregate([
                { $match: { ticket: { $ne: null }, status: { $in: ["collected", "verified"] } } },
                {
                    $addFields: {
                        techFeePaise: {
                            $cond: [
                                { $eq: ["$method", "cash"] },
                                roundHalfUp({ $divide: [{ $multiply: [{ $ifNull: ["$commissionPaise", 0] }, GATEWAY_FEE_PERCENT] }, 100] }),
                                0,
                            ],
                        },
                    },
                },
                {
                    $group: {
                        _id: null,
                        commissionPaise: { $sum: "$commissionPaise" },
                        technicianGatewayPaise: {
                            $sum: { $add: ["$techFeePaise", roundHalfUp({ $divide: [{ $multiply: ["$techFeePaise", 18] }, 100] })] },
                        },
                        customerGatewayPaise: {
                            $sum: { $add: [{ $ifNull: ["$gatewayFeePaise", 0] }, { $ifNull: ["$gatewayTaxPaise", 0] }] },
                        },
                    },
                },
            ]),
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
            data: payments.map((p) => {
                const t = p.ticket || {};
                const customer = t.customerSnapshot || {};
                const billing = t.billing || {};

                return {
                    ...p,
                    // Keep the id only - the full ticket is unpacked below, and
                    // sending it twice doubles the payload for no gain.
                    ticket: t._id || p.ticket || null,

                    amountDisplay: paiseToRupees(p.amountPaise),
                    commissionDisplay: paiseToRupees(p.commissionPaise || 0),
                    technicianShareDisplay: paiseToRupees(p.technicianSharePaise || 0),
                    gatewayFeeDisplay: paiseToRupees((p.gatewayFeePaise || 0) + (p.gatewayTaxPaise || 0)),

                    settlement: settlementFor(p, billing),

                    // collectedBy is empty on an online payment, because the
                    // gateway settled it rather than a person. The ticket's
                    // snapshot still names who did the work.
                    technicianName: p.collectedBy?.name || t.technicianSnapshot?.name || null,
                    technicianPhone: p.collectedBy?.phone || t.technicianSnapshot?.phone || null,

                    // Lets a cash bill open the right wallet in one click
                    // instead of dropping the office on a list of names.
                    technicianId: p.collectedBy?._id || t.technician || null,

                    serviceLabel: t.serviceLabel || null,

                    customer: {
                        name: customer.name || null,
                        phone: customer.phone || null,
                        address: customer.address || customer.area || null,
                        area: customer.area || null,
                        landmark: customer.landmark || null,
                        lat: customer.lat ?? t.location?.coordinates?.[1] ?? null,
                        lon: customer.lon ?? t.location?.coordinates?.[0] ?? null,
                    },

                    // Two halves of one bill. Showing a single amount would
                    // not say whether both of them actually arrived.
                    split: t.payment?.split?.companyOnlinePaise
                        ? {
                              technicianCashDisplay: paiseToRupees(t.payment.split.technicianCashPaise || 0),
                              companyOnlineDisplay: paiseToRupees(t.payment.split.companyOnlinePaise || 0),
                              onlinePaidAt: t.payment.split.onlinePaidAt || null,
                              cashConfirmedAt: t.payment.split.cashConfirmedAt || null,
                          }
                        : null,

                    // Every correction the technician made before the customer
                    // paid, so one honest slip is visibly different from a bill
                    // that got rewritten three times.
                    billEdits: (billing.editHistory || []).map((e) => ({
                        at: e.at,
                        reason: e.reason,
                        fromDisplay: paiseToRupees(e.fromTotalPaise || 0),
                        toDisplay: paiseToRupees(e.toTotalPaise || 0),
                    })),

                    bill: {
                        workDone: billing.workDone || null,
                        lineItems: (billing.lineItems || []).map((i) => ({
                            description: i.description,
                            amountDisplay: paiseToRupees(i.amountPaise),
                        })),
                        subtotalDisplay: paiseToRupees(billing.subtotalPaise || 0),
                        gstPercent: billing.gstPercent || 0,
                        gstDisplay: paiseToRupees(billing.gstPaise || 0),
                        totalDisplay: paiseToRupees(billing.totalPaise || 0),
                    },
                };
            }),
            summary: totals,
            earnings: earningsFrom(earnings[0]),
            searched: Boolean(search),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error("Get payments error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * Turns any settlement link this technician has actually paid into a real
 * settlement row, without waiting for the webhook.
 *
 * The webhook is the normal way this happens, and it is not always available:
 * it cannot reach a server running on somebody's laptop, and in production it
 * can be late or dropped. That left the office looking at a technician who
 * had genuinely paid and a screen that said nothing had come in.
 *
 * So the office's check goes and asks. The claim is the same atomic upsert on
 * the payment id that the webhook uses, so whichever of the two gets there
 * first wins and the other finds the row already made - the money can never
 * be recorded twice.
 */
const claimSettlement = async (technicianId, { paymentId, amountPaise, linkId, paidAt }) => {
    try {
        await Payment.findOneAndUpdate(
            { ticket: null, razorpayPaymentId: paymentId },
            {
                $setOnInsert: {
                    ticket: null,
                    amountPaise,
                    method: "online",
                    status: "collected",
                    collectedBy: technicianId,
                    collectedAt: paidAt || new Date(),
                    razorpayPaymentId: paymentId,
                    razorpayLinkId: linkId || null,
                    note: "Technician commission settlement",
                },
            },
            { upsert: true }
        );
    } catch (err) {
        // A webhook landing at the same instant took the row first
        if (err.code !== 11000) throw err;
    }
};

/**
 * Everything this technician has paid us at Razorpay in the last month,
 * whether or not we ever wrote the link down.
 *
 * Storing the link covers payments made from now on. It does nothing for the
 * ones already sitting at the gateway from before, or for a link created by a
 * server that has since been restarted - and those are real money the office
 * simply cannot see. Every settlement carries our own note on it (its type,
 * and whose it is), so the gateway can be asked directly rather than guessed
 * at.
 *
 * A failure here is not fatal. The stored-link path still works, and an office
 * that gets an error instead of an answer is worse off than one that gets the
 * answer the local records can give.
 */
const sweepGatewayForSettlements = async (technicianId) => {
    try {
        // A settlement is evidence against a due. If his balance is square
        // there is no due, and every captured payment of his still sitting at
        // the gateway is money that was dealt with long ago.
        //
        // Without this the sweep resurrected an old commission payment as a
        // fresh "waiting to be recorded" row every time anybody opened his
        // wallet - including to record a visit charge, which owes nothing.
        // That row then told the technician, on his own phone, that the
        // office was checking money he had paid weeks earlier, and handed the
        // office a row it could not record against anything.
        const tech = await technicianModel
            .findById(technicianId)
            .select("walletBalancePaise")
            .lean();

        if (!tech || (tech.walletBalancePaise || 0) >= 0) return 0;

        const to = Math.floor(Date.now() / 1000);
        let from = to - 30 * 24 * 60 * 60;

        // Money paid before the due existed cannot be paying it. The last
        // ledger line that left him at zero is the moment his slate was last
        // clean, so anything at the gateway older than that was settling a
        // due that has since been cleared - and claiming it again would put
        // somebody else's cleared money on today's job.
        const lastSquare = await WalletTransaction.findOne({
            technician: technicianId,
            balanceAfterPaise: 0,
        })
            .sort({ createdAt: -1 })
            .select("createdAt")
            .lean();

        if (lastSquare) {
            from = Math.max(from, Math.floor(new Date(lastSquare.createdAt).getTime() / 1000));
        }

        const list = await getRazorpay().payments.all({ from, to, count: 100 });

        const his = (list.items || []).filter(
            (x) =>
                x.status === "captured" &&
                x.notes?.type === "wallet_recharge" &&
                String(x.notes.technicianId) === String(technicianId)
        );

        for (const x of his) {
            await claimSettlement(technicianId, {
                paymentId: x.id,
                amountPaise: x.amount,
                linkId: null,
                paidAt: x.created_at ? new Date(x.created_at * 1000) : new Date(),
            });
        }

        return his.length;
    } catch (err) {
        console.error("Gateway settlement sweep failed:", err?.error?.description || err.message);
        return 0;
    }
};

const claimPaidRecharges = async (technicianId) => {
    const openLinks = await Payment.find({
        collectedBy: technicianId,
        ticket: null,
        status: "pending",
        razorpayLinkId: { $nin: [null, ""] },
    })
        .select("razorpayLinkId amountPaise")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

    let claimed = 0;

    for (const row of openLinks) {
        const status = await paymentService.fetchPaymentLinkStatus(row.razorpayLinkId);
        if (!status?.isPaid || !status.paymentId) continue;

        await claimSettlement(technicianId, {
            paymentId: status.paymentId,
            amountPaise: status.amountPaidPaise || row.amountPaise,
            linkId: row.razorpayLinkId,
            paidAt: status.paidAt,
        });

        // The pending row was only a note that a link had been sent
        await Payment.deleteOne({ _id: row._id, status: "pending" });
        claimed += 1;
    }

    return claimed + (await sweepGatewayForSettlements(technicianId));
};

/**
 * POST /api/admin/payments/:id/check
 *
 * "Has the money for this row actually come in?" - answered without anybody
 * typing anything.
 *
 * The office should never have to ring a technician and ask him to read out a
 * payment id. The server already knows which Razorpay payment belongs to the
 * row: an online bill carries its own id, and a cash job is cleared by the
 * settlement that technician sent through the app, which arrives as a payment
 * of its own against his name. So the id is looked up here and checked
 * against the gateway, and the button is just a button.
 */
const checkPaymentMoney = async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.id)
            // collectedAt is when the cash was taken, which is what a
            // settlement has to come after to be for this job
            .select("method status amountPaise commissionPaise razorpayPaymentId ticket collectedBy isVisitCharge collectedAt createdAt")
            .lean();

        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found" });
        }

        if (!razorpayConfigured()) {
            return res.status(503).json({
                success: false,
                message: "Razorpay keys are not set on the server, so nothing can be checked.",
            });
        }

        // Which id to ask about, and what it should come to
        let reference = payment.razorpayPaymentId || null;
        let expectPaise = payment.amountPaise;
        let kind = "bill";
        let alsoWaiting = 0;

        if (reference && payment.ticket) {
            // Only the company's half of a split goes through the gateway
            const t = await ticketModel.findById(payment.ticket)
                .select("payment.method payment.split").lean();
            if (t?.payment?.method === "split") {
                expectPaise = t.payment.split?.companyOnlinePaise || 0;
            }
        }

        // Nothing was owed on this one, so there is nothing at the gateway to
        // go looking for. A visit charge is the case that matters today: the
        // technician kept the whole amount, the company's cut of it is zero,
        // and the only open question is whether the figure was right - which
        // is answered under Wallet, not by Razorpay. This keys off the
        // commission rather than off the trip, so the day a commission on
        // visits is set the ordinary settlement flow takes over on its own.
        if (!reference && !(payment.commissionPaise > 0)) {
            return res.status(200).json({
                success: true,
                message: payment.isVisitCharge
                    ? "Nothing to check with Razorpay. The whole Rs " + paiseToRupees(payment.amountPaise) +
                      " is the technician's and the company takes nothing on a visit - just confirm the figure under Wallet."
                    : "No commission was charged on this one, so there is nothing for the technician to send back.",
                data: { found: false, kind: "none", expectPaise: 0 },
            });
        }

        if (!reference) {
            // A cash job. The money to look for is the commission the
            // technician sends back afterwards, which lands as a settlement
            // against his name rather than against this ticket.
            const technicianId = payment.collectedBy
                || (await ticketModel.findById(payment.ticket).select("technician").lean())?.technician;

            if (!technicianId) {
                return res.status(400).json({
                    success: false,
                    message: "No vendor on this payment, so there is nothing to look for.",
                });
            }

            // Only go out to the gateway when our own records cannot answer.
            // Pressing the button twice should not mean waiting three seconds
            // twice for the same answer.
            const knownWaiting = await Payment.countDocuments({
                collectedBy: technicianId,
                ticket: null,
                status: "collected",
                razorpayPaymentId: { $nin: [null, ""] },
            });

            if (!knownWaiting) await claimPaidRecharges(technicianId);

            const settlements = await Payment.find({
                collectedBy: technicianId,
                ticket: null,
                razorpayPaymentId: { $nin: [null, ""] },
            })
                .select("razorpayPaymentId amountPaise status collectedAt")
                // When the sweep writes several down at once they all share a
                // createdAt, so that ordering is meaningless. collectedAt is
                // when he actually paid, which is what "the latest one" means.
                .sort({ collectedAt: -1 })
                .limit(10)
                .lean();

            /*
             * Which of his payments could actually be for this job.
             *
             * Two filters, and this answered wrongly without either of them -
             * a cash job closed today was reported settled by a payment made
             * four days earlier that had already cleared a different job. The
             * amounts happened to match, and matching amounts was the whole
             * test.
             *
             * First: a settlement already written into the ledger is spent. Its
             * row is supposed to be closed when the office records it, but
             * every row written before that was fixed is still sitting at
             * "collected", so the status alone cannot be trusted - the ledger
             * is asked instead, which repairs the old ones as a side effect.
             *
             * Second: money cannot pay for work that had not happened yet. A
             * settlement sent before this job was closed belongs to an earlier
             * one, whatever it is worth.
             */
            const spent = new Set(
                (await WalletTransaction.find({
                    technician: technicianId,
                    source: "recharge",
                    reference: { $in: settlements.map((x) => x.razorpayPaymentId).filter(Boolean) },
                }).select("reference").lean()).map((x) => x.reference)
            );

            const jobClosedAt = payment.collectedAt || payment.createdAt;

            const unrecorded = settlements.filter((x) =>
                x.status === "collected"
                && !spent.has(x.razorpayPaymentId)
                && (!jobClosedAt || !x.collectedAt || new Date(x.collectedAt) >= new Date(jobClosedAt))
            );

            const waiting = unrecorded.find((x) => x.amountPaise === (payment.commissionPaise || 0))
                || unrecorded[0];

            alsoWaiting = Math.max(0, unrecorded.length - 1);

            if (!waiting) {
                return res.status(200).json({
                    success: true,
                    message: "Nothing has come in for this job yet. Anything this vendor sent earlier has"
                        + " already been recorded against older work. Check again once he says he has paid.",
                    data: { found: false, kind: "settlement", expectPaise: payment.commissionPaise || 0 },
                });
            }

            reference = waiting.razorpayPaymentId;
            expectPaise = payment.commissionPaise || 0;
            kind = "settlement";
        }

        let charge;
        try {
            charge = await getRazorpay().payments.fetch(reference);
        } catch (err) {
            const notFound = err?.statusCode === 400 || err?.statusCode === 404;
            return res.status(notFound ? 400 : 502).json({
                success: false,
                message: notFound
                    ? "Razorpay has no payment with the id " + reference + ". This money did not come through."
                    : "Could not reach Razorpay just now. Try again in a moment.",
            });
        }

        const captured = charge.status === "captured";

        // Same as the old Verify button putting a name against the row: an
        // answer with nobody's name on it cannot be followed up a week later.
        const gatewayCheck = {
            checkedAt: new Date(),
            status: charge.status,
            amountPaise: charge.amount,
            expectedPaise: expectPaise,
            methodUsed: charge.method || null,
            matched: captured,
            checkedBy: req.admin?._id || null,
            checkedByName: req.admin?.name || null,
        };

        await Payment.updateOne({ _id: req.params.id }, { gatewayCheck });

        // A settlement often clears several jobs at once, so it has to cover
        // this one rather than equal it. A bill is checked to the rupee.
        const covers = kind === "settlement"
            ? charge.amount >= expectPaise
            : charge.amount === expectPaise;

        return res.status(200).json({
            success: true,
            message: !captured
                ? "Razorpay says this is \"" + charge.status + "\", not captured. The money is not in the account."
                : kind === "settlement"
                    ? covers
                        ? "Rs " + paiseToRupees(charge.amount) + " came in from this technician"
                          + (charge.method ? " by " + charge.method : "")
                          + " - covers the Rs " + paiseToRupees(expectPaise) + " on this job."
                          + (alsoWaiting > 0
                              ? " " + alsoWaiting + " more payment" + (alsoWaiting === 1 ? " is" : "s are")
                                + " waiting to be recorded in his wallet."
                              : "")
                        : "Only Rs " + paiseToRupees(charge.amount) + " has come in, and this job's commission is Rs "
                          + paiseToRupees(expectPaise) + "."
                    : covers
                        ? "Paid, Rs " + paiseToRupees(charge.amount) + " captured"
                          + (charge.method ? " by " + charge.method : "")
                        : "Captured, but for Rs " + paiseToRupees(charge.amount)
                          + " - this bill is Rs " + paiseToRupees(expectPaise) + ".",
            data: {
                found: true,
                kind,
                reference,
                status: charge.status,
                captured,
                covers,
                settled: captured && covers,
                amountPaise: charge.amount,
                amountDisplay: paiseToRupees(charge.amount),
                methodUsed: charge.method || null,
                expectPaise,
                expectDisplay: paiseToRupees(expectPaise),
                alsoWaiting,
                paidAt: charge.created_at ? new Date(charge.created_at * 1000) : null,
                checkedByName: gatewayCheck.checkedByName,
                checkedAt: gatewayCheck.checkedAt,
            },
        });
    } catch (error) {
        console.error("Check payment money error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/admin/payments/check-reference   { reference, expectPaise }
 *
 * Asks Razorpay whether a reference is real, and changes nothing.
 *
 * The office wants the same question answered on every row in the queue -
 * a technician clearing his due, a customer's UPI payment, the online half
 * of a split - before anything is recorded anywhere. Only some of those rows
 * carry an id of their own, so a check that can only run against a stored id
 * covers half the queue. This one takes the reference itself.
 */
const checkPaymentReference = async (req, res) => {
    try {
        const reference = String(req.body.reference || "").trim();

        if (reference.length < 6) {
            return res.status(400).json({ success: false, message: "Enter the Razorpay payment id to check" });
        }

        if (!razorpayConfigured()) {
            return res.status(503).json({
                success: false,
                message: "Razorpay keys are not set on the server, so the reference cannot be checked.",
            });
        }

        let charge;
        try {
            charge = await getRazorpay().payments.fetch(reference);
        } catch (err) {
            const notFound = err?.statusCode === 400 || err?.statusCode === 404;
            return res.status(notFound ? 400 : 502).json({
                success: false,
                message: notFound
                    ? "Razorpay has no payment with the id " + reference + ". This money did not come through."
                    : "Could not reach Razorpay just now. Try again in a moment.",
            });
        }

        const expectPaise = Number(req.body.expectPaise) || 0;
        const captured = charge.status === "captured";
        const amountsAgree = !expectPaise || charge.amount === expectPaise;

        return res.status(200).json({
            success: true,
            message: captured
                ? amountsAgree
                    ? "Paid, Rs " + paiseToRupees(charge.amount) + " captured"
                      + (charge.method ? " by " + charge.method : "")
                    : "Captured, but for Rs " + paiseToRupees(charge.amount)
                      + " - you are recording Rs " + paiseToRupees(expectPaise)
                : "Razorpay says this is \"" + charge.status + "\", not captured. The money is not in the account.",
            data: {
                reference,
                status: charge.status,
                captured,
                amountPaise: charge.amount,
                amountDisplay: paiseToRupees(charge.amount),
                methodUsed: charge.method || null,
                expectPaise: expectPaise || null,
                amountsAgree,
                paidAt: charge.created_at ? new Date(charge.created_at * 1000) : null,
            },
        });
    } catch (error) {
        console.error("Check reference error:", error);
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
 *
 * The button asks Razorpay rather than taking the row's word for it. Pressing
 * Verify used to do nothing except write "verified" next to a reference
 * nobody had looked at, so a webhook that fired on the wrong amount, or a
 * payment that was later refunded, still read as reconciled. Now the id is
 * fetched, the captured amount is compared against the invoice, and the
 * answer is stored on the payment so the screen can show what was checked and
 * when - and by whom.
 */
const verifyPayment = async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.id)
            .select("method status amountPaise razorpayPaymentId ticket")
            .lean();

        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found" });
        }

        if (payment.method === "cash") {
            return res.status(400).json({
                success: false,
                message: "Cash goes to the vendor, not the company. Settle the commission in Wallets instead.",
            });
        }

        if (payment.status !== "collected") {
            return res.status(400).json({ success: false, message: "Already reconciled" });
        }

        if (!payment.razorpayPaymentId) {
            return res.status(400).json({
                success: false,
                message: "No Razorpay reference on this payment yet, so there is nothing to check. "
                    + "It has not come through the gateway.",
            });
        }

        if (!razorpayConfigured()) {
            return res.status(503).json({
                success: false,
                message: "Razorpay keys are not set on the server, so the reference cannot be checked.",
            });
        }

        // On a split the payment row carries the whole bill, because that is
        // what the customer was billed - but the technician took his share in
        // cash at the door and only the company's half ever went through the
        // gateway. Comparing the gateway against the full bill would reject
        // every split as a mismatch.
        const splitTicket = payment.ticket
            ? await ticketModel.findById(payment.ticket).select("payment.method payment.split").lean()
            : null;

        const isSplit = splitTicket?.payment?.method === "split";
        const expectedPaise = isSplit
            ? (splitTicket.payment.split?.companyOnlinePaise || 0)
            : payment.amountPaise;

        let charge;
        try {
            charge = await getRazorpay().payments.fetch(payment.razorpayPaymentId);
        } catch (err) {
            const notFound = err?.statusCode === 400 || err?.statusCode === 404;
            return res.status(notFound ? 400 : 502).json({
                success: false,
                message: notFound
                    ? "Razorpay does not have a payment with the id " + payment.razorpayPaymentId
                      + ". Nothing has been marked verified."
                    : "Could not reach Razorpay to check this reference. Try again in a moment.",
            });
        }

        // "captured" is the only state where the money is actually ours.
        // Authorized means it is on hold, refunded means it went back.
        const gatewayCheck = {
            checkedAt: new Date(),
            status: charge.status,
            amountPaise: charge.amount,
            methodUsed: charge.method || null,
            matched: charge.status === "captured" && charge.amount === expectedPaise,
            expectedPaise,
        };

        if (charge.status !== "captured") {
            await Payment.updateOne({ _id: req.params.id }, { gatewayCheck });
            return res.status(400).json({
                success: false,
                message: "Razorpay says this payment is \"" + charge.status + "\", not captured. "
                    + "The money is not in the account, so it has not been verified.",
                data: { gatewayCheck },
            });
        }

        if (charge.amount !== expectedPaise) {
            await Payment.updateOne({ _id: req.params.id }, { gatewayCheck });
            return res.status(400).json({
                success: false,
                message: "The amounts do not match. "
                    + (isSplit
                        ? "The company's half of this split is Rs " + paiseToRupees(expectedPaise)
                        : "The invoice is Rs " + paiseToRupees(expectedPaise))
                    + " and Razorpay took Rs " + paiseToRupees(charge.amount) + ".",
                data: { gatewayCheck },
            });
        }

        const updated = await Payment.findOneAndUpdate(
            { _id: req.params.id, status: "collected" },
            {
                status: "verified",
                verifiedBy: req.admin._id,
                verifiedAt: new Date(),
                gatewayCheck,
            },
            { returnDocument: "after" }
        ).lean();

        if (!updated) {
            return res.status(400).json({ success: false, message: "Already reconciled" });
        }

        // A commission settlement has no ticket behind it - it is the
        // technician squaring up, not a job.
        if (updated.ticket) {
            await ticketModel.updateOne(
                { _id: updated.ticket },
                {
                    "payment.status": "Verified",
                    "payment.verifiedBy": req.admin._id,
                    "payment.verifiedAt": new Date(),
                }
            );
        }

        return res.status(200).json({
            success: true,
            message: "Checked against Razorpay, Rs " + paiseToRupees(charge.amount)
                + " captured" + (charge.method ? " by " + charge.method : "") + ". Verified.",
            data: updated,
        });
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
            .findByIdAndUpdate(id, { isActive: !staff.isActive }, { returnDocument: "after" })
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

        // A technician clearing his commission is money moving back inside
        // the company, not a sale. Those rows carry no ticket, and counting
        // them here charged the same commission to revenue twice: one Rs 899
        // cash job read as Rs 1,168.70 across two jobs, and the technician's
        // own row said he had done two.
        const paidMatch = {
            createdAt: { $gte: since },
            status: { $in: ["collected", "verified"] },
            ticket: { $ne: null },
        };

        const [pnl, byTechnician, byService, series, ticketCounts, pendingAgg] = await Promise.all([
            // One pass over paid invoices gives the whole P&L. Splitting
            // cash from online matters because only online carries a
            // gateway fee.
            Payment.aggregate([
                { $match: paidMatch },
                // On a cash job the gateway fee has not been charged yet - it
                // lands when the technician sends the commission back - so
                // nothing is recorded on the row and the margin read as the
                // full commission. The Payments screen has always estimated
                // it; this is the same estimate, so the two screens stop
                // disagreeing about what the company keeps on the same job.
                {
                    $addFields: {
                        techFeePaise: {
                            $cond: [
                                { $eq: ["$method", "cash"] },
                                roundHalfUp({
                                    $divide: [
                                        { $multiply: [{ $ifNull: ["$commissionPaise", 0] }, GATEWAY_FEE_PERCENT * 1.18] },
                                        100,
                                    ],
                                }),
                                0,
                            ],
                        },
                    },
                },
                {
                    $group: {
                        _id: { $eq: ["$method", "cash"] },
                        jobs: { $sum: 1 },
                        grossPaise: { $sum: "$amountPaise" },
                        commissionPaise: { $sum: "$commissionPaise" },
                        technicianSharePaise: { $sum: "$technicianSharePaise" },
                        gatewayFeePaise: {
                            $sum: {
                                $add: [
                                    { $ifNull: ["$gatewayFeePaise", 0] },
                                    { $ifNull: ["$gatewayTaxPaise", 0] },
                                    "$techFeePaise",
                                ],
                            },
                        },
                    },
                },
            ]),

            // Naming the technician takes two fallbacks, because collectedBy
            // alone leaves rows labelled "Unknown": an online payment is
            // settled by the gateway rather than a person so it carries no
            // collectedBy, and a technician who has left is deleted outright,
            // which makes the technicians lookup miss. The ticket keeps a name
            // frozen at assignment, and that survives both.
            Payment.aggregate([
                { $match: paidMatch },
                { $lookup: { from: "tickets", localField: "ticket", foreignField: "_id", as: "t" } },
                {
                    $addFields: {
                        techId: { $ifNull: ["$collectedBy", { $arrayElemAt: ["$t.technician", 0] }] },
                        snapshotName: { $arrayElemAt: ["$t.technicianSnapshot.name", 0] },
                    },
                },
                { $lookup: { from: "technicians", localField: "techId", foreignField: "_id", as: "tech" } },
                {
                    $addFields: {
                        techName: {
                            $ifNull: [{ $arrayElemAt: ["$tech.name", 0] }, { $ifNull: ["$snapshotName", "Unknown"] }],
                        },
                    },
                },
                // Grouped by name, not id, because one person can hold two ids:
                // delete a technician and let them register again and their
                // jobs split across both. Two rows sharing a name also land on
                // the same bar in the chart, which is what made the totals look
                // wrong.
                {
                    $group: {
                        _id: "$techName",
                        jobs: { $sum: 1 },
                        grossPaise: { $sum: "$amountPaise" },
                        sharePaise: { $sum: "$technicianSharePaise" },
                    },
                },
                { $sort: { grossPaise: -1 } },
                { $limit: 10 },
                { $project: { _id: 0, name: "$_id", jobs: 1, grossPaise: 1, sharePaise: 1 } },
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
                { $match: { createdAt: { $gte: since }, ticket: { $ne: null } } },
                { $group: { _id: "$status", totalPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
            ]),
        ]);

        const cash = pnl.find((p) => p._id === true) || {};
        const online = pnl.find((p) => p._id === false) || {};

        const grossPaise = (cash.grossPaise || 0) + (online.grossPaise || 0);
        const commissionPaise = (cash.commissionPaise || 0) + (online.commissionPaise || 0);
        const technicianSharePaise = (cash.technicianSharePaise || 0) + (online.technicianSharePaise || 0);
        // Both sides now: what the gateway took off the customer's online
        // payment, and what it will take off the commission a technician
        // sends back on a cash job.
        const gatewayFeePaise = (online.gatewayFeePaise || 0) + (cash.gatewayFeePaise || 0);

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
                        gatewayFeeDisplay: paiseToRupees(cash.gatewayFeePaise || 0),
                    },
                    online: {
                        jobs: online.jobs || 0,
                        grossDisplay: paiseToRupees(online.grossPaise || 0),
                        gross: toRupees(online.grossPaise),
                        commissionDisplay: paiseToRupees(online.commissionPaise || 0),
                        gatewayFeeDisplay: paiseToRupees(online.gatewayFeePaise || 0),
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
            { returnDocument: "after", upsert: true }
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
            { returnDocument: "after" }
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
            { returnDocument: "after" }
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

/**
 * GET /api/admin/wallets/:technicianId/references
 *
 * The real Razorpay ids attached to this technician, newest first, so the
 * office picks one instead of copying eighteen characters of noise by hand.
 *
 * Two different things end up in this list and they are not interchangeable:
 *
 *   settlement - the technician sent their commission in through the app.
 *                This is the one to attach when recording a collection.
 *   job        - a customer paid for one of this technician's jobs online.
 *                Useful when tracing a payout, wrong for a collection.
 *
 * Each row also says whether the ledger already carries that id, because an
 * app settlement is credited by the webhook the moment it is paid. Recording
 * it a second time by hand would credit the same money twice.
 */
const getTechnicianPaymentReferences = async (req, res) => {
    try {
        const { technicianId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(technicianId)) {
            return res.status(400).json({ success: false, message: "Invalid vendor id" });
        }

        // Asking Razorpay takes about three seconds, which is far too long to
        // sit in front of a dialog that mostly just needs to open. The screen
        // loads from our own records first and asks for the sync separately,
        // so the wait happens in the background instead of in the way.
        if (req.query.sync === "1") {
            await claimPaidRecharges(technicianId);
        }

        // Jobs this technician did, whoever the payment was settled by - an
        // online payment carries no collectedBy, so matching on that alone
        // would return nothing.
        const ticketIds = await ticketModel
            .find({ technician: technicianId })
            .select("_id")
            .lean();

        const [payments, ledger] = await Promise.all([
            Payment.find({
                method: { $ne: "cash" },
                razorpayPaymentId: { $nin: [null, ""] },
                $or: [
                    { collectedBy: technicianId },
                    { ticket: { $in: ticketIds.map((t) => t._id) } },
                ],
            })
                .select("razorpayPaymentId invoiceNumber ticketNumber ticket amountPaise status createdAt")
                .sort({ createdAt: -1 })
                .limit(25)
                .lean(),

            WalletTransaction.find({ technician: technicianId })
                .select("description")
                .lean(),
        ]);

        const recorded = ledger.map((t) => t.description || "").join(" | ");

        // On a split the payment row carries the whole bill, but only the
        // company's half ever went through the gateway. Listing the bill
        // total next to a reference is how the wrong figure gets recorded
        // against the right id, so the gateway amount is looked up and shown
        // instead - it is the number the office is matching against.
        const splitTickets = await ticketModel
            .find({
                _id: { $in: payments.map((p) => p.ticket).filter(Boolean) },
                "payment.method": "split",
            })
            .select("payment.split.companyOnlinePaise")
            .lean();

        const splitHalf = new Map(
            splitTickets.map((t) => [String(t._id), t.payment?.split?.companyOnlinePaise || 0])
        );

        // The jobs behind the money.
        //
        // A settlement arrives as a bare amount with a gateway id on it and
        // nothing to say which work it covers. The office is meant to match it
        // to the tickets - "this Rs 269.70 is the commission on CG-2609-0009" -
        // and until now the only thing on the screen was a list of Razorpay
        // ids, so there was nothing to match it against.
        //
        // Cash jobs only: those are the ones that leave a commission with the
        // technician. Online and split jobs settle themselves.
        const cashJobs = await ticketModel
            .find({
                technician: technicianId,
                "payment.method": "cash",
                "billing.commissionPaise": { $gt: 0 },
                status: { $in: ["Closed", "Cancelled"] },
            })
            // The customer and the service come along so the office can tell
            // two identically priced jobs apart. A list of ticket numbers and
            // amounts is a list nobody can check against anything.
            .select("ticketNumber status serviceLabel customerSnapshot.name billing.invoiceNumber billing.totalPaise billing.commissionPaise payment.method payment.status updatedAt")
            .sort({ updatedAt: -1 })
            .limit(25)
            .lean();

        const jobs = cashJobs.map((t) => ({
            ticketNumber: t.ticketNumber,
            invoiceNumber: t.billing?.invoiceNumber || null,
            customerName: t.customerSnapshot?.name || null,
            serviceLabel: t.serviceLabel || null,
            // The figure as well as the formatted string: the dialog totals
            // these up, and adding up display strings is how rounding errors
            // get into a screen about money
            billPaise: t.billing?.totalPaise || 0,
            billDisplay: paiseToRupees(t.billing?.totalPaise || 0),
            method: t.payment?.method || "cash",
            commissionPaise: t.billing?.commissionPaise || 0,
            commissionDisplay: paiseToRupees(t.billing?.commissionPaise || 0),
            // Verified means the commission on it is already accounted for
            settled: t.payment?.status === "Verified",
            closedAt: t.updatedAt,
        }));

        return res.status(200).json({
            success: true,
            jobs,
            data: payments.map((p) => {
                const isSettlement = !p.ticket && !p.invoiceNumber;
                const half = p.ticket ? splitHalf.get(String(p.ticket)) : undefined;
                const isSplit = half !== undefined;

                return {
                    reference: p.razorpayPaymentId,
                    kind: isSettlement ? "settlement" : "job",
                    label: isSettlement
                        ? "Due cleared by technician"
                        : isSplit
                            ? "Split - company's half"
                            : "Customer paid this job online",
                    invoiceNumber: p.invoiceNumber || null,
                    ticketNumber: p.ticketNumber || null,

                    // What Razorpay actually took, which is what a check
                    // against the gateway will come back with
                    gatewayPaise: isSplit ? half : p.amountPaise,
                    gatewayDisplay: paiseToRupees(isSplit ? half : p.amountPaise),

                    // The bill behind it, shown only when the two differ
                    billDisplay: isSplit ? paiseToRupees(p.amountPaise) : null,

                    status: p.status,
                    alreadyRecorded: recorded.includes(p.razorpayPaymentId),
                    createdAt: p.createdAt,
                };
            }),
        });
    } catch (error) {
        console.error("Payment references error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * GET /api/admin/settlements?direction=in|out|all
 *
 * Money moving between the company and its technicians, which is a different
 * thing from a customer paying a bill: a technician clearing what they owe on
 * cash jobs, or the company paying out a technician's share of online ones.
 *
 * These only existed as sentences in the passbook. Nobody could answer "who
 * has settled in cash this week" without reading every line of every wallet.
 */
const SETTLEMENT_SOURCES = ["recharge", "adjustment", "payout"];

const getSettlements = async (req, res) => {
    try {
        const direction = req.query.direction || "all";
        const limit = Math.min(200, Number(req.query.limit) || 100);

        const filter = { source: { $in: SETTLEMENT_SOURCES } };

        // A credit moves the balance back towards zero - the technician paid
        // the company. A debit is the company paying the technician.
        if (direction === "in") filter.type = "credit";
        else if (direction === "out") filter.type = "debit";

        const term = String(req.query.search || "").trim();
        if (term.length >= 2) {
            const rx = new RegExp(escapeRegex(term), "i");
            const techIds = (
                await technicianModel.find({ name: rx }).select("_id").lean()
            ).map((t) => t._id);

            // Matching the reference too means a Razorpay id can be pasted in
            // to find which settlement it belongs to.
            filter.$or = [
                ...(techIds.length ? [{ technician: { $in: techIds } }] : []),
                { reference: rx },
                { description: rx },
            ];
        }

        const rows = await WalletTransaction.find(filter)
            .populate("technician", "name phone city commissionRate")
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        let collectedPaise = 0;
        let paidOutPaise = 0;
        const byMethod = {};

        const data = rows.map((t) => {
            const incoming = t.type === "credit";
            if (incoming) collectedPaise += t.amountPaise;
            else paidOutPaise += t.amountPaise;

            // Older rows kept the method inside the description, so fall back
            // to reading it out rather than showing them as "not recorded".
            const method = t.method || methodFromDescription(t.description);
            const key = method || "Not recorded";
            byMethod[key] = (byMethod[key] || 0) + t.amountPaise;

            return {
                _id: t._id,
                direction: incoming ? "technician_paid" : "company_paid",
                technician: t.technician
                    ? {
                          _id: t.technician._id,
                          name: t.technician.name,
                          phone: t.technician.phone,
                          city: t.technician.city || null,
                      }
                    : null,
                amountDisplay: paiseToRupees(t.amountPaise),
                method,
                reference: t.reference || referenceFromDescription(t.description),
                source: t.source,
                balanceAfterDisplay: paiseToRupees(Math.abs(t.balanceAfterPaise)),
                balanceAfterPaise: t.balanceAfterPaise,
                description: t.description,
                createdAt: t.createdAt,
            };
        });

        return res.status(200).json({
            success: true,
            data,
            summary: {
                collectedDisplay: paiseToRupees(collectedPaise),
                paidOutDisplay: paiseToRupees(paidOutPaise),
                collectedCount: data.filter((r) => r.direction === "technician_paid").length,
                paidOutCount: data.filter((r) => r.direction === "company_paid").length,
                byMethod: Object.entries(byMethod)
                    .map(([name, paise]) => ({ name, amountDisplay: paiseToRupees(paise) }))
                    .sort((a, b) => Number(b.amountDisplay) - Number(a.amountDisplay)),
            },
        });
    } catch (error) {
        console.error("Settlements error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/** Reads the method back out of a row written before the field existed. */
const methodFromDescription = (text = "") => {
    const viaMatch = text.match(/via ([A-Za-z ]+?)(?: \(|$)/);
    if (viaMatch) return viaMatch[1].trim();

    const lower = text.toLowerCase();
    if (lower.includes("razor")) return "Razorpay";
    if (lower.includes("upi")) return "UPI";
    if (lower.includes("bank")) return "Bank Transfer";
    if (lower.includes("cash")) return "Cash";
    if (text.startsWith("Settled:")) return "Razorpay";
    return null;
};

/** Likewise for the reference, which older rows kept in brackets. */
const referenceFromDescription = (text = "") => {
    const inBrackets = text.match(/\(([^)]+)\)/);
    if (!inBrackets) return null;

    const inner = inBrackets[1].trim();
    // "(Razorpay)" is a method, not a reference - only ids are useful here
    return /^(cash|upi|razorpay|razor pay|bank transfer)$/i.test(inner) ? null : inner;
};

/**
 * GET  /api/admin/settings
 * PATCH /api/admin/settings/:key   { value }
 *
 * The handful of numbers the owner can move without a deploy. Right now that
 * is how many times a technician may correct a bill - three covers an honest
 * slip, and the owner can raise it if the work turns out to need more.
 */
const getSettings = async (req, res) => {
    try {
        return res.status(200).json({ success: true, data: await settingsService.listSettings() });
    } catch (error) {
        console.error("Get settings error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const updateSetting = async (req, res) => {
    try {
        const value = await settingsService.setSetting(req.params.key, req.body.value, req.admin._id);
        return res.status(200).json({
            success: true,
            message: "Saved",
            data: await settingsService.listSettings(),
            value,
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

//wallet
const issueTechnicianPayout = async (req, res) => {
    try {
        const { technicianId, amountPaise, referenceNote } = req.body;

        if (!technicianId) {
            return res.status(400).json({ success: false, message: "Vendor ID is required" });
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
            String(referenceNote).trim(),
            req.body.method || null,
            req.body.reference || null
        );

        // He is not watching the panel - the transfer lands days after the
        // customer paid, and the first thing he does is ring the office to
        // ask whether it went out. The confirmation goes to the number he
        // registered with instead. A WhatsApp failure must not undo a
        // transfer that has already left the bank, so it only gets logged.
        const paidTech = await technicianModel
            .findById(technicianId)
            .select("name phone walletBalancePaise")
            .lean();

        if (paidTech) {
            const balance = paidTech.walletBalancePaise || 0;
            notification
                .notifyTechnicianPaidOnWhatsApp(paidTech, {
                    amountDisplay: paiseToRupees(transaction.amountPaise),
                    method: req.body.method || null,
                    reference: req.body.reference || String(referenceNote).trim(),
                    balanceDisplay: paiseToRupees(Math.abs(balance)),
                    owes: balance < 0,
                })
                .catch((err) => console.error("Payout WhatsApp failed:", err.message));
        }

        return res.status(200).json({
            success: true,
            message: "Payout recorded and wallet settled"
                + (paidTech?.phone ? " - " + paidTech.name + " told on WhatsApp" : ""),
            data: transaction,
        });
    } catch (error) {
        console.error("Payout error:", error.message);
        return res.status(400).json({ success: false, message: error.message || "Payout failed" });
    }
};

const getWalletSummary = async (req, res) => {
    try {
        const term = String(req.query.search || "").trim();
        const filter = { isDeleted: false };

        if (term.length >= 2) {
            // A settled technician has a zero balance and is normally hidden.
            // Searching a name and getting an empty screen reads as "no such
            // technician", so a search shows them with nothing outstanding.
            const rx = new RegExp(escapeRegex(term), "i");
            filter.$or = [{ name: rx }, { phone: rx }, { city: rx }];
        } else {
            filter.walletBalancePaise = { $ne: 0 };
        }

        // Visit charges owe nobody anything, so a technician can be sitting at
        // a perfectly square balance and still have trips the office has not
        // checked the figure on. Those have to show up here too, or the only
        // way to find them is to already know they exist.
        const pendingVisits = await Payment.aggregate([
            { $match: { isVisitCharge: true, status: "collected", commissionPaise: { $not: { $gt: 0 } } } },
            { $group: { _id: "$collectedBy", count: { $sum: 1 }, totalPaise: { $sum: "$amountPaise" } } },
        ]);

        const visitsByTech = new Map(pendingVisits.map((v) => [String(v._id), v]));

        if (term.length < 2 && visitsByTech.size) {
            filter.$or = [
                { walletBalancePaise: { $ne: 0 } },
                { _id: { $in: pendingVisits.map((v) => v._id).filter(Boolean) } },
            ];
            delete filter.walletBalancePaise;
        }

        const technicians = await technicianModel
            .find(filter)
            .select("name phone walletBalancePaise commissionRate city")
            .sort({ walletBalancePaise: -1 })
            .lean();

        // How long the technicians in credit have been waiting.
        //
        // A balance on its own does not say whether the transfer is due today
        // or has been sitting for a fortnight, and Razorpay needs a few days
        // to settle the customer's money into the company account before the
        // office can send anything on at all. Dated from the oldest online
        // credit that has not been paid out, so the list can be worked
        // oldest-first instead of by whoever rings up.
        const payoutDays = await settingsService.getSetting("PAYOUT_DAYS");
        const inCredit = technicians.filter((t) => (t.walletBalancePaise || 0) > 0).map((t) => t._id);

        const waitingByTech = new Map();
        if (inCredit.length) {
            const halfYearAgo = new Date(Date.now() - 180 * 86400000);

            const marks = await WalletTransaction.aggregate([
                {
                    $match: {
                        technician: { $in: inCredit },
                        source: { $in: ["payout", "job_online"] },
                        createdAt: { $gte: halfYearAgo },
                    },
                },
                { $sort: { createdAt: 1 } },
                {
                    $group: {
                        _id: "$technician",
                        lastPayoutAt: {
                            $max: { $cond: [{ $eq: ["$source", "payout"] }, "$createdAt", null] },
                        },
                        onlineAt: {
                            $push: { $cond: [{ $eq: ["$source", "job_online"] }, "$createdAt", "$$REMOVE"] },
                        },
                    },
                },
            ]);

            marks.forEach((m) => {
                const since = m.onlineAt.find((d) => !m.lastPayoutAt || d > m.lastPayoutAt);
                if (since) waitingByTech.set(String(m._id), since);
            });
        }

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
                city: t.city,
                commissionRate: t.commissionRate,
                balancePaise: balance,
                balanceDisplay: paiseToRupees(Math.abs(balance)),
                settled: balance === 0,

                // Trips billed but not yet checked. Nothing is owed on them -
                // this is an amount waiting to be confirmed, not collected.
                visitsPending: visitsByTech.get(String(t._id))?.count || 0,
                visitsPendingDisplay: paiseToRupees(visitsByTech.get(String(t._id))?.totalPaise || 0),
                direction: balance > 0 ? "company_owes" : "technician_owes",

                // Only meaningful when the company is the one holding money
                waitingSince: waitingByTech.get(String(t._id)) || null,
                payoutDueOn: waitingByTech.has(String(t._id))
                    ? new Date(new Date(waitingByTech.get(String(t._id))).getTime() + payoutDays * 86400000)
                    : null,
            };
        });

        return res.status(200).json({
            success: true,
            data: rows,
            summary: {
                owedToTechniciansDisplay: paiseToRupees(owedToTechnicians),
                owedByTechniciansDisplay: paiseToRupees(owedByTechnicians),
                netDisplay: paiseToRupees(owedToTechnicians - owedByTechnicians),

                visitsPendingCount: pendingVisits.reduce((n, v) => n + v.count, 0),
                visitsPendingDisplay: paiseToRupees(pendingVisits.reduce((n, v) => n + v.totalPaise, 0)),
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
        const [tech, transactions, pendingVisits] = await Promise.all([
            technicianModel.findById(req.params.technicianId)
                .select("name phone walletBalancePaise commissionRate")
                .lean(),
            WalletTransaction.find({ technician: req.params.technicianId })
                .sort({ createdAt: -1 })
                .limit(100)
                .populate("ticket", "ticketNumber serviceLabel")
                .lean(),

            // Trips this technician billed that nobody has checked the figure
            // on yet. Nothing is owed on them either way - which is only true
            // while the company's cut of a visit is zero, so a visit that did
            // carry a commission stays out and is chased as a cash job.
            Payment.find({
                collectedBy: req.params.technicianId,
                isVisitCharge: true,
                status: "collected",
                commissionPaise: { $not: { $gt: 0 } },
            }).select("amountPaise ticketNumber createdAt").lean(),
        ]);

        if (!tech) {
            return res.status(404).json({ success: false, message: "Vendor not found" });
        }

        return res.status(200).json({
            success: true,
            data: {
                technician: tech,
                balancePaise: tech.walletBalancePaise || 0,
                balanceDisplay: paiseToRupees(Math.abs(tech.walletBalancePaise || 0)),
                direction: (tech.walletBalancePaise || 0) > 0 ? "company_owes" : "technician_owes",

                visitsPending: pendingVisits.length,
                visitsPendingPaise: pendingVisits.reduce((n, p) => n + p.amountPaise, 0),
                visitsPendingDisplay: paiseToRupees(pendingVisits.reduce((n, p) => n + p.amountPaise, 0)),
                visits: pendingVisits.map((p) => ({
                    ticketNumber: p.ticketNumber,
                    amountDisplay: paiseToRupees(p.amountPaise),
                    createdAt: p.createdAt,
                })),
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

/**
 * POST /api/admin/wallets/:technicianId/collect
 *
 * The technician has cleared what they owed and the office is writing it into
 * the ledger. How it arrived and the reference for it are two separate
 * fields: every existing row in this ledger reads "Collected from technician:
 * Razorpay" with no id at all, because the old form only had one box and the
 * method went into it. None of those can be traced back to a transaction.
 *
 * Cash is the exception - there is no reference to give, so the method alone
 * is the whole record.
 */
/**
 * The only ways money actually moves between the company and a technician.
 *
 * This is checked on the server, not just offered in a dropdown. A "Visit
 * charge" option existed here briefly and was wrong - the technician takes
 * that straight from the customer and the company's cut of it is zero, so
 * recording it credited him for money he already had and then offered to pay
 * him out for it. The option is gone from the screen, and a stale browser tab
 * still holding it cannot put one through either.
 */
const SETTLEMENT_METHODS = ["UPI", "Razorpay", "Bank Transfer", "Cash", "Visit charge"];

/** Cash leaves no trace to quote, so it is the one with no reference. */
const CASHLESS_METHODS = ["UPI", "Razorpay", "Bank Transfer"];

const collectFromTechnician = async (req, res) => {
    try {
        const { amountPaise, method, referenceNote } = req.body;

        // Which jobs this money is for. The ledger used to record only that
        // some amount came in by some method, so a month later nobody could
        // say which work it had cleared.
        const covers = Array.isArray(req.body.ticketNumbers)
            ? req.body.ticketNumbers.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
            : [];

        const amount = Number(amountPaise);
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: "Enter a valid amount" });
        }

        const how = String(method || "").trim();
        if (!SETTLEMENT_METHODS.includes(how)) {
            return res.status(400).json({
                success: false,
                message: "Choose how the money was received: " + SETTLEMENT_METHODS.join(", "),
            });
        }

        const reference = String(referenceNote || "").trim();
        if (CASHLESS_METHODS.includes(how) && how !== "Visit charge" && reference.length < 3) {
            return res.status(400).json({
                success: false,
                message: "Enter the " + how + " reference so this can be traced later",
            });
        }

        // A visit charge is not money changing hands. The technician already
        // took it from the customer and the company's cut of it is zero - all
        // the office is doing is confirming the figure was right. So this
        // marks those trips checked and leaves the balance exactly where it
        // is. Crediting it, as an earlier version did, made the company owe
        // him for money he was already holding.
        if (how === "Visit charge") {
            // Only trips the company takes nothing on. This shortcut writes
            // no ledger line, so using it on a visit that did carry a
            // commission would mark the money checked and quietly write the
            // commission off - and a commission on visits is something the
            // company may well decide to charge later.
            const pending = await Payment.find({
                collectedBy: req.params.technicianId,
                isVisitCharge: true,
                status: "collected",
                commissionPaise: { $not: { $gt: 0 } },
            }).select("amountPaise").lean();

            if (!pending.length) {
                return res.status(400).json({
                    success: false,
                    message: "This vendor has no visit charges waiting to be checked",
                });
            }

            const expected = pending.reduce((n, p) => n + p.amountPaise, 0);

            if (amount !== expected) {
                return res.status(400).json({
                    success: false,
                    message: "That doesn't match. " + pending.length + " trip" +
                        (pending.length === 1 ? " comes" : "s come") + " to Rs " +
                        paiseToRupees(expected) + ".",
                });
            }

            await Payment.updateMany(
                {
                    collectedBy: req.params.technicianId,
                    isVisitCharge: true,
                    status: "collected",
                    commissionPaise: { $not: { $gt: 0 } },
                },
                { status: "verified", verifiedBy: req.admin._id, verifiedAt: new Date() }
            );

            return res.status(200).json({
                success: true,
                message: "Checked. Rs " + paiseToRupees(expected) + " across " + pending.length +
                    " trip" + (pending.length === 1 ? "" : "s") + ". Nothing owed either way.",
                data: { verified: pending.length, amountDisplay: paiseToRupees(expected) },
            });
        }

        // The webhook credits an in-app settlement the moment Razorpay
        // confirms it. Recording the same id again by hand would credit the
        // money twice and quietly leave the technician in credit.
        if (reference.length >= 3) {
            const already = await WalletTransaction.findOne({
                technician: req.params.technicianId,
                description: { $regex: escapeRegex(reference), $options: "i" },
            }).select("_id createdAt").lean();

            if (already) {
                return res.status(400).json({
                    success: false,
                    message: "That reference is already in this vendor's ledger. It was recorded on "
                        + new Date(already.createdAt).toLocaleDateString("en-IN")
                        + ". Recording it again would credit the money twice.",
                });
            }
        }

        // Recording more than is outstanding does not clear a wallet, it
        // flips it: the screen then says the company has to pay the
        // technician, for money he was only handing back. The office is
        // clearing a due here, so the due is the ceiling.
        const owing = await technicianModel
            .findById(req.params.technicianId)
            .select("walletBalancePaise name")
            .lean();

        const outstanding = Math.abs(Math.min(0, owing?.walletBalancePaise || 0));

        if (outstanding <= 0) {
            return res.status(400).json({
                success: false,
                message: (owing?.name || "This vendor") + " has nothing outstanding. Their wallet is already clear.",
            });
        }

        if (amount > outstanding) {
            return res.status(400).json({
                success: false,
                message: "That is more than is outstanding. " + (owing?.name || "This vendor")
                    + " owes Rs " + paiseToRupees(outstanding)
                    + ", and recording Rs " + paiseToRupees(amount)
                    + " would leave the company owing him the difference.",
            });
        }

        // Positive delta because the technician owed us and has now paid,
        // which moves their negative balance back towards zero.
        //
        // Recorded as a settlement rather than an adjustment. It used to go
        // through adjustBalance, which files it under "manual correction" -
        // so the technician's own wallet said "You settled Rs 0.00" the day
        // after he had settled in full, and the office's ledger described
        // real money as a fix-up.
        const transaction = await walletService.recordRecharge(
            req.params.technicianId,
            amount,
            reference || null,
            how,
            "Collected from technician via " + how
                + (reference ? " (" + reference + ")" : "")
                + (covers.length ? " for " + covers.join(", ") : "")
        );

        /*
         * The settlement the technician sent is now closed, not just credited.
         *
         * The webhook writes a Payment row for an in-app settlement and
         * deliberately leaves it "collected", because the office still has to
         * check the reference and record it. This is that recording - so the
         * row has to be closed here too. It was not, and the consequences ran
         * on for ever: the wallet screen keeps reporting a settlement waiting
         * to be verified, and `canPayOnline` is false while one is waiting, so
         * a technician who settled once online could never settle online
         * again. Both panels showed him "Rs X received, waiting for the
         * office" sitting on top of a completely different, unpaid due.
         *
         * Matched on the reference the office just typed, which is the
         * Razorpay payment id the row was created with. Nothing is closed on
         * a guess: a cash settlement has no row of its own, and closing the
         * oldest pending one would write off an online payment that is still
         * genuinely waiting to be checked.
         */
        if (reference.length >= 3) {
            await Payment.updateMany(
                {
                    collectedBy: req.params.technicianId,
                    ticket: null,
                    status: "collected",
                    $or: [{ razorpayPaymentId: reference }, { razorpayLinkId: reference }],
                },
                { status: "verified", verifiedBy: req.admin._id, verifiedAt: new Date() }
            );
        }

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



/**
 * DELETE /api/admin/technicians/deleted
 *
 * Empties the recycle bin now instead of waiting out the week.
 *
 * The week exists so a deletion can be looked at before it is final; this is
 * the office saying it has looked. Owner only, because it is the one action on
 * this screen that cannot be undone by anybody.
 *
 * A vendor still holding money is left behind rather than removed. The balance
 * is the company's record of what it owes him or he owes it, and a bin that
 * quietly takes that with it would turn "tidy up" into "write off" - so those
 * rows stay, and the response says how many and why.
 */
const purgeDeletedTechnicians = async (req, res) => {
    try {
        const owing = await technicianModel.countDocuments({
            isDeleted: true,
            walletBalancePaise: { $ne: 0 },
        });

        // Whose sockets to cut - read before the rows go, since after the
        // delete there is nothing left to ask
        const going = await technicianModel
            .find({ isDeleted: true, walletBalancePaise: 0 })
            .select("_id")
            .lean();

        const { deletedCount } = await technicianModel.deleteMany({
            isDeleted: true,
            walletBalancePaise: 0,
        });

        going.forEach((row) => dropRoom(techRoom(row._id)));

        return res.status(200).json({
            success: true,
            data: { removed: deletedCount, kept: owing },
            message: owing
                ? `${deletedCount} removed. ${owing} kept - their wallet is not settled.`
                : `${deletedCount} account${deletedCount === 1 ? "" : "s"} removed.`,
        });
    } catch (error) {
        console.error("Purge deleted technicians error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

module.exports = {
    purgeDeletedTechnicians,
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
    callCustomer,
    cancelTicket,
    forceCloseTicket,
    getAllTechnicians,
    getPayments,
    verifyPayment,
    checkPaymentReference,
    checkPaymentMoney,
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
    getTechnicianPaymentReferences,
    getSettlements,
    resolveRefusal,
    getSettings,
    updateSetting,
    getWalletSummary,
    getTechnicianWallet,
    collectFromTechnician,
    exportRevenueCsv
};
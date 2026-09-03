const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const technicianModel = require("../models/technician.model");
const ticketModel = require("../models/ticket.model");
const ServicePricing = require("../models/servicePricing.model");
const Payment = require("../models/payment.model");
const WalletTransaction = require("../models/walletTransaction.model");
const uploadImage = require("../utils/imagekit");
const paymentService = require("../services/payment.service");
const notification = require("../services/notification.service");
const { promoteQueuedTicket } = require("../services/dispatch.service");
const { emitToRoom, userRoom } = require("../sockets/socket.instance");
const walletService = require("../services/wallet.service");
const { estimateGatewayFee } = require("../config/razorpay");
const { verifyPhoneToken } = require("../config/firebase");
const isProd = process.env.NODE_ENV === "production";

const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
};

const clearOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
};

const PUBLIC_FIELDS =
    "_id name phone state area pincode skills profileImage rating isAvailable activeTicket completedJobs performanceLevel createdAt";

const ACTIVE_STATUSES = ["Assigned", "In-Progress", "Payment-Pending"];

const signToken = (techId) =>
    jwt.sign({ techId, role: "technician" }, process.env.JWT_SECRET, { expiresIn: "7d" });

const ifscCache = new Map();



/* ================= AUTH ================= */

const registerTechnician = async (req, res) => {
    try {
        const {
            idToken, name, password, email,
            pincode, state, area, lat, lon,
            skills, hasVehicle,
            accountHolderName, accountNumber, ifsc,
        } = req.body;

        const verified = await verifyPhoneToken(idToken);
        if (!verified) {
            return res.status(401).json({
                success: false,
                message: "Your phone verification expired. Please start again.",
            });
        }

        if (!name || !password || !pincode || !state || !area || !skills?.length) {
            return res.status(400).json({ success: false, message: "Please fill in all the required details" });
        }
        if (String(password).length < 6) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
        }
        if (!accountHolderName || !accountNumber || !ifsc) {
            return res.status(400).json({ success: false, message: "Bank details are required to receive payouts" });
        }

        const cleanAccount = String(accountNumber).replace(/\s/g, "");
        if (!/^\d{9,18}$/.test(cleanAccount)) {
            return res.status(400).json({ success: false, message: "Enter a valid bank account number" });
        }

        const cleanIfsc = String(ifsc).toUpperCase().trim();
        if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) {
            return res.status(400).json({ success: false, message: "Enter a valid IFSC code" });
        }

        // Re-check here rather than trusting phase 1 - minutes may have passed
        const existing = await technicianModel
            .findOne({ phone: verified.phone })
            .select("_id isBlacklisted")
            .lean();

        if (existing?.isBlacklisted) {
            return res.status(403).json({ success: false, message: "This number cannot be registered." });
        }
        if (existing) {
            return res.status(409).json({ success: false, message: "This number is already registered" });
        }

        // Confirm the IFSC actually exists before storing it. A typo here
        // means a failed payout weeks later, when nobody remembers.
        const bank = await lookupIfsc(cleanIfsc);
        if (!bank) {
            return res.status(400).json({
                success: false,
                message: "That IFSC code doesn't match any branch. Please check it.",
            });
        }

        const techData = {
            name: String(name).trim(),
            phone: verified.phone,
            password: await bcrypt.hash(password, 10),
            email: email ? String(email).toLowerCase().trim() : undefined,
            pincode: String(pincode).trim(),
            state: String(state).trim(),
            area: String(area).trim(),
            skills: Array.isArray(skills) ? skills : (skills ? JSON.parse(skills) : []),
            hasVehicle: hasVehicle === 'true' || hasVehicle === true,
            approvalStatus: "pending",
            phoneVerifiedAt: new Date(),
            firebaseUid: verified.uid,
            bankDetails: {
                accountHolderName: String(accountHolderName).trim(),
                accountNumber: cleanAccount,
                accountLast4: cleanAccount.slice(-4),
                ifsc: cleanIfsc,
                bankName: bank.BANK,
                branch: bank.BRANCH,
                verifiedAt: new Date(),
            },
        };

        if (req.file) {
            try {
                const imgRes = await uploadImage(req.file.buffer, `tech_${Date.now()}`);
                techData.profileImage = imgRes.url;
            } catch (err) {
                console.error("Failed to upload profile image:", err);
            }
        }

        const numLat = Number(lat);
        const numLon = Number(lon);
        const hasCoords = Number.isFinite(numLat) && Number.isFinite(numLon)
            && Math.abs(numLat) <= 90 && Math.abs(numLon) <= 180;

        if (hasCoords) {
            techData.location = { type: "Point", coordinates: [numLon, numLat] };
            techData.lastLocationAt = new Date();
        }

        const newTech = new technicianModel(techData);

        // Even if a schema default sneaks in a bare { type: "Point" }, strip
        // it - the 2dsphere index refuses a location without coordinates
        if (!hasCoords) {
            newTech.location = undefined;
            newTech.markModified("location");
        }

        await newTech.save();

        // No cookie - the account can't sign in until the office approves it
        return res.status(201).json({
            success: true,
            requiresApproval: true,
            message: "Account created. The office will review it and you'll be able to sign in once approved.",
        });
    } catch (error) {
        console.error("Register technician error:", error);
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: "This number is already registered" });
        }
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/technician/verify-phone
 * body: { idToken }
 *
 * Phase 1 of registration. The client has already done the OTP dance with
 * Firebase; this confirms the resulting token is real and tells them whether
 * that number can go on to register.
 */
const verifyPhone = async (req, res) => {
    try {
        const verified = await verifyPhoneToken(req.body.idToken);

        if (!verified) {
            return res.status(401).json({
                success: false,
                message: "Could not verify that number. Please request a new code.",
            });
        }

        const existing = await technicianModel
            .findOne({ phone: verified.phone })
            .select("_id isBlacklisted approvalStatus name")
            .lean();

        if (existing?.isBlacklisted) {
            return res.status(403).json({
                success: false,
                message: "This number cannot be registered. Contact the office if you think this is a mistake.",
            });
        }

        if (existing) {
            return res.status(409).json({
                success: false,
                alreadyRegistered: true,
                approvalStatus: existing.approvalStatus,
                message: existing.approvalStatus === "pending"
                    ? "This number is already registered and waiting for approval."
                    : "This number is already registered. Please sign in instead.",
            });
        }

        return res.status(200).json({
            success: true,
            data: { phone: verified.phone },
            message: "Number verified",
        });
    } catch (error) {
        console.error("Verify phone error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const lookupIfsc = async (code) => {
    if (ifscCache.has(code)) return ifscCache.get(code);

    try {
        const { data } = await axios.get("https://ifsc.razorpay.com/" + code, { timeout: 8000 });
        if (!data?.BANK) return null;

        const result = { BANK: data.BANK, BRANCH: data.BRANCH, CITY: data.CITY, STATE: data.STATE };
        ifscCache.set(code, result);
        return result;
    } catch (error) {
        // A 404 means the code doesn't exist - that's an answer, not a failure
        if (error.response?.status === 404) return null;
        console.error("IFSC lookup failed:", error.message);
        return null;
    }
};

const checkIfsc = async (req, res) => {
    const code = String(req.params.code || "").toUpperCase().trim();

    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) {
        return res.status(400).json({ success: false, message: "IFSC codes are 11 characters, like SBIN0001234" });
    }

    const bank = await lookupIfsc(code);
    if (!bank) {
        return res.status(404).json({ success: false, message: "No branch found for that code" });
    }

    return res.status(200).json({
        success: true,
        data: { bank: bank.BANK, branch: bank.BRANCH, city: bank.CITY, state: bank.STATE },
    });
};


const loginTechnician = async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (!phone || !password) {
            return res.status(400).json({ success: false, message: "Phone and password are required" });
        }

        const technician = await technicianModel.findOne({ phone: String(phone).trim() }).select("+password");

        if (!technician) {
            return res.status(401).json({ success: false, message: "Invalid phone number or password" });
        }

        const isPasswordValid = await bcrypt.compare(password, technician.password);
        if (!isPasswordValid) {
            return res.status(401).json({ success: false, message: "Invalid phone number or password" });
        }

        // Password checked first so these messages don't leak which numbers
        // are registered to someone probing at random
        if (technician.isBlacklisted) {
            return res.status(403).json({
                success: false,
                message: "This account has been blocked. Contact the office.",
            });
        }
        if (technician.isDeleted) {
            return res.status(403).json({ success: false, message: "This account is no longer active." });
        }
        if (technician.approvalStatus === "rejected") {
            return res.status(403).json({
                success: false,
                message: technician.rejectionReason
                    ? "Your application was not approved: " + technician.rejectionReason
                    : "Your application was not approved. Contact the office for details.",
                approvalStatus: "rejected",
            });
        }
        if (technician.approvalStatus === "pending") {
            return res.status(403).json({
                success: false,
                message: "Your account is still being reviewed. We'll let you know once it's approved.",
                approvalStatus: "pending",
            });
        }

        res.cookie("techToken", signToken(technician._id), cookieOptions);

        const data = await technicianModel.findById(technician._id).select(PUBLIC_FIELDS).lean();
        return res.status(200).json({ success: true, message: "Login successful", data });
    } catch (error) {
        console.error("Login error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const logoutTechnician = (req, res) => {
    res.clearCookie("techToken", clearOptions);
    return res.status(200).json({ success: true, message: "Logged out successfully" });
};

/* ================= PROFILE ================= */

const getTechProfile = async (req, res) => {
    return res.status(200).json({ success: true, data: req.technician });
};

// GET /api/technician/bootstrap
const bootstrap = async (req, res) => {
    try {
        const techId = req.technician._id;

        const [activeTicket, nextJobs, scheduledJobs, history, cashSummary] = await Promise.all([
            ticketModel
                .findOne({ technician: techId, status: { $in: ACTIVE_STATUSES } })
                .select("ticketNumber serviceKey serviceLabel selectedIssues problemDescription customerSnapshot status billing payment scheduling createdAt assignedAt")
                .sort({ createdAt: -1 })
                .lean(),

            // Undated queued work is "next up" - it starts on its own when the
            // current job closes, so the technician can only decline it
            ticketModel
                .find({
                    technician: techId,
                    status: "Queued",
                    "scheduling.scheduledFor": { $in: [null, undefined] },
                })
                .select("ticketNumber serviceLabel problemDescription customerSnapshot queuedAt")
                .sort({ queuedAt: 1 })
                .lean(),

            // Dated work is scheduled - the technician can pull it forward
            ticketModel
                .find({
                    technician: techId,
                    status: "Queued",
                    "scheduling.scheduledFor": { $ne: null },
                })
                .select("ticketNumber serviceLabel problemDescription customerSnapshot scheduling queuedAt")
                .sort({ "scheduling.scheduledFor": 1 })
                .lean(),

            ticketModel
                .find({ technician: techId, status: "Closed" })
                .select("ticketNumber serviceLabel billing.totalPaise billing.invoiceNumber customerSnapshot payment.method payment.status updatedAt")
                .sort({ updatedAt: -1 })
                .limit(30)
                .lean(),

            Payment.aggregate([
                { $match: { collectedBy: techId, method: "cash", status: "collected" } },
                { $group: { _id: null, count: { $sum: 1 }, totalPaise: { $sum: "$amountPaise" } } },
            ]),
        ]);

        return res.status(200).json({
            success: true,
            data: {
                profile: req.technician,
                activeTicket: activeTicket || null,
                nextJobs,
                scheduledJobs,
                history,
                pendingCash: {
                    count: cashSummary[0]?.count || 0,
                    totalPaise: cashSummary[0]?.totalPaise || 0,
                    amountDisplay: paymentService.paiseToRupees(cashSummary[0]?.totalPaise || 0),
                },
            },
        });
    } catch (error) {
        console.error("Bootstrap error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// GET /api/technician/cash-deposits
// The list behind the "pending deposit" number, so a technician can see
// exactly which jobs make up the cash they're carrying
const getCashDeposits = async (req, res) => {
    try {
        const [pending, recentVerified] = await Promise.all([
            Payment.find({ collectedBy: req.technician._id, method: "cash", status: "collected" })
                .select("ticketNumber invoiceNumber amountPaise collectedAt")
                .sort({ collectedAt: 1 })
                .lean(),

            Payment.find({ collectedBy: req.technician._id, method: "cash", status: "verified" })
                .populate("verifiedBy", "name")
                .select("ticketNumber invoiceNumber amountPaise verifiedAt verifiedBy")
                .sort({ verifiedAt: -1 })
                .limit(15)
                .lean(),
        ]);

        const totalPaise = pending.reduce((sum, p) => sum + p.amountPaise, 0);

        return res.status(200).json({
            success: true,
            data: {
                pending: pending.map((p) => ({ ...p, amountDisplay: paymentService.paiseToRupees(p.amountPaise) })),
                recentVerified: recentVerified.map((p) => ({ ...p, amountDisplay: paymentService.paiseToRupees(p.amountPaise) })),
                totalPendingDisplay: paymentService.paiseToRupees(totalPaise),
            },
        });
    } catch (error) {
        console.error("Get cash deposits error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const updateTechProfile = async (req, res) => {
    try {
        const techId = req.technician._id;
        const { name, state, area, pincode } = req.body;

        const updateData = {};
        if (name) updateData.name = String(name).trim();
        if (state) updateData.state = String(state).trim();
        if (area) updateData.area = String(area).trim();
        if (pincode) updateData.pincode = String(pincode).trim();

        if (req.body.accountHolderName && req.body.accountNumber && req.body.ifsc) {
            const cleanAccount = String(req.body.accountNumber).replace(/\D/g, "");
            const cleanIfsc = String(req.body.ifsc).toUpperCase().trim();

            if (!/^\d{9,18}$/.test(cleanAccount)) {
                return res.status(400).json({ success: false, message: "Invalid account number format" });
            }

            const bank = await lookupIfsc(cleanIfsc);
            if (!bank) {
                return res.status(400).json({ success: false, message: "Invalid IFSC code" });
            }

            updateData.bankDetails = {
                accountHolderName: String(req.body.accountHolderName).trim(),
                accountNumber: cleanAccount,
                accountLast4: cleanAccount.slice(-4),
                ifsc: cleanIfsc,
                bankName: bank.BANK,
                branch: bank.BRANCH,
                verifiedAt: new Date(),
            };
        }

        if (req.file) {
            const uploadResult = await uploadImage(req.file.buffer, `tech_${techId}_${Date.now()}`);
            updateData.profileImage = uploadResult.url;
        }

        const updatedTech = await technicianModel
            .findByIdAndUpdate(techId, updateData, { new: true, runValidators: true })
            .select(PUBLIC_FIELDS)
            .lean();

        return res.status(200).json({ success: true, message: "Profile updated successfully", data: updatedTech });
    } catch (error) {
        console.error("Profile update error:", error);
        return res.status(500).json({ success: false, message: "Failed to update profile" });
    }
};

const deleteTechProfile = async (req, res) => {
    try {
        const techId = req.technician._id;

        const activeJob = await ticketModel
            .findOne({ technician: techId, status: { $in: [...ACTIVE_STATUSES, "Queued"] } })
            .select("_id")
            .lean();

        if (activeJob) {
            return res.status(400).json({ success: false, message: "Finish your active jobs before deleting your account" });
        }

        const undeposited = await Payment.countDocuments({
            collectedBy: techId, method: "cash", status: "collected",
        });
        if (undeposited > 0) {
            return res.status(400).json({ success: false, message: "Deposit your collected cash at the office first" });
        }

        await technicianModel.findByIdAndUpdate(techId, {
            isDeleted: true, isAvailable: false, activeTicket: null,
        });

        res.clearCookie("techToken", clearOptions);
        return res.status(200).json({ success: true, message: "Account deleted successfully" });
    } catch (error) {
        console.error("Delete profile error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/* ================= STATUS & LOCATION ================= */

const updateStatus = async (req, res) => {
    try {
        const { isAvailable } = req.body;

        if (typeof isAvailable !== "boolean") {
            return res.status(400).json({ success: false, message: "isAvailable must be true or false" });
        }
        if (req.technician.activeTicket) {
            return res.status(400).json({ success: false, message: "You cannot change status while on an active job" });
        }

        const updatedTech = await technicianModel
            .findByIdAndUpdate(req.technician._id, { isAvailable }, { new: true })
            .select(PUBLIC_FIELDS)
            .lean();

        emitToRoom("admins", "tech:status", updatedTech);

        return res.status(200).json({ success: true, data: updatedTech });
    } catch (error) {
        console.error("Update status error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/* const updateLocation = async (req, res) => {
    try {
        const lat = Number(req.body.lat);
        const lon = Number(req.body.lon ?? req.body.lng);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return res.status(400).json({ success: false, message: "Valid lat and lon are required" });
        }
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            return res.status(400).json({ success: false, message: "Coordinates out of range" });
        }

        await technicianModel.updateOne(
            { _id: req.technician._id },
            { location: { type: "Point", coordinates: [lon, lat] }, lastLocationAt: new Date() }
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Update location error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
}; */

/* ================= TICKETS ================= */

/* const getMyAssignedTicket = async (req, res) => {
    try {
        const activeTicket = await ticketModel
            .findOne({ technician: req.technician._id, status: { $in: ACTIVE_STATUSES } })
            .select("ticketNumber serviceKey serviceLabel selectedIssues problemDescription customerSnapshot status billing payment createdAt assignedAt")
            .sort({ createdAt: -1 })
            .lean();

        return res.status(200).json({ success: true, data: activeTicket || null });
    } catch (error) {
        console.error("Get assigned ticket error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
}; */

/* const getCompletedTickets = async (req, res) => {
    try {
        const history = await ticketModel
            .find({ technician: req.technician._id, status: "Closed" })
            .select("ticketNumber serviceLabel billing.totalPaise billing.invoiceNumber customerSnapshot payment.method payment.status updatedAt")
            .sort({ updatedAt: -1 })
            .limit(50)
            .lean();

        return res.status(200).json({ success: true, data: history });
    } catch (error) {
        console.error("Get history error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
}; */

const startWork = async (req, res) => {
    try {
        const ticket = await ticketModel.findOneAndUpdate(
            { _id: req.params.id, technician: req.technician._id, status: "Assigned" },
            {
                status: "In-Progress",
                $push: {
                    statusHistory: {
                        from: "Assigned",
                        to: "In-Progress",
                        actorRole: "technician",
                        actorId: req.technician._id,
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found or already started" });
        }

        // Goes to both channels - a WhatsApp customer never had the web
        // socket open, so the old socket-only emit reached nobody
        await notification.notifyCustomerWorkStarted(ticket);

        return res.status(200).json({ success: true, data: ticket });
    } catch (error) {
        console.error("Start work error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const releaseTicket = async (req, res) => {
    try {
        const { reason } = req.body;

        if (!reason || String(reason).trim().length < 5) {
            return res.status(400).json({ success: false, message: "Please explain why you can't do this job" });
        }

        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            technician: req.technician._id,
            status: { $in: ["Queued", "Assigned", "In-Progress"] },
        }).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Job not found or not currently yours" });
        }

        const wasActive = ticket.status !== "Queued";
        const wasScheduled = Boolean(ticket.scheduling?.scheduledFor);

        const updated = await ticketModel.findByIdAndUpdate(
            ticket._id,
            {
                status: "Pending",
                technician: null,
                technicianSnapshot: {},
                assignedBy: null,
                assignedAt: null,
                queuedAt: null,
                rejection: {
                    rejectedByName: req.technician.name,
                    reason: String(reason).trim(),
                    rejectedAt: new Date(),
                    wasScheduled,
                },
                $push: {
                    statusHistory: {
                        from: ticket.status,
                        to: "Pending",
                        actorRole: "technician",
                        actorId: req.technician._id,
                        reason: "Declined: " + String(reason).trim(),
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        // Only pull in their next job if this was the one they were on
        if (wasActive) {
            await promoteQueuedTicket(req.technician._id);
        }

        notification.notifyAdminsTicketRejected(updated, req.technician.name, String(reason).trim());

        return res.status(200).json({
            success: true,
            message: "The office has been notified",
            data: updated,
        });
    } catch (error) {
        console.error("Release ticket error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const startScheduledNow = async (req, res) => {
    try {
        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            technician: req.technician._id,
            status: "Queued",
        }).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Scheduled job not found" });
        }

        // Filter on activeTicket so two taps can't both slip through
        const locked = await technicianModel.findOneAndUpdate(
            { _id: req.technician._id, activeTicket: null },
            { isAvailable: false, activeTicket: ticket._id },
            { returnDocument: "after" }
        ).lean();

        if (!locked) {
            return res.status(409).json({
                success: false,
                message: "Finish your current job before starting this one",
            });
        }

        const updated = await ticketModel.findOneAndUpdate(
            { _id: ticket._id, status: "Queued" },
            {
                status: "Assigned",
                assignedAt: new Date(),
                $push: {
                    statusHistory: {
                        from: "Queued",
                        to: "Assigned",
                        actorRole: "technician",
                        actorId: req.technician._id,
                        reason: "Technician pulled this job forward",
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        if (!updated) {
            // Someone else moved it first - hand the technician back
            await technicianModel.updateOne(
                { _id: req.technician._id },
                { isAvailable: true, activeTicket: null }
            );
            return res.status(409).json({ success: false, message: "This job was just changed. Refresh and try again." });
        }

        await notification.notifyCustomerAssigned(updated);
        notification.notifyAdminsScheduledStartedEarly(updated, req.technician.name);

        return res.status(200).json({
            success: true,
            message: "Job started - it's now in My Job",
            data: updated,
        });
    } catch (error) {
        console.error("Start scheduled now error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/* ================= BILLING & PAYMENT ================= */

const getPricing = async (req, res) => {
    try {
        const { serviceKey } = req.query;
        if (!serviceKey) {
            return res.status(400).json({ success: false, message: "serviceKey is required" });
        }

        const doc = await ServicePricing.findOne({ serviceKey }).lean();
        const items = (doc?.itemsList || []).filter((i) => i.isActive);

        return res.status(200).json({
            success: true,
            data: items
                .map((i) => ({ ...i, priceDisplay: paymentService.paiseToRupees(i.pricePaise) }))
                .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
            limits: paymentService.LIMITS,
            onlinePaymentAvailable: paymentService.isRazorpayActive(),
        });
    } catch (error) {
        console.error("Get pricing error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

 // POST /api/technician/tickets/generateBill
const generateBill = async (req, res) => {
    try {
        const { ticketId, catalogItems, customItems, workDone, paymentMethod, serviceKey } = req.body;

        if (!ticketId) {
            return res.status(400).json({ success: false, message: "ticketId is required" });
        }

        const method = paymentMethod === "cash" ? "cash" : "online";

        const ticket = await ticketModel.findOne({
            _id: ticketId,
            technician: req.technician._id,
            status: { $in: ["Assigned", "In-Progress"] },
        });

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found or bill already generated" });
        }

        const finalServiceKey = serviceKey || ticket.serviceKey;
        if (serviceKey && serviceKey !== ticket.serviceKey) {
            const { getServiceByKey } = require("../config/services");
            const srv = getServiceByKey(serviceKey);
            if (srv) {
                ticket.serviceKey = srv.key;
                ticket.serviceLabel = srv.label;
                await ticket.save();
            }
        }

        // Prices come from the DB, never from the request body
        const pricingDoc = await ServicePricing.findOne({ serviceKey: finalServiceKey }).lean();
        const priceMap = new Map(
            (pricingDoc?.itemsList || [])
                .filter((i) => i.isActive)
                .map((i) => [String(i._id), { name: i.name, pricePaise: i.pricePaise }])
        );

        const bill = paymentService.buildBill({
            catalogItems: Array.isArray(catalogItems) ? catalogItems : [],
            customItems: Array.isArray(customItems) ? customItems : [],
            workDone,
            priceMap,
        });

        if (bill.error) {
            return res.status(400).json({ success: false, message: bill.error });
        }

        const invoiceNumber = await paymentService.generateInvoiceNumber();

        let link = null;
        if (method === "online") {
            link = await paymentService.createPaymentLink({
                ticket, amountPaise: bill.totalPaise, invoiceNumber,
            });

            if (!link) {
                return res.status(502).json({
                    success: false,
                    message: "Could not create the payment link. Collect cash instead, or check the gateway settings.",
                });
            }
        }

        // Freeze the commission split at billing time. If the rate changes
        // next month, this job's numbers must not move with it.
        const techData = await technicianModel.findById(req.technician._id).select("commissionRate").lean();
        const commissionPercent = techData?.commissionRate ?? parseInt(process.env.DEFAULT_COMMISSION_RATE) ?? 20;
        const commissionPaise = walletService.calculateCommission(bill.totalPaise, commissionPercent);
        const technicianSharePaise = bill.totalPaise - commissionPaise;

        const previousStatus = ticket.status;

        ticket.billing = {
            invoiceNumber,
            lineItems: bill.lineItems,
            workDone: bill.workDone,
            subtotalPaise: bill.subtotalPaise,
            gstPercent: bill.gstPercent,
            gstPaise: bill.gstPaise,
            totalPaise: bill.totalPaise,
            commissionPercent,
            commissionPaise,
            technicianSharePaise,
            createdByTechnician: req.technician._id,
            billedAt: new Date(),
        };
        ticket.payment = {
            status: "Pending",
            method,
            ...(link ? { razorpayLinkId: link.linkId, razorpayLinkUrl: link.linkUrl } : {}),
        };
        ticket.status = "Payment-Pending";
        ticket.statusHistory.push({
            from: previousStatus,
            to: "Payment-Pending",
            actorRole: "technician",
            actorId: req.technician._id,
            at: new Date(),
        });

        await ticket.save();

        await Payment.create({
            ticket: ticket._id,
            ticketNumber: ticket.ticketNumber,
            invoiceNumber,
            amountPaise: bill.totalPaise,
            method,
            status: "pending",
            // Copied onto the payment so revenue reporting doesn't have to
            // join back to the ticket for every row
            commissionPercent,
            commissionPaise,
            technicianSharePaise,
            ...(link ? { razorpayLinkId: link.linkId, razorpayLinkUrl: link.linkUrl } : {}),
        });

        const itemLines = bill.lineItems
            .map((l) => l.description + " - Rs " + paymentService.paiseToRupees(l.amountPaise))
            .join("\n");

        let message =
            "*INVOICE " + invoiceNumber + "*\n" +
            "Ticket: " + ticket.ticketNumber + "\n" +
            (bill.workDone ? "\nWork done: " + bill.workDone + "\n" : "") +
            "\n" + itemLines + "\n\n";

        if (bill.gstPaise > 0) {
            message += "Subtotal: Rs " + paymentService.paiseToRupees(bill.subtotalPaise) + "\n";
            message += "GST (" + bill.gstPercent + "%): Rs " + paymentService.paiseToRupees(bill.gstPaise) + "\n";
        }
        message += "*Total: Rs " + paymentService.paiseToRupees(bill.totalPaise) + "*\n\n";
        message += link
            ? "Pay here:\n" + link.linkUrl
            : "Please pay Rs " + paymentService.paiseToRupees(bill.totalPaise) + " in cash to the technician.";

        await notification.notifyCustomer({ ticket, text: message });

        return res.status(200).json({
            success: true,
            message: link ? "Invoice sent to customer" : "Invoice generated - collect the cash",
            data: {
                invoiceNumber,
                method,
                totalDisplay: paymentService.paiseToRupees(bill.totalPaise),
                paymentLink: link?.linkUrl || null,
            },
        });
    } catch (error) {
        console.error("Generate bill error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

 // POST /api/technician/tickets/:id/collect-cash

const collectCash = async (req, res) => {
    try {
        const { note } = req.body;

        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            technician: req.technician._id,
            status: "Payment-Pending",
            "payment.method": "cash",
        }).lean();

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: "Ticket not found, or this invoice isn't set to cash payment",
            });
        }

        const updated = await ticketModel.findOneAndUpdate(
            { _id: ticket._id, status: "Payment-Pending" },
            {
                status: "Closed",
                "payment.status": "Collected",
                "payment.collectedAt": new Date(),
                "payment.collectedNote": note ? String(note).trim().slice(0, 200) : undefined,
                $push: {
                    statusHistory: {
                        from: "Payment-Pending", to: "Closed",
                        actorRole: "technician", actorId: req.technician._id,
                        reason: "Cash collected from customer",
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        // Null means someone closed it first - stop before touching the
        // wallet, or the commission gets deducted twice
        if (!updated) {
            return res.status(409).json({ success: false, message: "This ticket was already closed" });
        }

        await Payment.findOneAndUpdate(
            { ticket: ticket._id, status: "pending" },
            {
                status: "collected",
                collectedBy: req.technician._id,
                collectedAt: new Date(),
                note: note ? String(note).trim().slice(0, 200) : undefined,
            }
        );

        // Use the rate frozen on the invoice, not the technician's current
        // rate - the customer was billed against that split
        const commissionPercent = updated.billing?.commissionPercent ?? 20;

        try {
            await walletService.deductCommissionForCashJob(
                req.technician._id,
                updated._id,
                updated.ticketNumber,
                updated.billing?.totalPaise || 0,
                commissionPercent
            );
        } catch (walletErr) {
            console.error("Wallet debit failed for", updated.ticketNumber, walletErr.message);
        }

        await technicianModel.updateOne(
            { _id: req.technician._id },
            { $inc: { completedJobs: 1 } }
        );

        await promoteQueuedTicket(req.technician._id);

        await notification.notifyCustomer({
            ticket: updated,
            text:
                "Payment received - Rs " + paymentService.paiseToRupees(updated.billing?.totalPaise) + "\n" +
                "Invoice: " + updated.billing?.invoiceNumber + "\n\n" +
                "Thank you for choosing Cosmosgen. Ticket " + updated.ticketNumber + " is now closed.",
        });

        notification.notifyAdminsPaymentCollected(updated, req.technician.name);

        return res.status(200).json({ success: true, message: "Cash recorded, job closed", data: updated });
    } catch (error) {
        console.error("Collect cash error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// GET /api/technician/wallet?days=90
// GET /api/technician/wallet?days=90
const getWallet = async (req, res) => {
    try {
        const techId = req.technician._id;

        // How far a technician can go into the red before the office steps in
        const CREDIT_LIMIT_PAISE = -100000;

        const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const [tech, transactions, periodTotals, lifetimeOnline, cashJobsValue] = await Promise.all([
            technicianModel.findById(techId).select("walletBalancePaise commissionRate completedJobs").lean(),

            WalletTransaction.find({ technician: techId })
                .sort({ createdAt: -1 })
                .limit(50)
                .populate("ticket", "ticketNumber serviceLabel")
                .lean(),

            // Split by source so "earned" means work done, not money moved.
            // A payout is a transfer, not income - lumping them together
            // would make the earnings number meaningless.
            WalletTransaction.aggregate([
                { $match: { technician: techId, createdAt: { $gte: since } } },
                { $group: { _id: "$source", total: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
            ]),

            WalletTransaction.aggregate([
                { $match: { technician: techId, source: "job_online" } },
                { $group: { _id: null, total: { $sum: "$amountPaise" } } },
            ]),

            ticketModel.aggregate([
                {
                    $match: {
                        technician: techId,
                        status: "Closed",
                        "payment.method": "cash",
                        updatedAt: { $gte: since },
                    },
                },
                { $group: { _id: null, total: { $sum: "$billing.totalPaise" } } },
            ]),
        ]);

        const bySource = {};
        periodTotals.forEach((t) => { bySource[t._id] = { total: t.total, count: t.count }; });

        // Online jobs credit the technician's share directly. Cash jobs leave
        // the whole amount with them and only debit the commission - so their
        // earning there is the job value minus that commission.
        const onlineEarnedPaise = bySource.job_online?.total || 0;
        const cashCommissionPaise = bySource.job_cash?.total || 0;
        const cashEarnedPaise = (cashJobsValue[0]?.total || 0) - cashCommissionPaise;
        const totalEarnedPaise = onlineEarnedPaise + cashEarnedPaise;

        const balance = tech?.walletBalancePaise || 0;
        const owedPaise = Math.abs(Math.min(0, balance));

        return res.status(200).json({
            success: true,
            data: {
                balancePaise: balance,
                balanceDisplay: paymentService.paiseToRupees(Math.abs(balance)),
                direction: balance >= 0 ? "company_owes" : "you_owe",

                owedPaise,
                canPayOnline: owedPaise > 0 && paymentService.isRazorpayActive(),

                limitPaise: CREDIT_LIMIT_PAISE,
                limitDisplay: paymentService.paiseToRupees(Math.abs(CREDIT_LIMIT_PAISE)),
                nearLimit: balance <= CREDIT_LIMIT_PAISE * 0.7,

                commissionRate: tech?.commissionRate ?? parseInt(process.env.DEFAULT_COMMISSION_RATE) ?? 20,

                period: {
                    days,
                    totalEarnedDisplay: paymentService.paiseToRupees(totalEarnedPaise),
                    onlineEarnedDisplay: paymentService.paiseToRupees(onlineEarnedPaise),
                    cashEarnedDisplay: paymentService.paiseToRupees(cashEarnedPaise),
                    commissionPaidDisplay: paymentService.paiseToRupees(cashCommissionPaise),
                    settledDisplay: paymentService.paiseToRupees(bySource.recharge?.total || 0),
                    payoutsDisplay: paymentService.paiseToRupees(bySource.payout?.total || 0),
                    jobsCount: (bySource.job_online?.count || 0) + (bySource.job_cash?.count || 0),
                },

                lifetime: {
                    onlineDisplay: paymentService.paiseToRupees(lifetimeOnline[0]?.total || 0),
                    completedJobs: tech?.completedJobs || 0,
                },

                transactions: transactions.map((t) => ({
                    ...t,
                    amountDisplay: paymentService.paiseToRupees(t.amountPaise),
                    balanceAfterDisplay: paymentService.paiseToRupees(Math.abs(t.balanceAfterPaise)),
                })),
            },
        });
    } catch (error) {
        console.error("Get wallet error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// GET /api/technician/tickets/:id/payment-status
// GET /api/technician/tickets/:id/payment-status
const getPaymentStatus = async (req, res) => {
    try {
        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            technician: req.technician._id,
        }).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found" });
        }

        if (["Paid", "Collected", "Verified"].includes(ticket.payment?.status) || ticket.status === "Closed") {
            return res.status(200).json({
                success: true,
                data: {
                    isPaid: true,
                    status: "paid",
                    paymentId: ticket.payment?.razorpayPaymentId,
                    method: ticket.payment?.method,
                    paidAt: ticket.payment?.paidAt || ticket.payment?.collectedAt,
                    amountDisplay: paymentService.paiseToRupees(ticket.billing?.totalPaise),
                },
            });
        }

        const linkId = ticket.payment?.razorpayLinkId;
        if (!linkId) {
            return res.status(400).json({ success: false, message: "No payment link on this ticket" });
        }

        const status = await paymentService.fetchPaymentLinkStatus(linkId);
        if (!status) {
            return res.status(502).json({ success: false, message: "Could not reach the payment gateway" });
        }

        if (status.isPaid && ticket.status === "Payment-Pending") {
            // findOneAndUpdate returns null when the filter matches nothing,
            // which is how we detect that the webhook already closed this
            // ticket and credited the wallet. updateOne gave no such signal,
            // so this path used to credit the technician a second time.
            const closed = await ticketModel.findOneAndUpdate(
                { _id: ticket._id, status: "Payment-Pending" },
                {
                    status: "Closed",
                    "payment.status": "Paid",
                    "payment.razorpayPaymentId": status.paymentId,
                    "payment.method": status.method || "online",
                    "payment.paidAt": status.paidAt || new Date(),
                    $push: {
                        statusHistory: {
                            from: "Payment-Pending", to: "Closed",
                            actorRole: "system",
                            reason: "Payment confirmed via gateway status check",
                            at: new Date(),
                        },
                    },
                },
                { returnDocument: "after" }
            ).lean();

            if (!closed) {
                // Webhook got here first - it has already done all of this
                return res.status(200).json({
                    success: true,
                    data: {
                        ...status,
                        amountDisplay: paymentService.paiseToRupees(ticket.billing?.totalPaise),
                    },
                });
            }

            // The webhook carries the exact gateway fee. This path doesn't
            // have it, so estimate - the webhook overwrites it when it lands.
            const { feePaise, taxPaise } = estimateGatewayFee(closed.billing?.totalPaise || 0);

            await Payment.findOneAndUpdate(
                { ticket: ticket._id, status: "pending" },
                {
                    status: "collected",
                    razorpayPaymentId: status.paymentId,
                    method: status.method || "online",
                    collectedBy: req.technician._id,
                    collectedAt: status.paidAt || new Date(),
                    gatewayFeePaise: feePaise,
                    gatewayTaxPaise: taxPaise,
                }
            );

            const commissionPercent = closed.billing?.commissionPercent ?? 20;

            try {
                await walletService.addEarningsForOnlineJob(
                    req.technician._id,
                    closed._id,
                    closed.ticketNumber,
                    closed.billing?.totalPaise || 0,
                    commissionPercent
                );
            } catch (walletErr) {
                console.error("Wallet credit failed for", closed.ticketNumber, walletErr.message);
            }

            await technicianModel.updateOne({ _id: req.technician._id }, { $inc: { completedJobs: 1 } });
            await promoteQueuedTicket(req.technician._id);
        }

        return res.status(200).json({
            success: true,
            data: { ...status, amountDisplay: paymentService.paiseToRupees(ticket.billing?.totalPaise) },
        });
    } catch (error) {
        console.error("Payment status error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};


/**
 * POST /api/technician/wallet/recharge
 * body: { amountRupees }
 *
 * Lets a technician clear what they owe from the app instead of carrying
 * cash to the office. The wallet is only credited by the webhook, never
 * here - creating a link is not the same as being paid.
 */
const createWalletRecharge = async (req, res) => {
    try {
        if (!paymentService.isRazorpayActive()) {
            return res.status(503).json({
                success: false,
                message: "Online payment isn't set up yet. Please deposit the cash at the office.",
            });
        }

        const tech = await technicianModel.findById(req.technician._id)
            .select("name phone walletBalancePaise")
            .lean();

        const owedPaise = Math.abs(Math.min(0, tech?.walletBalancePaise || 0));

        if (owedPaise <= 0) {
            return res.status(400).json({ success: false, message: "You don't owe anything right now" });
        }

        const requested = req.body.amountRupees
            ? Math.round(Number(req.body.amountRupees) * 100)
            : owedPaise;

        if (!Number.isFinite(requested) || requested < 100) {
            return res.status(400).json({ success: false, message: "Enter an amount of at least Rs 1" });
        }

        const amountPaise = Math.min(requested, owedPaise);

        const link = await paymentService.createWalletRechargeLink({
            technician: tech,
            amountPaise,
        });

        if (!link) {
            return res.status(502).json({
                success: false,
                message: "Could not create the payment link. Try again shortly.",
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                linkUrl: link.linkUrl,
                linkId: link.linkId,
                amountDisplay: paymentService.paiseToRupees(amountPaise),
            },
        });
    } catch (error) {
        console.error("Wallet recharge error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// GET /api/technician/wallet/recharge/:linkId
// Polled while the payment window is open so the panel updates without
// waiting for the technician to refresh
const checkWalletRecharge = async (req, res) => {
    try {
        const status = await paymentService.fetchPaymentLinkStatus(req.params.linkId);
        if (!status) {
            return res.status(502).json({ success: false, message: "Could not reach the payment gateway" });
        }

        const tech = await technicianModel.findById(req.technician._id)
            .select("walletBalancePaise")
            .lean();

        return res.status(200).json({
            success: true,
            data: {
                isPaid: status.isPaid,
                balancePaise: tech?.walletBalancePaise || 0,
                balanceDisplay: paymentService.paiseToRupees(Math.abs(tech?.walletBalancePaise || 0)),
            },
        });
    } catch (error) {
        console.error("Check recharge error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};


module.exports = {
    registerTechnician,
    loginTechnician,
    logoutTechnician,
    getTechProfile,
    bootstrap,
    getCashDeposits,
    updateTechProfile,
    deleteTechProfile,
    updateStatus,
    // updateLocation,
    // getMyAssignedTicket,
    // getCompletedTickets,
    startWork,
    getWallet,
    releaseTicket,
    getPricing,
    generateBill,
    collectCash,
    getPaymentStatus,
    startScheduledNow,
    createWalletRecharge,
    checkWalletRecharge,
    verifyPhone,
    checkIfsc
};
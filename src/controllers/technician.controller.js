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
const invoiceService = require("../services/invoice.service");
const otpService = require("../services/otp.service");
const signupOtpService = require("../services/signupOtp.service");
const { findCity } = require("../config/cities");
const whatsapp = require("../services/whatsapp.service");
const voiceController = require("./voice.controller");
const { promoteQueuedTicket, releaseQueueOf } = require("../services/dispatch.service");
const { recordDecline, isSuspended } = require("../services/discipline.service");
const rideService = require("../services/ride.service");
const { emitToRoom, userRoom, techRoom, adminRoom, dropRoom } = require("../sockets/socket.instance");
const walletService = require("../services/wallet.service");
const settingsService = require("../services/settings.service");
const { estimateGatewayFee } = require("../config/razorpay");
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
    "_id name phone state city area pincode skills profileImage rating isAvailable availabilitySince lastAwayMs activeTicket completedJobs performanceLevel createdAt suspendedUntil declines.today declines.total";

const ACTIVE_STATUSES = ["Assigned", "In-Progress", "Payment-Pending"];

const signToken = (techId) =>
    jwt.sign({ techId, role: "technician" }, process.env.JWT_SECRET, { expiresIn: "7d" });

const ifscCache = new Map();



/* ================= AUTH ================= */

const registerTechnician = async (req, res) => {
    try {
        const {
            phoneToken, name, password, email,
            pincode, state, city, area, lat, lon,
            skills, hasVehicle,
            accountHolderName, accountNumber, ifsc,
        } = req.body;

        const verified = await verifiedSignupPhone({ phoneToken });
        if (!verified) {
            return res.status(401).json({
                success: false,
                message: "Your phone verification expired. Please start again.",
            });
        }

        if (!name || !password || !state || !city || !area || !skills?.length) {
            return res.status(400).json({ success: false, message: "Please fill in all the required details" });
        }

        /*
         * The town is taken as sent, now that Google is what suggests it.
         *
         * It used to be checked against `config/cities.js` and refused if it
         * was not in there. That list is still the fallback the form falls
         * back to, but it is no longer the whole world: the office asked for
         * Google on every suggestion, and Google knows towns this company has
         * not written down yet. Refusing those would mean a vendor picking a
         * suggestion the form itself offered him and being told no.
         *
         * What is still checked is that something arrived for each field, and
         * that the pincode is six digits - which is the difference between a
         * filled form and a broken one.
         */
        const town = findCity(city);

        const cleanPin = String(pincode || "").replace(/\D/g, "").slice(0, 6);
        const finalPin = cleanPin.length === 6
            ? cleanPin
            : (town ? town.pincode : "");

        if (!finalPin) {
            return res.status(400).json({
                success: false,
                message: "We need your six digit pincode.",
            });
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
            .select("_id isBlacklisted isDeleted")
            .lean();

        if (existing?.isBlacklisted) {
            return res.status(403).json({ success: false, message: "This number cannot be registered." });
        }

        // Same reasoning as the check at the start of signup - a deleted
        // account is not allowed to hold its own number hostage
        if (existing?.isDeleted) {
            await technicianModel.deleteOne({ _id: existing._id });
        } else if (existing) {
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
            pincode: finalPin,
            state: String(state).trim(),
            city: String(city).trim(),
            area: String(area).trim(),
            skills: Array.isArray(skills) ? skills : (skills ? JSON.parse(skills) : []),
            hasVehicle: hasVehicle === 'true' || hasVehicle === true,
            approvalStatus: "pending",
            phoneVerifiedAt: new Date(),
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

        // The office has an Applications tab that this belongs in, and until
        // somebody approves it the man cannot sign in - so it has to announce
        // itself rather than wait to be found on the next page load.
        emitToRoom(adminRoom(), "technician:new", {
            _id: newTech._id,
            name: newTech.name,
            city: newTech.city,
        });

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
 * Whether this number is free to register, said once so every route that
 * asks gives the same answer.
 *
 * Returns a response body to send back, or null when the number is clear.
 */
const signupBlockedFor = async (phone) => {
    const existing = await technicianModel
        .findOne({ phone })
        .select("_id isBlacklisted approvalStatus isDeleted")
        .lean();

    /*
     * A deleted account does not hold the number hostage.
     *
     * The phone is unique on this collection, so a soft-deleted row kept
     * refusing its own owner for the length of the grace period - somebody who
     * left on Monday and thought better of it on Tuesday was told his number
     * was "already registered" and given no way forward. The grace period is
     * there to protect the office's records, not to lock a person out.
     *
     * Removed rather than revived, because coming back is a fresh
     * registration: the office approves it again, and the skills and bank
     * details are asked for as they are today rather than as they were.
     * Tickets keep their own copy of who did the work, so nothing readable is
     * lost by this.
     */
    if (existing?.isDeleted && !existing.isBlacklisted) {
        await technicianModel.deleteOne({ _id: existing._id });
        return null;
    }

    if (existing?.isBlacklisted) {
        return {
            status: 403,
            body: {
                success: false,
                message: "This number cannot be registered. Contact the office if you think this is a mistake.",
            },
        };
    }

    if (existing) {
        return {
            status: 409,
            body: {
                success: false,
                alreadyRegistered: true,
                approvalStatus: existing.approvalStatus,
                message: existing.approvalStatus === "pending"
                    ? "This number is already registered and waiting for approval."
                    : "This number is already registered. Please sign in instead.",
            },
        };
    }

    return null;
};

/**
 * POST /api/technician/signup-otp
 * body: { phone }
 *
 * Phase 1, for the app and the web panel alike. WhatsApp is already the
 * channel every customer on this platform is reached on, so the code goes
 * there rather than by SMS, and the button says so.
 */
const sendSignupOtp = async (req, res) => {
    try {
        const phone = String(req.body.phone || "").replace(/\D/g, "").slice(-10);

        if (!/^[6-9]\d{9}$/.test(phone)) {
            return res.status(400).json({ success: false, message: "Enter a valid 10 digit mobile number" });
        }

        const blocked = await signupBlockedFor(phone);
        if (blocked) return res.status(blocked.status).json(blocked.body);

        const issued = signupOtpService.issue(phone);
        if (issued.wait) {
            return res.status(429).json({
                success: false,
                retryAfter: issued.wait,
                message: "A code has just gone out. Wait " + issued.wait + " seconds before asking again.",
            });
        }

        const sent = await whatsapp.sendText(
            phone,
            "Your Cosmosgen vendor code is *" + issued.code + "*\n\n" +
            "Type it into the app to confirm this number. It is good for ten minutes.\n\n" +
            "If you did not ask to register, ignore this message."
        );

        if (!sent) {
            return res.status(502).json({
                success: false,
                message: "Could not send the code on WhatsApp. Try again, or call the office.",
            });
        }

        return res.status(200).json({
            success: true,
            retryAfter: Math.ceil(signupOtpService.RESEND_AFTER_MS / 1000),
            message: "Code sent on WhatsApp",
        });
    } catch (error) {
        console.error("Send signup OTP error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/technician/signup-otp/verify
 * body: { phone, code }
 *
 * Hands back a short-lived signed token rather than a "verified" flag. The
 * registration request that follows carries it, so the number on the new
 * account is one this server itself sent a code to - not one typed into the
 * final form.
 */
const verifySignupOtp = async (req, res) => {
    try {
        const phone = String(req.body.phone || "").replace(/\D/g, "").slice(-10);
        const result = signupOtpService.check(phone, req.body.code);

        if (!result.ok) {
            return res.status(400).json({ success: false, message: result.message });
        }

        const blocked = await signupBlockedFor(phone);
        if (blocked) return res.status(blocked.status).json(blocked.body);

        const phoneToken = jwt.sign(
            { phone, purpose: "tech-signup" },
            process.env.JWT_SECRET,
            { expiresIn: "30m" }
        );

        return res.status(200).json({
            success: true,
            data: { phone, phoneToken },
            message: "Number verified",
        });
    } catch (error) {
        console.error("Verify signup OTP error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * The number behind a completed registration.
 *
 * There used to be two ways in: Firebase phone auth for the web panel and our
 * own WhatsApp code for the app, each ending in a different kind of token and
 * a different definition of "this number is really yours". Two answers to one
 * question is one more than a signup should have, and the Firebase half
 * carried an SMS bill, a reCAPTCHA on the page and a second vendor account to
 * keep alive - for a number we were already proving ourselves.
 *
 * Both surfaces send the same six digits over WhatsApp now and come back with
 * the same short-lived token, signed here. Nothing trusts a phone number that
 * simply arrived in the request body.
 */
const verifiedSignupPhone = async ({ phoneToken }) => {
    if (!phoneToken) return null;

    try {
        const decoded = jwt.verify(phoneToken, process.env.JWT_SECRET);

        if (decoded?.purpose === "tech-signup" && decoded.phone) {
            return { phone: decoded.phone };
        }
    } catch {
        return null;
    }

    return null;
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

        const token = signToken(technician._id);
        res.cookie("techToken", token, cookieOptions);

        const data = await technicianModel.findById(technician._id).select(PUBLIC_FIELDS).lean();

        // The browser ignores this and uses the cookie above; the mobile app
        // stores it and sends it as a bearer header, having no cookie jar.
        return res.status(200).json({ success: true, message: "Login successful", data, token });
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
                .select("ticketNumber serviceKey serviceLabel selectedIssues problemDescription customerSnapshot location ride refusal status billing payment scheduling createdAt assignedAt acceptedAt")
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
                .select("ticketNumber serviceLabel problemDescription customerSnapshot queuedAt acceptedAt")
                .sort({ queuedAt: 1 })
                .lean(),

            // Dated work is scheduled - the technician can pull it forward
            ticketModel
                .find({
                    technician: techId,
                    status: "Queued",
                    "scheduling.scheduledFor": { $ne: null },
                })
                .select("ticketNumber serviceLabel problemDescription customerSnapshot scheduling queuedAt acceptedAt")
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

                // Offered on the job card when a refusal is confirmed, so the
                // technician sees the figure before he agrees to ask for it
                visitChargePaise: (await settingsService.getSetting("VISIT_CHARGE_RUPEES")) * 100,
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
        const { name, state, city, area, pincode } = req.body;

        const updateData = {};
        if (name) updateData.name = String(name).trim();
        if (state) updateData.state = String(state).trim();
        if (area) updateData.area = String(area).trim();

        // Changing town moves the state with it, for the same reason it does
        // at registration: the two are one fact, not two the vendor can
        // disagree with themselves about
        // Same reasoning as registration: Google suggests the town, so the
        // town is taken as sent rather than checked against our own list
        if (city) updateData.city = String(city).trim();
        if (state) updateData.state = String(state).trim();
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
            .findByIdAndUpdate(techId, updateData, { returnDocument: "after", runValidators: true })
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
            // The clock the office sees, and the one Mongo's TTL index reads
            deletedAt: new Date(),
        });

        // The cookie goes, and so does the live socket - which the cookie
        // has no say over, having been authorised when it opened
        dropRoom(techRoom(techId));

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

        /*
         * The clock only moves when the answer does.
         *
         * Writing the timestamp on every call would mean a vendor who presses
         * the switch twice by accident looks like they only just came back,
         * and the office loses the one thing it wanted to know. So the stretch
         * starts when the state actually changes, and the length of the
         * absence just ended is kept on the way back in - that is the figure
         * nobody can reconstruct later, because the moment it began is about
         * to be overwritten.
         */
        const previous = await technicianModel
            .findById(req.technician._id)
            .select("isAvailable availabilitySince")
            .lean();

        const changed = !previous || previous.isAvailable !== isAvailable;
        const since = previous?.availabilitySince;

        const patch = { isAvailable };

        if (changed) {
            patch.availabilitySince = new Date();

            // Coming back from an absence we know the start of
            if (isAvailable && since) {
                patch.lastAwayMs = Math.max(0, Date.now() - new Date(since).getTime());
            }
        }

        const updatedTech = await technicianModel
            .findByIdAndUpdate(req.technician._id, patch, { returnDocument: "after" })
            .select(PUBLIC_FIELDS)
            .lean();

        emitToRoom("admins", "tech:status", updatedTech);

        // Going offline should cost us nothing to keep alive.
        //
        // The panel holding this socket is told to drop it, and so is any
        // other tab or phone the same vendor left signed in - otherwise a
        // forgotten open tab keeps a connection on the server for a man who
        // stopped working hours ago. The client disconnects itself rather
        // than being cut off, because a socket the server drops is one the
        // client immediately tries to reconnect.
        if (!isAvailable) {
            emitToRoom(techRoom(req.technician._id), "session:offline", {
                reason: "You are offline. The panel will reconnect when you go back online.",
            });
        }

        return res.status(200).json({ success: true, data: updatedTech });
    } catch (error) {
        console.error("Update status error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * PUT /api/technician/push-token
 *
 * Where to reach this phone once the app is closed. The app sends it on every
 * start, because a token can be reissued by the platform at any time and the
 * one we hold is only as good as the last time it was confirmed.
 *
 * An empty body clears it, which is what signing out does - a phone that has
 * been handed back or signed out of must stop ringing for somebody else's
 * jobs.
 */
const savePushToken = async (req, res) => {
    try {
        const token = String(req.body?.token || "").trim();

        await technicianModel.updateOne(
            { _id: req.technician._id },
            token ? { $set: { pushToken: token } } : { $unset: { pushToken: 1 } }
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Push token not saved:", error.message);
        return res.status(500).json({ success: false, message: "Could not save the push token." });
    }
};

const updateLocation = async (req, res) => {
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

        // The admin panel needs this live, not on the next poll. Scoped to the
        // admin room only - no other technician has any business knowing where
        // this one is.
        emitToRoom(adminRoom(), "technician:location", {
            technicianId: String(req.technician._id),
            name: req.technician.name,
            lat,
            lon,
            at: new Date(),
        });

        // Same ride handling as the socket ping, so a client that falls back
        // to REST still gets its route, ETA and arrival message.
        await rideService.syncRideProgress(req.technician, lat, lon);

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Update location error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/technician/tickets/:id/on-the-way
 *
 * Tapping Directions is what says somebody has set off.
 *
 * It used to be the first GPS fix after assignment, which announced a vendor
 * as travelling because his phone had reported where he was standing. This is
 * a decision instead, taken by the person taking it, and it is the moment the
 * customer's page gets a bike, a route and an estimate.
 *
 * Safe to call twice: the app fires it beside opening Google Maps, and a
 * second tap is a vendor checking the road again, not a second departure.
 */
const startOnTheWay = async (req, res) => {
    try {
        const result = await rideService.markOnTheWay(
            req.technician._id,
            req.params.id,

            // The app sends its last fix with the tap, because the moment it
            // hands over to Google Maps its own GPS watcher stops.
            { lat: req.body?.lat, lon: req.body?.lon }
        );

        if (!result.ok) {
            return res.status(404).json({
                success: false,
                message: "That job is not assigned to you, or it has already moved on.",
            });
        }

        return res.status(200).json({
            success: true,
            already: Boolean(result.already),
            message: result.already ? "Already on the way" : "The customer can see you coming",
        });
    } catch (error) {
        console.error("On the way error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/* ================= TICKETS ================= */

/**
 * Rings the customer about a finished job.
 *
 * Held back a few minutes on purpose. A feedback call the instant the
 * technician takes the cash reaches a customer with him still standing in the
 * doorway, and nobody says what they actually think in front of the person
 * they are rating.
 *
 * A timer in the web process is the weak part of this: a restart before it
 * fires loses the call. It is the right trade for now - a dropped feedback
 * call costs a rating, not a booking - but this is the piece to move onto a
 * proper queue first.
 */
const scheduleFeedbackCall = (ticket) => {
    if (!ticket || ticket.status !== "Closed") return;

    const delayMs = (Number(process.env.FEEDBACK_CALL_DELAY_MIN) || 10) * 60 * 1000;

    setTimeout(() => {
        voiceController
            .placeCall({ ticket, purpose: "feedback" })
            .catch((err) => console.error("[VOICE] feedback call failed:", err.message));
    }, delayMs).unref?.();
};

/* ================= DOOR CODES ================= */

/**
 * POST /api/technician/tickets/:id/otp/:purpose   (purpose: start | close)
 *
 * Sends the customer a six digit code. The technician never sees it - he has
 * to be in front of them to be told it, which is the entire point: it is what
 * stops a job being started from the car park or closed from the road.
 */
const sendJobOtp = async (req, res) => {
    try {
        const purpose = req.params.purpose === "close" ? "close" : "start";

        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            technician: req.technician._id,
            status: { $in: ["Assigned", "In-Progress"] },
        });

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Job not found, or it is not yours to work on." });
        }

        if (purpose === "close" && ticket.status !== "In-Progress") {
            return res.status(400).json({ success: false, message: "Start the job before asking to close it." });
        }

        const block = otpService.issue();
        ticket.otp = ticket.otp || {};
        ticket.otp[purpose] = block;
        await ticket.save();

        await notification.sendCustomerOtp(ticket, block.code, purpose);

        return res.status(200).json({
            success: true,
            message: "Code sent to the customer on WhatsApp. Ask them to read it out.",
            data: { sentAt: block.sentAt, purpose },
        });
    } catch (error) {
        console.error("Send job OTP error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * Checks a code and records the attempt on the ticket.
 *
 * Returns null when it passed, or a ready-made response when it did not, so a
 * caller can guard itself in one line and every gate answers the technician
 * the same way.
 */
const guardOtp = async (ticket, purpose, entered) => {
    const block = ticket.otp?.[purpose];
    const result = otpService.check(block, entered);

    if (result.ok) {
        if (!block.verifiedAt) {
            await ticketModel.updateOne(
                { _id: ticket._id },
                { $set: { ["otp." + purpose + ".verifiedAt"]: new Date() } }
            );
        }
        return null;
    }

    // A wrong or malformed code costs an attempt; a code that was never sent,
    // or one that has already expired, is not the technician failing a check.
    if (result.reason === "mismatch" || result.reason === "malformed") {
        await ticketModel.updateOne({ _id: ticket._id }, { $inc: { ["otp." + purpose + ".attempts"]: 1 } });
    }

    return { status: 400, body: { success: false, message: result.message, reason: result.reason } };
};

const startWork = async (req, res) => {
    try {
        // The customer has to say the word before the clock starts. Checked
        // against the ticket before anything is written, so a wrong code
        // leaves the job exactly where it was.
        const before = await ticketModel
            .findOne({ _id: req.params.id, technician: req.technician._id, status: "Assigned" })
            .select("otp")
            .lean();

        if (!before) {
            return res.status(404).json({ success: false, message: "Ticket not found or already started" });
        }

        const blocked = await guardOtp(before, "start", req.body?.otp);
        if (blocked) return res.status(blocked.status).json(blocked.body);

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

/**
 * POST /api/technician/tickets/:id/accept
 *
 * The technician agrees to do the job.
 *
 * Assigning is the office's decision and it does not need his permission -
 * the ticket is his either way, and it stays his until he hands it back or
 * the office moves it. What this changes is only who has been told.
 *
 * Before it, the customer knows nothing: not the technician's name, not his
 * number, not the tracking link. That is deliberate. The old flow introduced
 * a technician the moment the office picked one, so a job that was turned
 * down and handed to somebody else produced two introductions and one very
 * confused customer. Mohan's rule is that the customer hears once, about the
 * person who is actually coming.
 *
 * There is no timer on it. A technician in somebody's kitchen should not lose
 * a job because he did not look at his phone for three minutes, and a job in
 * the same street as the one he is on is exactly the job he should get. It
 * waits until he answers it or hands it back.
 */
const acceptTicket = async (req, res) => {
    try {
        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            technician: req.technician._id,
            status: { $in: ["Queued", "Assigned"] },
        }).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Job not found or not currently yours" });
        }

        // Accepting twice is not an error - a slow network and an impatient
        // thumb produce it often - but the customer must only hear once.
        if (ticket.acceptedAt) {
            return res.status(200).json({ success: true, message: "Already accepted", data: ticket });
        }

        const now = new Date();

        const updated = await ticketModel.findOneAndUpdate(
            { _id: ticket._id, technician: req.technician._id, acceptedAt: null },
            {
                acceptedAt: now,
                $push: {
                    statusHistory: {
                        from: ticket.status,
                        to: ticket.status,
                        actorRole: "technician",
                        actorId: req.technician._id,
                        reason: "Accepted the job",
                        at: now,
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        // Lost the race to another request of his own. Nothing to do and
        // nothing to say - the customer has already been told by that one.
        if (!updated) {
            return res.status(200).json({ success: true, message: "Already accepted", data: ticket });
        }

        await notification.notifyCustomerAccepted(updated);

        return res.status(200).json({
            success: true,
            message: "Accepted. The customer has been told you are coming.",
            data: updated,
        });
    } catch (error) {
        console.error("Accept ticket error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * The technician hands a job back.
 *
 * Two different things arrive here as one: "I cannot do this job" and "the
 * customer heard the price and refused". Both leave this technician, but they
 * are not the same event and the office needs to tell them apart - a refusal
 * means someone should ring the customer before another technician is sent
 * out to hear the same no.
 *
 * Neither one cancels the job. Closing a ticket is the office's decision, not
 * the technician's: a refusal on the doorstep is often just a price the
 * customer wants to talk about, and a technician who can cancel can also make
 * a job disappear and finish it privately. The ticket goes back to the office
 * flagged for what happened, and they choose - reassign, reschedule, or
 * cancel.
 */
const releaseTicket = async (req, res) => {
    try {
        const { reason } = req.body;
        const customerRefused = req.body.outcome === "customer_refused";

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

        // Both outcomes return the ticket to the office. Only the office can
        // cancel one.
        const updated = await ticketModel.findByIdAndUpdate(
            ticket._id,
            {
                status: "Pending",
                technician: null,
                technicianSnapshot: {},
                assignedBy: null,
                assignedAt: null,
                acceptedAt: null,
                queuedAt: null,
                rejection: {
                    rejectedByName: req.technician.name,
                    reason: String(reason).trim(),
                    rejectedAt: new Date(),
                    wasScheduled,
                    outcome: customerRefused ? "customer_refused" : "cannot_do",
                },
                // The ride belongs to the technician who is walking away from
                // this job. Leaving it behind makes the next technician's card
                // open on "I have arrived", with a route drawn from a starting
                // point that was never theirs.
                $unset: { ride: 1 },
                $push: {
                    statusHistory: {
                        from: ticket.status,
                        to: "Pending",
                        actorRole: "technician",
                        actorId: req.technician._id,
                        reason: (customerRefused ? "Customer refused: " : "Declined: ") + String(reason).trim(),
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        /*
         * Counted, but only when it was his decision.
         *
         * "The customer heard the price and said no" is not a refusal by this
         * technician - it arrived through him, and counting it would teach him
         * to stop reporting it, which is the last thing the office wants.
         */
        const discipline = customerRefused
            ? { suspended: false }
            : await recordDecline(req.technician._id, ticket, reason);

        if (discipline.suspended) {
            /*
             * Paused, so nothing else may be handed to him today.
             *
             * His queue goes back to the office with him. Leaving it would
             * park real customers behind somebody who cannot work until
             * tomorrow, and they would find that out by waiting.
             */
            await releaseQueueOf(req.technician._id, "Technician paused after " + discipline.counted + " refusals today");

            await technicianModel.updateOne(
                { _id: req.technician._id },
                { isAvailable: false, activeTicket: null }
            );

            notification.notifyAdminsTechnicianPaused(
                req.technician,
                discipline.counted,
                discipline.until
            );
        } else if (wasActive) {
            // Only pull in their next job if this was the one they were on
            await promoteQueuedTicket(req.technician._id);
        }

        notification.notifyAdminsTicketRejected(
            updated,
            req.technician.name,
            (customerRefused ? "Customer refused: " : "") + String(reason).trim()
        );

        return res.status(200).json({
            success: true,
            suspended: Boolean(discipline.suspended),
            suspendedUntil: discipline.until || null,
            message: discipline.suspended
                ? "That is " + discipline.counted + " jobs turned down today. Your account is paused until tomorrow morning."
                : customerRefused
                    ? "Recorded. The office will speak to the customer before anyone else goes."
                    : "The office has been notified",
            data: updated,
        });
    } catch (error) {
        console.error("Release ticket error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/technician/tickets/:id/refuse
 *
 * The customer heard the price and said no, with the technician still on the
 * doorstep. He does not leave and the job does not move: the office rings the
 * customer to find out what the real objection was, and he waits for the
 * answer. If they are talked round he simply carries on - the whole reason
 * for holding him there is that a second visit costs another trip.
 *
 * He cannot end the job either way. All he can do is say what happened.
 */
const refuseTicket = async (req, res) => {
    try {
        const { reason } = req.body;

        if (!reason || String(reason).trim().length < 5) {
            return res.status(400).json({ success: false, message: "Say why the customer refused" });
        }

        const updated = await ticketModel.findOneAndUpdate(
            {
                _id: req.params.id,
                technician: req.technician._id,
                status: { $in: ["Assigned", "In-Progress"] },
                "refusal.status": { $ne: "awaiting_verification" },
            },
            {
                refusal: {
                    raisedAt: new Date(),
                    raisedBy: req.technician._id,
                    raisedByName: req.technician.name,
                    reason: String(reason).trim(),
                    status: "awaiting_verification",
                    visitChargeBilled: false,
                },
                $push: {
                    statusHistory: {
                        from: "In-Progress",
                        to: "In-Progress",
                        actorRole: "technician",
                        actorId: req.technician._id,
                        reason: "Customer refused the quote: " + String(reason).trim(),
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        if (!updated) {
            return res.status(404).json({
                success: false,
                message: "Job not found, not yours, or already waiting on the office",
            });
        }

        notification.notifyAdminsCustomerRefused(updated, req.technician.name, String(reason).trim());

        return res.status(200).json({
            success: true,
            message: "The office is calling the customer. Please wait there.",
            data: updated,
        });
    } catch (error) {
        console.error("Refuse ticket error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/technician/tickets/:id/visit-charge
 *
 * The office confirmed the customer will not go ahead, so the trip is billed
 * on its own. The commission on it is whatever the owner has set - zero by
 * default, because the technician burned the fuel and taking a share of the
 * only thing he earned on a wasted trip costs more in goodwill than it makes.
 */
const billVisitCharge = async (req, res) => {
    try {
        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            technician: req.technician._id,
            status: { $in: ["Assigned", "In-Progress"] },
            "refusal.status": "customer_declined",
        });

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: "This job isn't waiting on a visit charge",
            });
        }

        if (ticket.refusal?.visitChargeBilled) {
            return res.status(400).json({ success: false, message: "The visit charge is already raised" });
        }

        const rupees = await settingsService.getSetting("VISIT_CHARGE_RUPEES");
        const commissionPercent = await settingsService.getSetting("VISIT_COMMISSION_PERCENT");

        if (!rupees || rupees <= 0) {
            return res.status(400).json({
                success: false,
                message: "No visit charge is set up. Ask the office.",
            });
        }

        const bill = paymentService.buildBill({
            customItems: [{ description: "Visit charge", amountRupees: rupees }],
            workDone: "Visited and quoted. Customer did not go ahead.",
            priceMap: new Map(),
        });

        if (bill.error) {
            return res.status(400).json({ success: false, message: bill.error });
        }

        const invoiceNumber = await paymentService.generateInvoiceNumber();
        const commissionPaise = walletService.calculateCommission(bill.totalPaise, commissionPercent);

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
            technicianSharePaise: bill.totalPaise - commissionPaise,
            createdByTechnician: req.technician._id,
            billedAt: new Date(),
            editCount: 0,
            editHistory: [],
        };

        // Cash only. Sending a payment link to a customer who just refused to
        // spend anything, and then waiting on the doorstep for them to open
        // it, is not a thing to build a flow around.
        ticket.payment = { status: "Pending", method: "cash" };
        ticket.status = "Payment-Pending";
        ticket.refusal.visitChargeBilled = true;
        ticket.statusHistory.push({
            from: "In-Progress",
            to: "Payment-Pending",
            actorRole: "technician",
            actorId: req.technician._id,
            reason: "Visit charge raised after the customer declined",
            at: new Date(),
        });

        await ticket.save();

        await Payment.findOneAndUpdate(
            { ticket: ticket._id },
            {
                ticket: ticket._id,
                ticketNumber: ticket.ticketNumber,
                invoiceNumber,
                amountPaise: bill.totalPaise,
                method: "cash",
                status: "pending",
                isVisitCharge: true,
                commissionPercent,
                commissionPaise,
                technicianSharePaise: bill.totalPaise - commissionPaise,
            },
            { upsert: true }
        );

        await notification.notifyCustomer({
            ticket,
            text:
                "*VISIT CHARGE " + invoiceNumber + "*\n" +
                "Ticket: " + ticket.ticketNumber + "\n\n" +
                "Our technician visited and checked the problem. As you have decided not to " +
                "go ahead, only the visit charge applies.\n\n" +
                "*Total: Rs " + paymentService.paiseToRupees(bill.totalPaise) + "*\n\n" +
                "Please pay this in cash to the technician.",
        });

        return res.status(200).json({
            success: true,
            message: "Visit charge raised. Collect Rs " + paymentService.paiseToRupees(bill.totalPaise),
            data: {
                invoiceNumber,
                totalDisplay: paymentService.paiseToRupees(bill.totalPaise),
                yoursDisplay: paymentService.paiseToRupees(bill.totalPaise - commissionPaise),
                commissionPercent,
            },
        });
    } catch (error) {
        console.error("Visit charge error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/technician/tickets/:id/skip-visit-charge
 *
 * He decided not to ask for it. The job is over either way - the office has
 * already confirmed the customer is not going ahead - so this closes it off
 * with nothing charged.
 */
const skipVisitCharge = async (req, res) => {
    try {
        const updated = await ticketModel.findOneAndUpdate(
            {
                _id: req.params.id,
                technician: req.technician._id,
                status: { $in: ["Assigned", "In-Progress"] },
                "refusal.status": "customer_declined",
            },
            {
                status: "Cancelled",
                cancelReason: "Customer declined after the quote. No visit charge taken.",
                $push: {
                    statusHistory: {
                        from: "In-Progress",
                        to: "Cancelled",
                        actorRole: "technician",
                        actorId: req.technician._id,
                        reason: "Customer declined, technician waived the visit charge",
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        if (!updated) {
            return res.status(404).json({ success: false, message: "This job isn't waiting on a visit charge" });
        }

        await technicianModel.updateOne({ _id: req.technician._id }, { activeTicket: null, isAvailable: true });
        await promoteQueuedTicket(req.technician._id);
        notification.notifyAdminsTicketCancelled(updated, req.technician.name, "Customer declined, no visit charge");

        return res.status(200).json({ success: true, message: "Closed with nothing charged", data: updated });
    } catch (error) {
        console.error("Skip visit charge error:", error);
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

                /*
                 * Pulling a job forward is agreeing to it.
                 *
                 * Nobody starts a job they mean to hand back, so there is no
                 * sense in asking him to accept a second time - and the
                 * customer has to be told now, because somebody is on the way
                 * to them either way.
                 */
                acceptedAt: ticket.acceptedAt || new Date(),

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

        // Only if he had not already accepted it in the queue - in that case
        // the customer was introduced to him then, and once is the rule.
        if (!ticket.acceptedAt) await notification.notifyCustomerAssigned(updated);

        notification.notifyAdminsScheduledStartedEarly(updated, req.technician.name);

        return res.status(200).json({
            success: true,
            message: "Job started. It is now in My Job.",
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

            // So the bill screen can show what a split would look like before
            // the technician commits to it
            commissionPercent: req.technician.commissionRate
                ?? parseInt(process.env.DEFAULT_COMMISSION_RATE) ?? 20,
            billEditLimit: await settingsService.getSetting("BILL_EDIT_LIMIT"),
        });
    } catch (error) {
        console.error("Get pricing error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/technician/tickets/generateBill
 *
 * Writes the bill, and re-writes it when the technician got something wrong.
 *
 * A bill used to be final the instant it was generated, so a mistyped line
 * meant phoning the office with the customer standing there. Corrections are
 * allowed while the money is still untouched, capped at a number the owner
 * controls, and every one of them is kept.
 *
 * Three ways to take the money:
 *   cash   - technician holds the lot and owes the commission back
 *   online - customer pays the whole bill through Razorpay
 *   split  - technician takes his own share in cash and the customer pays the
 *            company's commission through Razorpay. The gateway charges 2% of
 *            the commission instead of 2% of the whole bill, and no money has
 *            to travel between company and technician afterwards, so there is
 *            no second fee and no balance left to chase.
 */
const BILL_METHODS = ["cash", "online", "split"];

const generateBill = async (req, res) => {
    try {
        const { ticketId, catalogItems, customItems, workDone, paymentMethod, serviceKey, editReason } = req.body;

        if (!ticketId) {
            return res.status(400).json({ success: false, message: "ticketId is required" });
        }

        const method = BILL_METHODS.includes(paymentMethod) ? paymentMethod : "online";

        const ticket = await ticketModel.findOne({
            _id: ticketId,
            technician: req.technician._id,
            status: { $in: ["Assigned", "In-Progress", "Payment-Pending"] },
        });

        // Raising a bill is the technician saying the work is done, so the
        // customer confirms that before a figure exists. An edit to a bill
        // that was already agreed does not ask again - the code is about the
        // work being finished, not about the arithmetic.
        if (ticket && !ticket.billing?.invoiceNumber) {
            const blocked = await guardOtp(ticket, "close", req.body?.otp);
            if (blocked) return res.status(blocked.status).json(blocked.body);
        }

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Job not found, or it is no longer yours" });
        }

        // ---- correcting a bill that already exists -------------------------
        const isEdit = ticket.status === "Payment-Pending" && Boolean(ticket.billing?.invoiceNumber);

        if (isEdit) {
            // Once any money has moved the bill is history. Changing it then
            // is a refund, not a correction, and that goes through the office.
            if (ticket.payment?.status !== "Pending") {
                return res.status(400).json({
                    success: false,
                    message: "The customer has already paid this bill. Ask the office to raise a refund instead.",
                });
            }

            const limit = await settingsService.getSetting("BILL_EDIT_LIMIT");
            const used = ticket.billing.editCount || 0;

            if (used >= limit) {
                return res.status(400).json({
                    success: false,
                    message: "This bill has already been corrected " + used + " time" + (used === 1 ? "" : "s") +
                        ". Ask the office to change it.",
                });
            }

            if (!editReason || String(editReason).trim().length < 5) {
                return res.status(400).json({
                    success: false,
                    message: "Say what you are correcting, so the office can see why the amount changed",
                });
            }
        }

        const finalServiceKey = serviceKey || ticket.serviceKey;
        if (serviceKey && serviceKey !== ticket.serviceKey) {
            const { getServiceByKey } = require("../config/services");
            const srv = getServiceByKey(serviceKey);
            if (srv) {
                ticket.serviceKey = srv.key;
                ticket.serviceLabel = srv.label;
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

        // A correction keeps its invoice number. The customer already has it,
        // and burning a fresh one for every typo makes the books unreadable.
        const invoiceNumber = isEdit
            ? ticket.billing.invoiceNumber
            : await paymentService.generateInvoiceNumber();

        // Freeze the commission split at billing time. If the rate changes
        // next month, this job's numbers must not move with it.
        const techData = await technicianModel.findById(req.technician._id).select("commissionRate").lean();
        const commissionPercent = techData?.commissionRate ?? parseInt(process.env.DEFAULT_COMMISSION_RATE) ?? 20;
        let commissionPaise = walletService.calculateCommission(bill.totalPaise, commissionPercent);
        let technicianSharePaise = bill.totalPaise - commissionPaise;

        // On a split the technician is handed physical notes, so his half is
        // rounded down to a whole rupee - nobody counts out 30 paise on a
        // doorstep. The remainder rides along with the company's half, which
        // goes through Razorpay and can be any amount. Rs 799 at 30% becomes
        // Rs 559 in his hand and Rs 240.00 online, not Rs 559.30 and 239.70.
        //
        // The stored commission is then the figure actually collected, not
        // the theoretical one, so the books and the money agree exactly.
        if (method === "split") {
            technicianSharePaise = Math.floor(technicianSharePaise / 100) * 100;
            commissionPaise = bill.totalPaise - technicianSharePaise;
        }

        if (method === "split" && commissionPaise <= 0) {
            return res.status(400).json({
                success: false,
                message: "There is no commission on this job, so take the whole amount in cash instead.",
            });
        }

        // The old link is for the old amount. Leaving it live lets the
        // customer scroll up in WhatsApp and pay the figure we just corrected.
        if (isEdit && ticket.payment?.razorpayLinkId) {
            await paymentService.cancelPaymentLink(ticket.payment.razorpayLinkId);
        }

        // Online takes the whole bill; split takes only the company's cut.
        const onlineAmountPaise = method === "online" ? bill.totalPaise
            : method === "split" ? commissionPaise
            : 0;

        let link = null;
        if (onlineAmountPaise > 0) {
            link = method === "split"
                ? await paymentService.createCommissionLink({ ticket, amountPaise: onlineAmountPaise, invoiceNumber })
                : await paymentService.createPaymentLink({ ticket, amountPaise: onlineAmountPaise, invoiceNumber });

            if (!link) {
                return res.status(502).json({
                    success: false,
                    message: "Could not create the payment link. Collect cash instead, or check the gateway settings.",
                });
            }
        }

        const previousStatus = ticket.status;
        const previousTotal = ticket.billing?.totalPaise || 0;

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
            billedAt: ticket.billing?.billedAt || new Date(),
            editCount: isEdit ? (ticket.billing.editCount || 0) + 1 : 0,
            editHistory: [
                ...(ticket.billing?.editHistory || []),
                ...(isEdit ? [{
                    at: new Date(),
                    byTechnician: req.technician._id,
                    reason: String(editReason).trim(),
                    fromTotalPaise: previousTotal,
                    toTotalPaise: bill.totalPaise,
                }] : []),
            ],
        };

        ticket.payment = {
            status: "Pending",
            method,
            ...(method === "split" ? {
                split: {
                    technicianCashPaise: technicianSharePaise,
                    companyOnlinePaise: commissionPaise,
                },
            } : {}),
            ...(link ? { razorpayLinkId: link.linkId, razorpayLinkUrl: link.linkUrl } : {}),
        };

        ticket.status = "Payment-Pending";
        ticket.statusHistory.push({
            from: previousStatus,
            to: "Payment-Pending",
            actorRole: "technician",
            actorId: req.technician._id,
            reason: isEdit ? "Bill corrected: " + String(editReason).trim() : undefined,
            at: new Date(),
        });

        await ticket.save();

        // One payment row per bill. A correction rewrites it rather than
        // leaving the old amount behind for revenue to double-count.
        await Payment.findOneAndUpdate(
            { ticket: ticket._id },
            {
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
                razorpayLinkId: link?.linkId || null,
                razorpayLinkUrl: link?.linkUrl || null,
            },
            { upsert: true }
        );

        const itemLines = bill.lineItems
            .map((l) => l.description + " - Rs " + paymentService.paiseToRupees(l.amountPaise))
            .join("\n");

        let message =
            (isEdit ? "*CORRECTED INVOICE " : "*INVOICE ") + invoiceNumber + "*\n" +
            "Ticket: " + ticket.ticketNumber + "\n" +
            (isEdit ? "\nThe earlier bill was wrong. This one replaces it.\n" : "") +
            (bill.workDone ? "\nWork done: " + bill.workDone + "\n" : "") +
            "\n" + itemLines + "\n\n";

        if (bill.gstPaise > 0) {
            message += "Subtotal: Rs " + paymentService.paiseToRupees(bill.subtotalPaise) + "\n";
            message += "GST (" + bill.gstPercent + "%): Rs " + paymentService.paiseToRupees(bill.gstPaise) + "\n";
        }
        message += "*Total: Rs " + paymentService.paiseToRupees(bill.totalPaise) + "*\n\n";

        if (method === "split") {
            message +=
                "Please pay in two parts:\n\n" +
                "1) Service charge Rs " + paymentService.paiseToRupees(commissionPaise) +
                " - pay online here:\n" + link.linkUrl + "\n\n" +
                "2) Rs " + paymentService.paiseToRupees(technicianSharePaise) + " in cash to the technician.";
        } else if (link) {
            message += "Pay here:\n" + link.linkUrl;
        } else {
            message += "Please pay Rs " + paymentService.paiseToRupees(bill.totalPaise) + " in cash to the technician.";
        }

        await notification.notifyCustomer({ ticket, text: message });

        const editLimit = await settingsService.getSetting("BILL_EDIT_LIMIT");

        return res.status(200).json({
            success: true,
            message: isEdit
                ? "Corrected invoice sent to the customer"
                : method === "cash"
                    ? "Invoice generated - collect the cash"
                    : "Invoice sent to customer",
            data: {
                invoiceNumber,
                method,
                isEdit,
                editsUsed: ticket.billing.editCount,
                editsLeft: Math.max(0, editLimit - ticket.billing.editCount),
                totalDisplay: paymentService.paiseToRupees(bill.totalPaise),
                commissionDisplay: paymentService.paiseToRupees(commissionPaise),
                technicianShareDisplay: paymentService.paiseToRupees(technicianSharePaise),
                paymentLink: link?.linkUrl || null,
            },
        });
    } catch (error) {
        console.error("Generate bill error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const collectCash = async (req, res) => {
    try {
        const { note } = req.body;

        const ticket = await ticketModel.findOne({
            _id: req.params.id,
            technician: req.technician._id,
            status: "Payment-Pending",
            "payment.method": { $in: ["cash", "split"] },
        }).lean();

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: "Ticket not found, or this invoice isn't set to cash payment",
            });
        }

        const isSplit = ticket.payment?.method === "split";

        // On a split the technician takes his own share and the customer pays
        // the company's commission online. Letting him close the job before
        // that link is paid would hand him his money and leave the company
        // with nothing to chase - the customer has already gone.
        if (isSplit && !ticket.payment?.split?.onlinePaidAt) {
            return res.status(400).json({
                success: false,
                message: "The customer has not paid the Rs " +
                    paymentService.paiseToRupees(ticket.payment?.split?.companyOnlinePaise) +
                    " service charge yet. Get that done first, then take your cash.",
            });
        }

        // He only ever holds his own share on a split, never the whole bill
        const cashTakenPaise = isSplit
            ? (ticket.payment?.split?.technicianCashPaise || 0)
            : (ticket.billing?.totalPaise || 0);

        // A visit charge is what is left of a job that did not happen, so it
        // ends as Cancelled with the trip paid for - not as a completed job.
        const wasRefused = ticket.refusal?.status === "customer_declined";

        // With no commission there is nothing owed and nothing to reconcile -
        // the technician put the money straight in his pocket and the
        // company's share of it is zero.
        const nothingToSettle = (ticket.billing?.commissionPaise || 0) === 0;

        // A visit charge is the exception. No money is owed either way, but
        // the office still checks the figure - otherwise a technician could
        // come back from any wasted trip with whatever number he liked. It is
        // an amount being confirmed, not money being collected.
        const needsAmountCheck = wasRefused;

        const updated = await ticketModel.findOneAndUpdate(
            { _id: ticket._id, status: "Payment-Pending" },
            {
                status: wasRefused ? "Cancelled" : "Closed",
                ...(wasRefused
                    ? { cancelReason: "Customer declined after the quote. Visit charge collected." }
                    : {}),
                "payment.status": "Collected",
                "payment.collectedAt": new Date(),
                "payment.collectedNote": note ? String(note).trim().slice(0, 200) : undefined,
                ...(isSplit ? { "payment.split.cashConfirmedAt": new Date() } : {}),
                $push: {
                    statusHistory: {
                        from: "Payment-Pending", to: wasRefused ? "Cancelled" : "Closed",
                        actorRole: "technician", actorId: req.technician._id,
                        reason: wasRefused
                            ? "Visit charge collected - customer did not go ahead"
                            : isSplit
                            ? "Technician's share collected in cash - commission already paid online"
                            : "Cash collected from customer",
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        // Both close paths ring the customer afterwards, and both go through
        // the same helper so the delay and the guard are stated once.
        scheduleFeedbackCall(updated);

        // Null means someone closed it first - stop before touching the
        // wallet, or the commission gets deducted twice
        if (!updated) {
            return res.status(409).json({ success: false, message: "This ticket was already closed" });
        }

        await Payment.findOneAndUpdate(
            { ticket: ticket._id },
            {
                status: needsAmountCheck ? "collected" : (isSplit || nothingToSettle) ? "verified" : "collected",
                collectedBy: req.technician._id,
                collectedAt: new Date(),
                note: note ? String(note).trim().slice(0, 200) : undefined,
            }
        );

        // A split leaves nothing outstanding in either direction: the technician has
        // exactly his share and the company has exactly its commission. There
        // is no balance to move, which is the whole point of taking it this
        // way - no settlement to chase and no second gateway fee.
        if (!isSplit && !nothingToSettle) {
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
        }

        if (!wasRefused) {
            await technicianModel.updateOne(
                { _id: req.technician._id },
                { $inc: { completedJobs: 1 } }
            );
        }

        await promoteQueuedTicket(req.technician._id);

        await notification.notifyCustomer({
            ticket: updated,
            text: wasRefused
                ? "Visit charge received. Rs " + paymentService.paiseToRupees(updated.billing?.totalPaise) + "\n" +
                  "Invoice: " + updated.billing?.invoiceNumber + "\n\n" +
                  "Thank you for your time. Ticket " + updated.ticketNumber + " is now closed. " +
                  "message us any time if you change your mind."
                : "Payment received. Rs " + paymentService.paiseToRupees(updated.billing?.totalPaise) + "\n" +
                (isSplit
                    ? "(Rs " + paymentService.paiseToRupees(cashTakenPaise) + " cash + Rs " +
                      paymentService.paiseToRupees(updated.payment?.split?.companyOnlinePaise) + " online)\n"
                    : "") +
                "Invoice: " + updated.billing?.invoiceNumber + "\n\n" +
                "Thank you for choosing Cosmosgen. Ticket " + updated.ticketNumber + " is now closed.",
        });

        /*
         * The invoice, as a document they keep.
         *
         * Not awaited. Drawing the page and putting it on ImageKit takes a
         * second or two, and a technician standing at a door waiting for his
         * screen to say "collected" must not wait on it - nor should a failed
         * upload be able to undo a payment that has already been taken. The
         * bill has reached the customer in words either way; this is the copy
         * they can forward to a landlord next year.
         *
         * The URL it writes onto the ticket is what the app and the web panel
         * offer as "Download invoice", so both get it without a second route.
         */
        if (!wasRefused || updated.billing?.invoiceNumber) {
            invoiceService.publishInvoice(updated)
                .then((url) => (url ? notification.sendCustomerInvoice(updated, url) : null))
                .catch(() => { /* said nothing about - see above */ });
        }

        notification.notifyAdminsPaymentCollected(updated, req.technician.name);

        return res.status(200).json({
            success: true,
            message: wasRefused
                ? "Rs " + paymentService.paiseToRupees(cashTakenPaise) + " is yours. Nothing to deposit."
                : isSplit
                    ? "Your share is recorded and the job is closed - fully settled"
                    : "Cash recorded, job closed",
            data: updated,
        });
    } catch (error) {
        console.error("Collect cash error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// GET /api/technician/wallet?days=90
// GET /api/technician/wallet?days=90
/**
 * The whole of a job's money, hung on the ledger row that came out of it.
 *
 * A ledger row only ever carries the part that moved the balance, and on a
 * cash job that is the commission alone - the bill goes straight from the
 * customer into the technician's pocket and the company never touches it. That
 * is right for the balance and unreadable as a passbook: a Rs 899 job he was
 * paid in full for appears as "- Rs 269.70" and nothing else, so it reads like
 * a deduction from money he never received.
 *
 * So each job row also carries what the job was worth, what he keeps and what
 * the company's share was. None of it changes the balance; it is there so the
 * line can be read without doing the arithmetic in your head.
 */
const jobBehind = (txn) => {
    const billing = txn.ticket?.billing;
    if (!billing?.totalPaise) return null;

    return {
        billDisplay: paymentService.paiseToRupees(billing.totalPaise),
        keptDisplay: paymentService.paiseToRupees(billing.technicianSharePaise || 0),
    };
};

/**
 * A ledger row as the technician reads it, not as the books keep it.
 *
 * These two are not the same thing, and printing one where the other belongs
 * is what made the passbook unreadable. The stored credit/debit is the
 * company's direction: settling a due is a *credit*, because it pays down what
 * the technician owed, and the company paying him out is a *debit*. On his
 * screen both came out backwards - money he had handed over appeared in green
 * with a plus in front of it, and money that had landed in his bank appeared
 * in red.
 *
 * So direction is worked out here from the source, from his side of it. He
 * opens this to answer three questions and no others: what came in, what went
 * out, and whether he still owes anything.
 *
 * The wording avoids the word commission and any percentage on purpose. A line
 * reading "commission (30%)" against his name invites the reading that the
 * company is taking a cut of his money, when the bill was never his: the
 * customer is paying Cosmosgen, he earns a share of it, and on a cash job he
 * is simply holding the rest of the company's money until he hands it in.
 */
/*
 * The note says where the money actually is, which is not the same on every
 * job.
 *
 * On an online job the customer pays the company, so the technician's share
 * goes into his wallet and waits there until the office transfers it - that
 * one is credited, and saying so is what explains the balance at the top of
 * the screen. On a cash, split or visit job he was handed the money at the
 * door; nothing is credited anywhere, because it is already in his pocket.
 *
 * Writing "credited to your wallet" on all of them would read better and be
 * false on three out of four - he would sit waiting for a transfer that is
 * never coming, and then ring the office about it.
 */
const VENDOR_VIEW = {
    job_online: { flow: "in", title: "Online job", note: "Credited to your wallet" },
    job_cash: { flow: "out", title: "Cash job", note: "To hand over" },
    job_split: { flow: "in", title: "Split job", note: "Taken in cash, in hand" },
    job_visit: { flow: "in", title: "Visit charge", note: "All yours, in hand" },
    payout: { flow: "in", title: "Office paid you", note: "Sent to your bank" },
    recharge: { flow: "out", title: "You paid the office", note: "Dues cleared" },
};

const vendorView = (txn) => {
    const known = VENDOR_VIEW[txn.source];

    if (!known) {
        // A manual correction by the office. Its direction is the only thing
        // the ledger can tell us, and its own description says why.
        return {
            flow: txn.type === "credit" ? "in" : "out",
            title: "Correction by the office",
            note: "",
        };
    }

    // A settlement that did not take the balance all the way to zero is a part
    // payment, and saying "dues cleared" against one would be a lie he finds
    // out about later.
    if (txn.source === "recharge" && txn.balanceAfterPaise !== 0) {
        return { ...known, note: "Part payment" };
    }

    return known;
};

const getWallet = async (req, res) => {
    try {
        const techId = req.technician._id;

        // How far a technician can go into the red before the office steps in
        const CREDIT_LIMIT_PAISE = -100000;

        const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const [tech, transactions, periodTotals, lifetimeOnline, cashJobsValue, splitJobs] = await Promise.all([
            technicianModel.findById(techId).select("walletBalancePaise commissionRate completedJobs").lean(),

            WalletTransaction.find({ technician: techId })
                .sort({ createdAt: -1 })
                .limit(50)
                // The job's money travels with the row. A cash job writes only
                // its commission to the ledger - the bill itself never touches
                // the company - so without these the passbook shows a
                // technician "- Rs 269.70" against a job he was paid Rs 899
                // for, and nothing at all about the Rs 629.30 he kept.
                .populate("ticket", "ticketNumber serviceLabel billing.totalPaise billing.commissionPaise billing.technicianSharePaise")
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

            // Cancelled is in here on purpose: a visit charge closes its
            // ticket as cancelled - the job never happened - but the money was
            // still collected and it is still his earning.
            ticketModel.aggregate([
                {
                    $match: {
                        technician: techId,
                        status: { $in: ["Closed", "Cancelled"] },
                        "payment.method": "cash",
                        "payment.status": { $in: ["Collected", "Verified"] },
                        // Visit charges are counted with the other jobs that
                        // left no ledger entry, below - not here as well
                        "refusal.visitChargeBilled": { $ne: true },
                        updatedAt: { $gte: since },
                    },
                },
                { $group: { _id: null, total: { $sum: "$billing.totalPaise" }, count: { $sum: 1 } } },
            ]),

            // Jobs that moved no balance, so they wrote nothing to the ledger:
            // a split, where he took his share and the customer paid the
            // company directly, and a visit charge with no commission on it,
            // which is entirely his. Correct for the balance, and wrong for
            // the earnings screen - without this the money he actually
            // pocketed on those jobs appears nowhere at all.
            ticketModel
                .find({
                    technician: techId,
                    status: { $in: ["Closed", "Cancelled"] },
                    updatedAt: { $gte: since },
                    $or: [
                        {
                            "payment.method": "split",
                            "payment.split.cashConfirmedAt": { $ne: null },
                        },
                        {
                            "refusal.visitChargeBilled": true,
                            "payment.status": { $in: ["Collected", "Verified"] },
                            "billing.commissionPaise": 0,
                        },
                    ],
                })
                .select("ticketNumber serviceLabel refusal.visitChargeBilled billing.technicianSharePaise billing.totalPaise payment.method updatedAt")
                .sort({ updatedAt: -1 })
                .limit(50)
                .lean(),
        ]);

        const bySource = {};
        periodTotals.forEach((t) => { bySource[t._id] = { total: t.total, count: t.count }; });

        // Online jobs credit the technician's share directly. Cash jobs leave
        // the whole amount with them and only debit the commission - so their
        // earning there is the job value minus that commission.
        const onlineEarnedPaise = bySource.job_online?.total || 0;
        const cashCommissionPaise = bySource.job_cash?.total || 0;

        // Two ways cash ends up in his pocket, and both belong on this line:
        // a plain cash job where he held the whole bill and owes the
        // commission back, and a split where he only ever held his own share.
        const plainCashEarnedPaise = (cashJobsValue[0]?.total || 0) - cashCommissionPaise;
        const splitEarnedPaise = splitJobs.reduce((sum, t) => sum + (t.billing?.technicianSharePaise || 0), 0);
        const visitEarnedPaise = splitJobs
            .filter((t) => t.refusal?.visitChargeBilled)
            .reduce((sum, t) => sum + (t.billing?.technicianSharePaise || 0), 0);
        const cashEarnedPaise = plainCashEarnedPaise + splitEarnedPaise;

        const totalEarnedPaise = onlineEarnedPaise + cashEarnedPaise;

        const balance = tech?.walletBalancePaise || 0;
        const owedPaise = Math.abs(Math.min(0, balance));

        // Money he has already sent that the office has not recorded yet.
        //
        // The gateway confirming a payment and the office recording it
        // against a ticket are two different moments, and the balance only
        // moves on the second. Without this the technician pays, sees the
        // same due sitting there, and pays again.
        //
        // Only while he actually owes something. With a square balance there
        // is no due for a settlement to clear, so "your balance clears once
        // they record it" would be telling him about money already dealt
        // with - which is what it did after a visit charge, where the whole
        // amount is his and he owes nothing at all.
        const settlementRows = owedPaise > 0
            ? await Payment.find({
                collectedBy: techId,
                ticket: null,
                status: "collected",
            }).select("amountPaise createdAt razorpayPaymentId razorpayLinkId").lean()
            : [];

        /*
         * A settlement the office has already put in the ledger is finished,
         * whatever its row still says.
         *
         * Closing the row is the office's job and it now happens when they
         * record the money, but rows recorded before that are still sitting
         * there marked "collected" - and one of those blocks online settling
         * for ever, because nothing may be paid while a settlement is waiting.
         * Checking the ledger for the same reference is what lets those heal
         * themselves instead of needing somebody to go in and fix each one.
         */
        const recorded = settlementRows.length
            ? new Set(
                (await WalletTransaction.find({
                    technician: techId,
                    source: "recharge",
                    reference: { $in: settlementRows.map((r) => r.razorpayPaymentId || r.razorpayLinkId).filter(Boolean) },
                }).select("reference").lean()).map((t) => t.reference)
            )
            : new Set();

        const pendingSettlements = settlementRows.filter(
            (r) => !recorded.has(r.razorpayPaymentId) && !recorded.has(r.razorpayLinkId)
        );

        const settlementPending = pendingSettlements.length
            ? {
                count: pendingSettlements.length,
                amountDisplay: paymentService.paiseToRupees(
                    pendingSettlements.reduce((n, r) => n + (r.amountPaise || 0), 0)
                ),
                sentAt: pendingSettlements[0].createdAt,
            }
            : null;

        // When the office's transfer should reach his bank.
        //
        // On an online job the customer's money goes to Razorpay, not to the
        // company, and Razorpay only settles it into the company account
        // several days later - the office cannot send on what it has not
        // received. A technician who finishes a job at six and sees a credit
        // here the same evening, with nothing in his bank, assumes the app is
        // broken. The date is the answer, and it is the question the office
        // fields most often.
        //
        // Counted from the oldest credit that has not been paid out yet, so
        // the promise is about the money that has been waiting longest rather
        // than the newest job to land.
        let payoutExpected = null;
        if (balance > 0) {
            const payoutDays = await settingsService.getSetting("PAYOUT_DAYS");

            const lastPayout = await WalletTransaction.findOne({ technician: techId, source: "payout" })
                .sort({ createdAt: -1 })
                .select("createdAt")
                .lean();

            const oldestUnpaid = await WalletTransaction.findOne({
                technician: techId,
                source: "job_online",
                ...(lastPayout ? { createdAt: { $gt: lastPayout.createdAt } } : {}),
            })
                .sort({ createdAt: 1 })
                .select("createdAt")
                .lean();

            if (oldestUnpaid) {
                const dueAt = new Date(new Date(oldestUnpaid.createdAt).getTime() + payoutDays * 86400000);
                payoutExpected = {
                    days: payoutDays,
                    waitingSince: oldestUnpaid.createdAt,
                    expectedBy: dueAt,
                    overdue: Date.now() > dueAt.getTime(),
                };
            }
        }

        return res.status(200).json({
            success: true,
            data: {
                balancePaise: balance,
                balanceDisplay: paymentService.paiseToRupees(Math.abs(balance)),
                // Zero is its own state, not a debt in either direction.
                // Folding it in with "company owes" made a fully settled
                // technician read "Office will pay you Rs 0.00".
                direction: balance === 0 ? "settled" : balance > 0 ? "company_owes" : "you_owe",

                owedPaise,
                // Nothing to pay twice while one transfer is still being
                // checked by the office
                canPayOnline: owedPaise > 0 && !settlementPending && paymentService.isRazorpayActive(),
                settlementPending,

                payoutExpected,

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
                    splitEarnedDisplay: paymentService.paiseToRupees(splitEarnedPaise - visitEarnedPaise),
                    visitEarnedDisplay: paymentService.paiseToRupees(visitEarnedPaise),
                    jobsCount: (bySource.job_online?.count || 0)
                        + (bySource.job_cash?.count || 0)
                        + splitJobs.length,
                },

                lifetime: {
                    onlineDisplay: paymentService.paiseToRupees(lifetimeOnline[0]?.total || 0),
                    completedJobs: tech?.completedJobs || 0,
                },

                // Ledger rows and split jobs, newest first. A split has no
                // ledger row of its own because nothing was owed either way,
                // so it is folded in here rather than left invisible - and
                // marked, so the screen does not print a running balance
                // against an entry that never moved one.
                transactions: [
                    ...transactions.flatMap((t) => {
                        const row = {
                            ...t,
                            amountDisplay: paymentService.paiseToRupees(t.amountPaise),
                            balanceAfterDisplay: paymentService.paiseToRupees(Math.abs(t.balanceAfterPaise)),
                            job: jobBehind(t),
                            ...vendorView(t),
                        };

                        /*
                         * A cash job is two things and the ledger only records
                         * one of them.
                         *
                         * The customer hands over the whole bill at the door.
                         * The technician's own share never touches the company,
                         * so nothing is written for it - only the office's part
                         * is, as a debit. Read back, that made a job he had
                         * just been paid Rs 899 for appear in his passbook as a
                         * single line taking Rs 269.70 off him, with his
                         * earnings nowhere on the page.
                         *
                         * So the earning is put back as its own line, marked as
                         * moving no balance because it genuinely does not - the
                         * money is already in his pocket.
                         */
                        const sharePaise = t.source === "job_cash"
                            ? (t.ticket?.billing?.technicianSharePaise || 0)
                            : 0;

                        if (!sharePaise) return [row];

                        return [
                            {
                                _id: "share-" + t._id,
                                type: "credit",
                                source: "job_cash_share",
                                movesBalance: false,
                                amountPaise: sharePaise,
                                amountDisplay: paymentService.paiseToRupees(sharePaise),
                                ticket: t.ticket,
                                createdAt: t.createdAt,
                                job: jobBehind(t),
                                flow: "in",
                                title: "Cash job",
                                note: "Taken in cash, in hand",
                            },
                            // The bill is spelled out on the line above, so it
                            // is not repeated against the part he owes
                            { ...row, job: null },
                        ];
                    }),
                    ...splitJobs.map((t) => ({
                        _id: "settled-" + t._id,
                        type: "credit",
                        source: t.refusal?.visitChargeBilled ? "job_visit" : "job_split",
                        movesBalance: false,
                        amountPaise: t.billing?.technicianSharePaise || 0,
                        amountDisplay: paymentService.paiseToRupees(t.billing?.technicianSharePaise || 0),
                        description: t.refusal?.visitChargeBilled
                            ? "Visit charge for #" + t.ticketNumber +
                              " - customer did not go ahead, all yours"
                            : "Your share of " + (t.serviceLabel || "a job") +
                              " #" + t.ticketNumber + " - taken in cash, fully settled",
                        ticket: { ticketNumber: t.ticketNumber, serviceLabel: t.serviceLabel },
                        job: t.billing?.totalPaise
                            ? {
                                billDisplay: paymentService.paiseToRupees(t.billing.totalPaise),
                                keptDisplay: paymentService.paiseToRupees(t.billing.technicianSharePaise || 0),
                            }
                            : null,
                        ...VENDOR_VIEW[t.refusal?.visitChargeBilled ? "job_visit" : "job_split"],
                        createdAt: t.updatedAt,
                    })),
                ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50),
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
                    isSplit: ticket.payment?.method === "split",
                    officePaid: true,
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

        // A split link only covers the company's half. Running the full-online
        // path on it would close the job and credit the technician a share he
        // is about to take in cash as well - paying him twice.
        //
        // This is also the only way a split gets confirmed at all when the
        // Razorpay webhook cannot reach the server, which is the normal state
        // during development: the gateway has no route to localhost.
        if (ticket.payment?.method === "split") {
            const alreadyPaid = Boolean(ticket.payment?.split?.onlinePaidAt);

            if (status.isPaid && !alreadyPaid) {
                const marked = await ticketModel.findOneAndUpdate(
                    { _id: ticket._id, status: "Payment-Pending", "payment.split.onlinePaidAt": null },
                    {
                        "payment.split.onlinePaidAt": status.paidAt || new Date(),
                        "payment.razorpayPaymentId": status.paymentId,
                        $push: {
                            statusHistory: {
                                from: "Payment-Pending", to: "Payment-Pending",
                                actorRole: "system",
                                reason: "Service charge confirmed via gateway status check",
                                at: new Date(),
                            },
                        },
                    },
                    { returnDocument: "after" }
                ).lean();

                if (marked) {
                    const { feePaise, taxPaise } = estimateGatewayFee(ticket.payment?.split?.companyOnlinePaise || 0);
                    await Payment.updateOne(
                        { ticket: ticket._id },
                        {
                            razorpayPaymentId: status.paymentId,
                            gatewayFeePaise: feePaise,
                            gatewayTaxPaise: taxPaise,
                        }
                    );
                }
            }

            return res.status(200).json({
                success: true,
                data: {
                    ...status,
                    isSplit: true,
                    // "Paid" on a split means the company's half only - the
                    // job is not done until the technician has his cash.
                    officePaid: status.isPaid || alreadyPaid,
                    officeAmountDisplay: paymentService.paiseToRupees(ticket.payment?.split?.companyOnlinePaise),
                    technicianCashDisplay: paymentService.paiseToRupees(ticket.payment?.split?.technicianCashPaise),
                    amountDisplay: paymentService.paiseToRupees(ticket.billing?.totalPaise),
                },
            });
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

            scheduleFeedbackCall(closed);

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

        // The link is written down before he pays it.
        //
        // Until now it existed only in his browser tab, so the only thing that
        // could ever tell us he had paid was the webhook. When the webhook did
        // not arrive - and on a local server it never does - the office had no
        // way to look: the money was at Razorpay under an id nobody here had.
        // This row is the office's handle on it.
        await Payment.create({
            ticket: null,
            amountPaise,
            method: "online",
            status: "pending",
            collectedBy: tech._id,
            razorpayLinkId: link.linkId,
            razorpayLinkUrl: link.linkUrl,
            note: "Technician commission settlement",
        });

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
// Asked once when the technician presses "Check now", and whenever the socket
// that would have announced the payment does not arrive
const checkWalletRecharge = async (req, res) => {
    try {
        const status = await paymentService.fetchPaymentLinkStatus(req.params.linkId);
        if (!status) {
            return res.status(502).json({ success: false, message: "Could not reach the payment gateway" });
        }

        // Write it down ourselves rather than waiting on the webhook.
        //
        // Until now this only asked and reported. The webhook was the one
        // thing that could turn "a link was sent to him" into a settlement
        // the office can record - and on a local server it never arrives, so
        // the technician paid, the panel found the money at the gateway, and
        // then showed him "Clear your dues online" all over again as though
        // the payment had failed. Which is how a man pays twice.
        //
        // Same atomic upsert on the payment id that the webhook uses, so
        // whichever of the two gets here first wins and the other finds the
        // row already made. The wallet is NOT credited: the office still
        // checks the reference and records it against the job, and that is
        // the step that clears the due.
        if (status.isPaid && status.paymentId) {
            let existing;
            try {
                existing = await Payment.findOneAndUpdate(
                    { ticket: null, razorpayPaymentId: status.paymentId },
                    {
                        $setOnInsert: {
                            ticket: null,
                            amountPaise: status.amountPaidPaise || 0,
                            method: "online",
                            status: "collected",
                            collectedBy: req.technician._id,
                            collectedAt: status.paidAt || new Date(),
                            razorpayPaymentId: status.paymentId,
                            razorpayLinkId: req.params.linkId,
                            note: "Technician commission settlement",
                        },
                    },
                    { upsert: true, returnDocument: "before" }
                );
            } catch (err) {
                // A webhook landing at the same instant took the row first
                if (err.code !== 11000) throw err;
                existing = {};
            }

            if (!existing) {
                // The row that only recorded "a link was sent to him" has
                // served its purpose now the real payment is here
                await Payment.deleteOne({
                    ticket: null,
                    razorpayLinkId: req.params.linkId,
                    status: "pending",
                });

                emitToRoom(adminRoom(), "payment:collected", {
                    technicianName: req.technician.name,
                    invoiceNumber: "commission settlement",
                    amountDisplay: paymentService.paiseToRupees(status.amountPaidPaise || 0),
                });

                emitToRoom(techRoom(req.technician._id), "settlement:received", {
                    amountPaise: status.amountPaidPaise || 0,
                    amountDisplay: paymentService.paiseToRupees(status.amountPaidPaise || 0),
                    reference: status.paymentId,
                });
            }
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
    updateLocation,
    savePushToken,
    startOnTheWay,
    startWork,
    sendJobOtp,
    getWallet,
    acceptTicket,
    releaseTicket,
    refuseTicket,
    billVisitCharge,
    skipVisitCharge,
    getPricing,
    generateBill,
    collectCash,
    getPaymentStatus,
    startScheduledNow,
    createWalletRecharge,
    checkWalletRecharge,
    sendSignupOtp,
    verifySignupOtp,
    checkIfsc
};
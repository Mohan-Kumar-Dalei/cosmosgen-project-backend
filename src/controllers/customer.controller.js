const { LANGUAGES, asLanguage } = require("../config/languages");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const userModel = require("../models/user.model");
const addressService = require("../services/address.service");
const { stageOf, issueToken } = require("../services/track.service");
const { ARRIVAL_RADIUS_METRES } = require("../services/ride.service");
const ticketModel = require("../models/ticket.model");
const technicianModel = require("../models/technician.model");
const booking = require("../services/booking.service");
const signupOtpService = require("../services/signupOtp.service");
const whatsapp = require("../services/whatsapp.service");
const registration = require("../services/registration.service");
const paymentService = require("../services/payment.service");
const assistant = require("../services/assistant.service");
const WebChat = require("../models/webChat.model");
const Announcement = require("../models/announcement.model");
const ratings = require("../services/rating.service");
const { lookupPlace } = require("./map.controller");
const { serviceRanges } = require("../services/estimate.service");
const { SERVICE_CATALOG, issuePhrases, getServiceByKey, buildSkillRegex, escapeRegex } = require("../config/services");

const isProd = process.env.NODE_ENV === "production";

const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
};

const signToken = (userId) =>
    jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });

const cleanPhone = (value) => String(value || "").replace(/\D/g, "").slice(-10);

/* ================= WHO THEY ARE ================= */

/**
 * POST /api/customer/otp
 *
 * The same six digits over the same channel the whole platform runs on.
 *
 * Until now a customer account opened on the phone number alone - `register`
 * upserted by number and handed back a session, with a comment promising OTP
 * "in phase 2". That was survivable while the only thing behind it was a chat
 * demo. It is not survivable now: behind this sits their address, their jobs
 * and what they paid, and anybody who knows a mobile number would have had it.
 *
 * The code goes to WhatsApp rather than SMS because that is where this
 * platform already talks to every customer, and because the number being
 * reachable there is itself part of what is being checked.
 */
const sendOtp = async (req, res) => {
    try {
        const phone = cleanPhone(req.body.phone);

        if (!/^[6-9]\d{9}$/.test(phone)) {
            return res.status(400).json({ success: false, message: "Enter a valid 10 digit mobile number" });
        }

        const issued = signupOtpService.issue("cust:" + phone);
        if (issued.wait) {
            return res.status(429).json({
                success: false,
                retryAfter: issued.wait,
                message: "A code has just gone out. Wait " + issued.wait + " seconds before asking again.",
            });
        }

        const sent = await whatsapp.sendText(
            phone,
            "Your Cosmosgen code is *" + issued.code + "*\n\n" +
            "Type it into the app to sign in. It is good for ten minutes.\n\n" +
            "If you did not ask for it, ignore this message."
        );

        if (!sent) {
            return res.status(502).json({
                success: false,
                message: "Could not send the code on WhatsApp. Try again, or message us there instead.",
            });
        }

        const existing = await userModel.findOne({ phone }).select("name").lean();

        return res.status(200).json({
            success: true,
            // So the screen can say "welcome back" rather than asking a
            // returning customer for their name all over again
            returning: Boolean(existing?.name),
            name: existing?.name || null,
            retryAfter: Math.ceil(signupOtpService.RESEND_AFTER_MS / 1000),
            message: "Code sent on WhatsApp",
        });
    } catch (error) {
        console.error("Customer OTP error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/customer/otp/verify
 *
 * Signs them in, and creates the account on the way if there is none. A
 * customer who has only ever used WhatsApp already has a row here, so this is
 * usually a sign-in even the first time they open the app.
 */
const verifyOtp = async (req, res) => {
    try {
        const phone = cleanPhone(req.body.phone);
        const result = signupOtpService.check("cust:" + phone, req.body.code);

        if (!result.ok) {
            return res.status(400).json({ success: false, message: result.message });
        }

        const user = await userModel.findOneAndUpdate(
            { phone },
            { $setOnInsert: { phone, role: "customer" } },
            { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
        ).lean();

        const token = signToken(user._id);
        res.cookie("token", token, cookieOptions);

        return res.status(200).json({
            success: true,
            // The browser ignores this and uses the cookie above; the app
            // stores it and sends it as a bearer header, having no cookie jar
            token,
            user,
            // A new row has a phone number and nothing else. The screen asks
            // for the rest rather than dropping them into an empty account.
            needsProfile: !user.name || !Number.isFinite(user.lat),
            message: "Signed in",
        });
    } catch (error) {
        console.error("Customer OTP verify error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/** GET /api/customer/me */
const me = async (req, res) =>
    res.status(200).json({ success: true, data: req.user });

/** POST /api/customer/logout */
const logout = (req, res) => {
    res.clearCookie("token", { ...cookieOptions, maxAge: undefined });
    return res.status(200).json({ success: true, message: "Logged out" });
};

/**
 * PUT /api/customer/profile
 *
 * The address is resolved from the pin rather than trusted from the form, the
 * same way it is on WhatsApp - so a customer who registers on one channel is
 * registered at the same door on all of them.
 */
const updateProfile = async (req, res) => {
    try {
        const { name, address, state, area, lat, lon, language } = req.body;

        const numLat = Number(lat);
        const numLon = Number(lon);
        const hasCoords = Number.isFinite(numLat) && Number.isFinite(numLon);

        if (hasCoords) {
            await registration.applyLocation(req.user.phone, {
                lat: numLat,
                lon: numLon,
                fallbackAddress: address,
                name: name ? String(name).trim() : req.user.name,
            });
        }

        const typed = {};
        if (String(name || "").trim()) {
            typed.name = String(name).trim();
            typed.nameConfirmedAt = new Date();
        }
        // Their own words win over anything worked out from the pin
        if (String(address || "").trim()) typed.address = String(address).trim();
        if (String(state || "").trim()) typed.state = String(state).trim();
        if (String(area || "").trim()) typed.area = String(area).trim();

        if (LANGUAGES.includes(language)) {
            typed.language = language;
            typed.languageConfirmedAt = new Date();
        }

        const user = await userModel
            .findByIdAndUpdate(req.user._id, { $set: typed }, { returnDocument: "after", runValidators: true })
            .lean();

        return res.status(200).json({ success: true, data: user, message: "Saved" });
    } catch (error) {
        console.error("Customer profile error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/* ================= WHAT WE DO ================= */

/**
 * GET /api/customer/services
 *
 * The catalogue the app browses and the website lists, read from the same file
 * the WhatsApp menu and the assistant's prompt read. There is one list of what
 * this company sells, and this is not a second copy of it.
 *
 * Public on purpose: somebody deciding whether to install the app needs to see
 * what is on offer before they have an account.
 */
const LANG_FIELD = { english: "en", hinglish: "hinglish", odia: "odia" };

const getServices = async (req, res) => {
    try {
        /*
         * Only what was asked for, never what is on the account.
         *
         * It used to fall back to the customer's saved language, which is how
         * an English app ended up with Odia service names on one screen: the
         * app was not asking for a translation at all, the account was
         * answering for it.
         *
         * That choice belongs to the two channels that talk in sentences - the
         * WhatsApp assistant and the call before a job. A screen with its own
         * headings, buttons and labels in English is not one of them.
         */
        const lang = LANG_FIELD[asLanguage(req.query.language)] || "en";

        /*
         * Two shapes, one rule.
         *
         * A service and an appliance carry `label` / `labelHinglish` /
         * `labelOdia`; an issue carries `en` / `hinglish` / `odia`.
         * Both fall back to English when a translation is missing, and English
         * is always what `label` reports - that is the wording the office and
         * the vendor read on the ticket, so it must not change with whatever
         * the customer happens to be browsing in.
         */
        const named = (item) => lang === "en"
            ? item.label
            : (lang === "hinglish" ? item.labelHinglish : item.labelOdia) || item.label;

        const said = (i) => (lang === "en" ? i.en : i[lang] || i.en);

        /*
         * What the work usually comes to, from the office's own price list.
         *
         * Asked for here rather than left off the screen, because "we cannot
         * tell you anything about the price" is the reason somebody closes the
         * app and rings a man they already know. It is a range and it is
         * labelled as one - the engineer still settles the real figure at the
         * door, after he has seen the fault.
         *
         * The same numbers the assistant quotes, read through the same helper,
         * so the app and the conversation cannot say different things.
         */
        const ranges = await serviceRanges();

        /*
         * What customers have said about each trade.
         *
         * The card has always carried a star and the number beside it was 4.8,
         * typed into the app. Every rating needed to replace it was already
         * being collected on the tickets; it was only never counted.
         */
        const scores = await ratings.byService();

        const data = SERVICE_CATALOG.map((service) => ({
            key: service.key,
            label: service.label,
            display: named(service),
            worker: service.worker,

            /*
             * Presentation, straight from the catalogue the office edits.
             *
             * The picture, the line of copy and the badges used to be typed
             * into the website, which meant a service the office added showed
             * up as a blank tile until a developer noticed. They travel with
             * the service now; the site still has its own fallbacks for the
             * ones that predate this.
             */
            image: service.image || "",
            blurb: service.blurb || "",
            badges: service.badges || [],

            appliances: (service.appliances || []).map((a) => ({
                key: a.key,
                label: a.label,
                display: named(a),
                image: a.image || "",
                issues: (a.issues || []).map((i) => ({ key: i.key, label: i.en, display: said(i) })),
            })),

            issues: (service.issues || []).map((i) => ({ key: i.key, label: i.en, display: said(i) })),

            // { from, to } in whole rupees, or absent when nothing is priced
            usually: ranges[service.key] || null,

            /*
             * The score and how many people are behind it.
             *
             * `ratingCount` matters as much as the figure: 4.9 from three
             * customers and 4.5 from four hundred are not the same claim, and
             * a screen that shows only the first number cannot tell them
             * apart. A trade nobody has rated yet falls back to the shared
             * starting figure rather than showing nothing, because an empty
             * corner on one card in a row of nine reads as a fault.
             */
            rating: scores[service.key]?.rating ?? ratings.DEFAULT_RATING,
            ratingCount: scores[service.key]?.count || 0,
        }));

        /*
         * The windows the app offers, sent with the list rather than typed
         * into the app.
         *
         * A window the screen shows but the server refuses is the worst kind
         * of bug - the customer fills the form and is told no for a reason
         * they cannot see. One list, held where it is enforced.
         */
        return res.status(200).json({
            success: true,
            data,
            slots: { windows: booking.SLOT_WINDOWS, aheadDays: booking.BOOK_AHEAD_DAYS },
        });
    } catch (error) {
        console.error("Get services error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/* ================= BOOKING ================= */

/**
 * POST /api/customer/book
 *
 * Every rule behind this lives in booking.service, which the assistant calls
 * too - so a job booked in the app and a job booked by messaging us are the
 * same job, checked the same way.
 */
const book = async (req, res) => {
    try {
        const { serviceKey, selectedIssues, problemDescription, language, lat, lon, address, area, state } = req.body;

        /*
         * The language the customer picked while booking, kept on the account.
         *
         * The app opens in English and asks this once, inside the booking flow,
         * because that is the moment it starts to matter: everything this job
         * generates - the WhatsApp messages, the availability call, the assistant - reads
         * `user.language`, and none of them is given a language of its own.
         * Written before the booking, so the very first message about this job
         * is already in it.
         */
        const running = await booking.openTicketsFor(req.user._id);

        /*
         * A language can only be set when nothing is running.
         *
         * Mohan's rule is that a job keeps the language it was booked in from
         * the first message to the last. The app already hides the question
         * while work is in hand, but the rule belongs here as well as there -
         * WhatsApp books through the same account, and a second booking made
         * from a different channel must not turn a visit that is already on
         * its way into another language halfway through.
         */
        if (!running.length && LANGUAGES.includes(language) && language !== req.user.language) {
            await userModel.updateOne(
                { _id: req.user._id },
                { $set: { language, languageConfirmedAt: new Date() } }
            );
        }

        /*
         * The faults, as words rather than as catalogue keys.
         *
         * The app sends back the keys it was given - NOT_COOLING,
         * ROUTINE_SERVICE - and those were being written onto the ticket and
         * read back on the customer's own screen in capitals with underscores
         * in them. WhatsApp always stored the label it had shown; this makes
         * the two channels agree, in whichever language the customer is using.
         */
        const chosenLanguage = (!running.length && LANGUAGES.includes(language))
            ? language
            : req.user.language;
        /*
         * The faults go on the ticket in English, always.
         *
         * They used to be written in whichever language the booking was made
         * in, so an Odia booking put "\u0b25\u0b23\u0b4d\u0b21\u0b3e \u0b39\u0b47\u0b09\u0b28\u0b3e\u0b39\u0b3f\u0b01" on the
         * ticket - and Mohan drew the line where it belongs: the language a
         * customer books in governs what the assistant says back to them, and
         * nothing else. A ticket is read by the office and by the vendor, and
         * it has to say the same words to both of them however the job came
         * in. `chosenLanguage` still rides on the ticket and still steers
         * every message and the call.
         */
        const issues = issuePhrases(serviceKey, selectedIssues, "english");

        /*
         * Describing it in your own words is optional once faults are picked.
         *
         * Mohan's point: the customer has already said what is wrong by
         * choosing from the list, and then the next screen refused to go
         * forward until they had written it out again. The words still matter
         * where nothing was picked - a service with no list, or a fault that
         * is not on it - so one of the two is required, not both.
         */
        const written = String(problemDescription || "").trim();

        if (!issues.length && written.length < 5) {
            return res.status(400).json({
                success: false,
                message: "Pick what is wrong, or tell us in a line or two.",
            });
        }

        // Written words lead, because they are specific to this house. The
        // chosen faults stand in when there are none.
        const description = written.length >= 5 ? written : issues.join(", ");

        const result = await booking.bookJob({
            customerId: req.user._id,
            serviceKey,
            selectedIssues: issues,
            problemDescription: description,
            channel: "app",
            location: { lat, lon, address, area, state },

            // Which saved address this one is for. Absent is the account's
            // own, which is what the app sent before there was a list.
            addressId: req.body.addressId,

            /*
             * When they want somebody, if they said so.
             *
             * Both absent is the old behaviour and still the right one for a
             * customer who wants the next available engineer - the office
             * treats a job with no day on it exactly as it always has.
             */
            scheduledFor: req.body.scheduledFor,
            slotWindow: req.body.slotWindow,
        });

        if (result.ok) {
            return res.status(201).json({
                success: true,
                data: {
                    ticketNumber: result.ticket.ticketNumber,
                    id: result.ticket._id,
                    serviceLabel: result.ticket.serviceLabel,
                    scheduledFor: result.ticket.scheduling?.scheduledFor || null,
                    slotWindow: result.ticket.scheduling?.slotWindow || "",
                },
                message: result.ticket.scheduling?.scheduledFor
                    ? "Booked. We will have somebody there on the day you picked."
                    : "Booked. We are finding somebody near you now.",
            });
        }

        const said = {
            unknown_service: "We do not do that one. Pick a service from the list.",
            no_profile: "We could not find your account. Sign in again.",
            no_location: "We need your address to send somebody. Add it in your profile first.",
            limit_reached: "You already have " + booking.MAX_OPEN
                + " requests open. Let one finish before booking another.",
            bad_slot_date: "We could not read the day you picked. Choose it again.",
            slot_in_the_past: "That day has gone. Pick today or a day after it.",
            slot_too_far: "We take bookings up to " + booking.BOOK_AHEAD_DAYS
                + " days ahead. Pick a nearer day.",
            bad_slot_window: "Pick one of the time windows on the screen.",
        }[result.code];

        if (result.code === "already_booked") {
            return res.status(409).json({
                success: false,
                code: "already_booked",
                data: {
                    ticketNumber: result.ticket.ticketNumber,
                    status: result.ticket.status,
                    serviceLabel: result.ticket.serviceLabel,
                },
                message: "You already have a " + result.ticket.serviceLabel
                    + " request open (" + result.ticket.ticketNumber + "). You can still book a different service.",
            });
        }

        return res.status(400).json({ success: false, code: result.code, message: said || "Could not book this." });
    } catch (error) {
        console.error("Customer booking error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/* ================= THEIR JOBS ================= */

/** What a customer is allowed to see about the person coming to their house. */
const TICKET_FIELDS =
    "ticketNumber status acceptedAt serviceKey serviceLabel selectedIssues problemDescription location "
    + "technicianSnapshot scheduling ride billing.totalPaise billing.invoiceNumber billing.workDone "
    + "payment.method payment.status tracking.token otp.start otp.close cancelReason "
    + "billing.invoicePdfUrl createdAt updatedAt";

/**
 * Whether the customer has been told who is coming.
 *
 * The office picking somebody is not a promise; the technician saying yes is.
 * Between the two the customer sees the map and the dashed arc - somebody is
 * out there and roughly where from - and no name, no number, no face. If that
 * vendor hands the job back, nothing has to be taken off the screen, because
 * nothing about him was ever on it.
 *
 * The started and finished checks are for jobs that predate accepting, and for
 * the history, where the name is the whole point of the entry.
 */
const isAccepted = (t) => Boolean(
    t.acceptedAt
    || t.ride?.startedAt
    || ["In-Progress", "Payment-Pending", "Closed"].includes(t.status),
);

const shape = (t) => ({
    id: t._id,
    ticketNumber: t.ticketNumber,
    status: t.status,
    serviceKey: t.serviceKey,
    serviceLabel: t.serviceLabel,
    selectedIssues: t.selectedIssues || [],
    problemDescription: t.problemDescription,

    // The name and photograph of whoever is coming, and nothing else about
    // them - not their wallet, not their other jobs. And only once he has
    // accepted: see isAccepted above.
    technician: (isAccepted(t) && t.technicianSnapshot?.name)
        ? {
            name: t.technicianSnapshot.name,
            phone: t.technicianSnapshot.phone || null,
            photo: t.technicianSnapshot.profileImage || null,
            rating: t.technicianSnapshot.rating ?? null,
        }
        : null,

    scheduledFor: t.scheduling?.scheduledFor || null,

    /*
     * And which part of that day, when they picked one.
     *
     * The date on its own is half the answer: "Thursday" is not something a
     * customer can plan around, and the app's own booking screen made them
     * choose a window precisely so the office could hold the job for it. Sent
     * so the job card can say the whole thing back to them.
     */
    slotWindow: t.scheduling?.slotWindow || "",
    trackingToken: t.tracking?.token || null,

    /*
     * What the customer should be told this job is doing.
     *
     * Worked out from the same rule the tracking page uses rather than from
     * the raw status, because the two are not the same thing: a ticket is
     * "Assigned" from the moment the office picks somebody, and the customer
     * should not read that as "on the way" until that somebody has agreed to
     * come. One rule, one answer, wherever it is shown.
     */
    stage: stageOf(t),

    // Same circle as the tracking page draws - see track.controller.
    arrivalRadius: ARRIVAL_RADIUS_METRES,

    /*
     * The door this job is for.
     *
     * Sent so the app can draw the map from the moment of booking rather than
     * only once somebody is on the way - which is what a customer expects
     * after ordering anything. Where the technician is comes over the tracking
     * socket, not from here: it changes every few seconds and this payload is
     * fetched once.
     */
    destination: Number.isFinite(t.location?.coordinates?.[1])
        ? { lat: t.location.coordinates[1], lon: t.location.coordinates[0] }
        : null,

    /*
     * Why it was called off, if it was.
     *
     * Only the office can cancel a ticket, and the reason it records is the
     * only honest answer to "what happened to my job". Without it the app
     * shows a job that has simply stopped, which reads as the company having
     * lost it - and the customer rings to ask something the screen could have
     * told them.
     *
     * A technician handing a job back is not this. That is a refusal, it is
     * settled inside the office, and the customer is never shown it.
     */
    cancelReason: t.status === "Cancelled" ? (t.cancelReason || null) : null,

    /*
     * What the customer said about it, once they have said anything.
     *
     * Sent back so the card can show the stars they gave rather than asking
     * again - a screen that keeps offering to take a rating it already has is
     * a screen that looks like it lost the first one.
     */
    rating: t.feedback?.ratedAt
        ? { stars: t.feedback.rating || 0, tags: t.feedback.tags || [] }
        : null,

    /*
     * The two codes read out at the door.
     *
     * They go to the customer on WhatsApp already; the app is another channel
     * to the same person, and somebody who booked in the app should not have
     * to leave it to find the number the engineer is asking for. A code that
     * has been used is worth nothing and is sent as null rather than left on
     * the screen to be confused with the one still wanted.
     */
    codes: {
        start: t.otp?.start?.verifiedAt ? null : t.otp?.start?.code || null,
        close: t.otp?.close?.verifiedAt ? null : t.otp?.close?.code || null,
    },

    bill: t.billing?.invoiceNumber
        ? {
            invoiceNumber: t.billing.invoiceNumber,
            totalDisplay: paymentService.paiseToRupees(t.billing.totalPaise || 0),
            workDone: t.billing.workDone || null,
            method: t.payment?.method || null,
            paid: t.payment?.status === "Collected" || t.payment?.status === "Verified",

            /*
             * The document itself, where there is one.
             *
             * Written when the job closed and uploaded to ImageKit, so this is
             * a plain link the app can open or hand to the phone's own
             * downloader. Null on an older ticket and on one whose upload
             * failed - both mean the same thing to a screen, which is that
             * there is nothing to offer yet, and the figures above are still
             * the bill.
             */
            pdfUrl: t.billing.invoicePdfUrl || null,
        }
        : null,

    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
});

/**
 * Every open job has a tracking token, even the ones booked before it did.
 *
 * The token is what the map on a job is built on - no token, no socket, no
 * arc, no bike - and it is minted at booking now. Jobs taken before that
 * change got theirs only when somebody was assigned, so an old ticket sitting
 * in the app shows a job with no picture of where it is going, which is
 * exactly the thing the map was added to fix.
 *
 * One write, once per ticket, on a read that was happening anyway.
 */
const ensureTokens = async (tickets) => {
    const missing = tickets.filter((t) => !t.tracking?.token);
    if (!missing.length) return tickets;

    await Promise.all(missing.map(async (t) => {
        const token = issueToken();

        await ticketModel.updateOne(
            { _id: t._id, "tracking.token": { $in: [null, ""] } },
            { $set: { "tracking.token": token, "tracking.issuedAt": new Date() } },
        ).catch(() => {});

        // Read back rather than trusting our own token: another write in the
        // same instant may have won.
        const saved = await ticketModel.findById(t._id).select("tracking.token").lean().catch(() => null);
        t.tracking = { ...(t.tracking || {}), token: saved?.tracking?.token || token };
    }));

    return tickets;
};

/**
 * GET /api/customer/tickets
 *
 * Both halves in one call: what is running now, and what is finished. The app
 * shows them on one screen and the website shows only the history, and neither
 * should have to make two requests to fill a page.
 */
const myTickets = async (req, res) => {
    try {
        const [open, closed] = await Promise.all([
            ticketModel
                .find({ customer: req.user._id, status: { $in: booking.OPEN_STATUSES } })
                .select(TICKET_FIELDS)
                .sort({ createdAt: -1 })
                .lean(),

            ticketModel
                .find({ customer: req.user._id, status: { $in: ["Closed", "Cancelled"] } })
                .select(TICKET_FIELDS)
                .sort({ updatedAt: -1 })
                .limit(30)
                .lean(),
        ]);

        await ensureTokens(open);

        return res.status(200).json({
            success: true,
            data: { open: open.map(shape), closed: closed.map(shape) },
        });
    } catch (error) {
        console.error("Customer tickets error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * GET /api/customer/tickets/:id
 *
 * Scoped to the customer on purpose. A ticket id in a URL is not a permission,
 * and this is the one place the app asks for a single job by id.
 */
const ticketDetail = async (req, res) => {
    try {
        const ticket = await ticketModel
            .findOne({ _id: req.params.id, customer: req.user._id })
            .select(TICKET_FIELDS)
            .lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "We could not find that job on your account." });
        }

        await ensureTokens([ticket]);

        return res.status(200).json({ success: true, data: shape(ticket) });
    } catch (error) {
        console.error("Customer ticket detail error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};


/* ================= WHERE WE WORK ================= */

/**
 * GET /api/customer/coverage?lat=&lon=   (or ?q=<place or pincode>)
 *
 * Which of our services actually have somebody behind them where this person
 * lives.
 *
 * The catalogue is national and the company is not. Listing every service to a
 * visitor in a town we have never sent anybody to is the sort of thing that
 * gets found out at the worst possible moment - after they have described
 * their problem and waited. So the website asks this before it promises
 * anything, and a service with nobody near it is shown as such rather than
 * quietly left on the list.
 *
 * Public, because the question comes before the account.
 */
const COVER_RADIUS_M = 25000;

/** Kilometres between two points, good enough for "how far is the nearest one". */
const kmBetween = (aLat, aLon, bLat, bLon) => {
    const R = 6371;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(bLat - aLat);
    const dLon = rad(bLon - aLon);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
};

const coverage = async (req, res) => {
    try {
        const lat = Number(req.query.lat);
        const lon = Number(req.query.lon);
        const hasPin = Number.isFinite(lat) && Number.isFinite(lon)
            && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

        let term = String(req.query.q || "").trim();
        let place = null;

        /*
         * A dropped pin is turned into a place name as well as used as a
         * point, because the two searches below catch different people. The
         * geo search only sees vendors whose phone has reported a position;
         * the name search reaches everybody else, who typed their town when
         * they registered and may never have opened the app since.
         */
        if (hasPin && !term) {
            try {
                const found = (await lookupPlace(lat, lon))?.results?.[0];
                if (found) {
                    place = {
                        label: found.locality || found.city || found.state || "",
                        city: found.city || "",
                        state: found.state || "",
                        pincode: found.pincode || "",
                    };
                    term = place.city || place.label || place.state;
                }
            } catch (err) {
                // A name we could not resolve costs us the text search, not
                // the answer - the geo search still runs.
                console.error("Coverage place lookup failed:", err.message);
            }
        }

        if (!hasPin && !term) {
            return res.status(400).json({
                success: false,
                message: "Send a location, or the name of a town or a pincode.",
            });
        }

        // A typed town is shown back to them, so it is shown back the way a
        // name is written rather than the way it was typed into a box
        const titled = term.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
        if (!place && term) place = { label: titled, city: titled, state: "", pincode: "" };

        const base = {
            isDeleted: false,
            isBlacklisted: { $ne: true },
            approvalStatus: "approved",
        };

        const PICK = "skills location area state pincode";
        const found = new Map();
        const keep = (list) => list.forEach((t) => found.set(String(t._id), t));

        if (hasPin) {
            keep(await technicianModel.find({
                ...base,
                location: {
                    $near: {
                        $geometry: { type: "Point", coordinates: [lon, lat] },
                        $maxDistance: COVER_RADIUS_M,
                    },
                },
            }).select(PICK).limit(300).lean());
        }

        if (term) {
            const rx = new RegExp(escapeRegex(term), "i");
            keep(await technicianModel.find({
                ...base,
                $or: [{ area: rx }, { state: rx }, { pincode: rx }],
            }).select(PICK).limit(300).lean());
        }

        const near = [...found.values()];

        const services = SERVICE_CATALOG.map((service) => {
            const rx = buildSkillRegex(service.key);
            const able = near.filter((t) => (t.skills || []).some((s) => rx.test(s)));

            // How far the closest one is, for the vendors we have a position
            // for. Absent when the only matches came from the name search,
            // which is the honest answer rather than a guessed figure.
            let nearestKm = null;
            if (hasPin) {
                able.forEach((t) => {
                    const c = t.location?.coordinates;
                    if (!Array.isArray(c) || c.length !== 2) return;
                    const d = kmBetween(lat, lon, c[1], c[0]);
                    if (nearestKm === null || d < nearestKm) nearestKm = d;
                });
            }

            return {
                key: service.key,
                label: service.label,
                available: able.length > 0,
                vendors: able.length,
                nearestKm: nearestKm === null ? null : Math.round(nearestKm * 10) / 10,
            };
        });

        /*
         * How many people, not how many people per trade added together.
         * One engineer who does both AC and electrical work is one engineer,
         * and counting them twice would be the sort of number a company
         * quietly inflates.
         */
        const anyRx = SERVICE_CATALOG.map((x) => buildSkillRegex(x.key));
        const engineers = near.filter((t) =>
            (t.skills || []).some((skill) => anyRx.some((rx) => rx.test(skill)))).length;

        return res.status(200).json({
            success: true,
            data: {
                place,
                radiusKm: Math.round(COVER_RADIUS_M / 1000),
                engineers,
                services,
                covered: services.some((s) => s.available),
            },
        });
    } catch (error) {
        console.error("Coverage error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};


/* ================= THE ASSISTANT ================= */

/**
 * POST /api/customer/ask
 *
 * The website's assistant. It explains the company to anybody, and reads back
 * their own jobs to somebody signed in - and it cannot book, because the
 * service behind it is never handed a booking tool at all.
 *
 * Open to visitors on purpose: the questions that decide whether somebody ever
 * becomes a customer all come before the account does.
 */
/**
 * How long a website chat survives after the last thing said in it.
 *
 * Three days: long enough that somebody can come back to what the assistant
 * told them about their own job, short enough that the busiest page on the
 * site never turns into the largest collection in the database. Mongo does the
 * deleting itself, from the TTL index on the model.
 */
const CHAT_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

const newChatId = () => (
    typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : crypto.randomBytes(18).toString("hex")
);

/** GET /api/customer/chat/:chatId - the thread, for a tab that came back. */
const chat = async (req, res) => {
    try {
        const found = await WebChat.findOne({ chatId: String(req.params.chatId || "") }).lean();

        // A chat that has expired is not an error - it is the feature working.
        // The page starts a new one rather than showing somebody a failure.
        if (!found) {
            return res.status(200).json({ success: true, data: { chatId: "", turns: [] } });
        }

        return res.status(200).json({
            success: true,
            data: {
                chatId: found.chatId,
                turns: found.turns.map((turn) => ({ role: turn.role, text: turn.text })),
            },
        });
    } catch (error) {
        console.error("Chat read error:", error.message);
        return res.status(200).json({ success: true, data: { chatId: "", turns: [] } });
    }
};

/**
 * DELETE /api/customer/chat/:chatId
 *
 * Somebody clearing a conversation they would rather not leave lying around.
 * It would have gone on its own within three days; this is for the person who
 * does not want to wait, and it answers the same way whether the chat was
 * there or not - there is nothing to tell them either way.
 */
const forgetChat = async (req, res) => {
    try {
        await WebChat.deleteOne({ chatId: String(req.params.chatId || "") });
        return res.status(200).json({ success: true, message: "Chat deleted." });
    } catch (error) {
        console.error("Chat delete error:", error.message);
        return res.status(200).json({ success: true, message: "Chat deleted." });
    }
};

const ask = async (req, res) => {
    try {
        const message = String(req.body.message || "").trim();

        if (!message) {
            return res.status(400).json({ success: false, message: "Ask something first." });
        }

        /*
         * The thread is the stored one, not the browser's copy.
         *
         * What the page sends is only used to start a chat that does not exist
         * yet. Once there is a document, that is the record: it cannot be
         * edited from the client, and two tabs on the same chat stay in step.
         */
        const chatId = String(req.body.chatId || "").trim();
        const existing = chatId ? await WebChat.findOne({ chatId }) : null;

        const history = existing
            ? existing.turns.map((turn) => ({ role: turn.role, text: turn.text }))
            : (Array.isArray(req.body.history) ? req.body.history : []);

        const reply = await assistant.answer({ message, history, user: req.user });

        if (!reply) {
            return res.status(502).json({
                success: false,
                message: "The assistant did not answer that one. Try asking it a different way, or send it to our WhatsApp instead.",
            });
        }

        /*
         * Both sides of the exchange, written after the answer rather than
         * before it. A question nobody could answer is not worth keeping, and
         * this way a failed turn leaves the thread exactly as it was.
         */
        const turns = [
            { role: "user", text: message },
            { role: "model", text: reply },
        ];

        const saved = existing || new WebChat({ chatId: chatId || newChatId(), turns: [] });

        saved.turns.push(...turns);
        // Kept to a sane length: the model only reads the last dozen anyway,
        // and a thread nobody trims is a document that grows all week
        if (saved.turns.length > 60) saved.turns = saved.turns.slice(-60);

        if (req.user?._id) saved.user = req.user._id;
        saved.expiresAt = new Date(Date.now() + CHAT_KEEP_MS);

        await saved.save().catch((err) => {
            // The answer matters more than the record of it
            console.error("Chat not saved:", err.message);
        });

        return res.status(200).json({ success: true, data: { reply, chatId: saved.chatId } });
    } catch (error) {
        console.error("Assistant error:", error.message);
        return res.status(500).json({
            success: false,
            message: "The assistant is not reachable just now. Try again in a moment, or send the same question to our WhatsApp.",
        });
    }
};


/* ------------------------------------------------------------------ */
/* ADDRESSES                                                           */
/* ------------------------------------------------------------------ */

/**
 * The customer's saved places.
 *
 * Thin on purpose - every rule about defaults and about keeping the account's
 * own address in step lives in services/address.service.js, because those
 * rules have to hold whichever door they are changed through.
 */


/**
 * What a customer can say about a finished job, in their own words and taps.
 *
 * Only their own ticket, only once it is closed, and only once. The office
 * needs to be able to read a rating as a fact about a visit rather than as
 * something that moved - a vendor who talks a customer into changing a two
 * into a four has changed the record the office judges him by.
 *
 * This is the app's half of the answer. The other half - the assistant
 * ringing afterwards in the job's own language - is waiting on the client's
 * Exotel subscription, and when it arrives it reads `feedback.source` so it
 * does not ask again for something already answered here.
 */
const RATING_TAGS = [
    "On time",
    "Clean work",
    "Explained the price",
    "Polite",
    "Came prepared",
    "Left it tidy",
];

const rateTicket = async (req, res) => {
    try {
        const stars = Number(req.body.stars);

        if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
            return res.status(400).json({ success: false, message: "Pick between one and five stars." });
        }

        /*
         * `customer`, not `user`.
         *
         * A ticket names its owner in a field called `customer` - every other
         * query in this file scopes on it - and this one asked for `user`,
         * which no ticket has. So the filter never matched, and every rating
         * anybody tried to leave came back as "We could not find that job" on
         * a job they were looking at. It was not a permission check failing; it
         * was a field name that does not exist.
         */
        const ticket = await ticketModel.findOne({ _id: req.params.id, customer: req.user._id });
        if (!ticket) return res.status(404).json({ success: false, message: "We could not find that job." });

        if (ticket.status !== "Closed") {
            return res.status(400).json({
                success: false,
                message: "This job is not finished yet.",
            });
        }

        if (ticket.feedback?.ratedAt) {
            return res.status(409).json({
                success: false,
                message: "You have already rated this job.",
            });
        }

        // Only the chips this server offers. Anything else is somebody
        // posting at the endpoint rather than tapping in the app.
        const tags = (Array.isArray(req.body.tags) ? req.body.tags : [])
            .filter((t) => RATING_TAGS.includes(t))
            .slice(0, RATING_TAGS.length);

        ticket.feedback = {
            ...(ticket.feedback?.toObject?.() || ticket.feedback || {}),
            source: "app",
            ratedAt: new Date(),
            rating: stars,
            tags,
            note: String(req.body.comment || "").trim().slice(0, 500),
        };

        await ticket.save();

        // The trade's score is counted from the tickets and held for a few
        // minutes. Dropping it here means the customer who just rated a job
        // sees their own rating reflected rather than the figure from before.
        ratings.forget();

        /*
         * And the vendor's own average moves with it.
         *
         * Worked out from the count rather than from the stored average
         * alone, because the stored average starts at five for somebody
         * nobody has rated - averaging a genuine three into that placeholder
         * would report a four that nobody gave.
         */
        const technicianId = ticket.technician || ticket.technicianSnapshot?.technician;

        if (technicianId) {
            const tech = await technicianModel.findById(technicianId).select("rating ratingCount");

            if (tech) {
                const count = tech.ratingCount || 0;
                const next = count > 0
                    ? ((tech.rating * count) + stars) / (count + 1)
                    : stars;

                tech.rating = Math.round(next * 100) / 100;
                tech.ratingCount = count + 1;
                await tech.save();
            }
        }

        return res.status(200).json({
            success: true,
            data: { stars, tags },
            message: "Thank you - that goes straight to the office.",
        });
    } catch (error) {
        console.error("Rate ticket error:", error);
        return res.status(500).json({ success: false, message: "Could not save your rating." });
    }
};

/** The chips the app offers, so there is one list rather than two. */
const ratingTags = (_req, res) => res.status(200).json({ success: true, data: RATING_TAGS });

const listAddresses = async (req, res) => {
    try {
        return res.status(200).json({ success: true, data: await addressService.list(req.user._id) });
    } catch (error) {
        console.error("List addresses error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

const addAddress = async (req, res) => {
    try {
        const saved = await addressService.add(req.user._id, req.body);
        return res.status(201).json({ success: true, data: saved });
    } catch (error) {
        // "needs a point on the map" and "no such customer" are both the
        // caller's problem, not the server's.
        return res.status(400).json({ success: false, message: error.message });
    }
};

const updateAddress = async (req, res) => {
    try {
        const saved = await addressService.update(req.user._id, req.params.id, req.body);
        return res.status(200).json({ success: true, data: saved });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const deleteAddress = async (req, res) => {
    try {
        await addressService.remove(req.user._id, req.params.id);
        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const makeAddressDefault = async (req, res) => {
    try {
        const saved = await addressService.setDefault(req.user._id, req.params.id);
        return res.status(200).json({ success: true, data: saved });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};


/**
 * PUT /api/customer/push-token
 *
 * Where to reach this phone when the app is shut.
 *
 * One token per account, replaced rather than collected: a customer who signs
 * in on a new phone should be rung on the new one, not on both. An empty value
 * clears it, which is what signing out sends.
 */
const savePushToken = async (req, res) => {
    try {
        const token = String(req.body?.token || "").trim();

        await userModel.updateOne(
            { _id: req.user._id },
            token ? { pushToken: token } : { $unset: { pushToken: 1 } }
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Save push token error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * GET /api/customer/announcements
 *
 * The posters for the home screen and the notices behind the bell.
 *
 * Both in one request because the home screen needs both and a second round
 * trip on app open is a second chance to be slow on a phone holding one bar of
 * signal. Only what is live: inactive rows and anything outside its dates never
 * leaves the server, so the app has no rules of its own to get wrong.
 *
 * A notice that has never been sent is a draft and is not shown either. The
 * office writing one is not the office publishing it.
 */
const announcements = async (req, res) => {
    try {
        const now = new Date();

        const live = {
            isActive: true,
            $and: [
                { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
                { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
            ],
        };

        const [posters, notices] = await Promise.all([
            Announcement.find({ ...live, placement: "poster" })
                .sort({ order: 1, createdAt: -1 })
                .limit(8)
                .lean(),

            Announcement.find({ ...live, placement: "notice", pushedAt: { $ne: null } })
                .sort({ pushedAt: -1 })
                .limit(30)
                .lean(),
        ]);

        const seenAt = req.user?.noticesSeenAt || null;

        const shape = (row) => ({
            id: String(row._id),
            title: row.title,
            body: row.body || "",
            imageUrl: row.imageUrl || "",
            action: {
                kind: row.action?.kind || "none",
                serviceKey: row.action?.serviceKey || null,
                url: row.action?.url || null,
            },
            at: row.pushedAt || row.createdAt,
        });

        return res.status(200).json({
            success: true,
            data: {
                posters: posters.map(shape),
                notices: notices.map(shape),

                // What the bell's badge shows. Counted here rather than in the
                // app so the number and the list can never disagree.
                unread: seenAt
                    ? notices.filter((n) => n.pushedAt > seenAt).length
                    : notices.length,
            },
        });
    } catch (error) {
        console.error("Announcements error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * POST /api/customer/notices/seen
 *
 * The bell has been opened, so the badge goes.
 *
 * Stamped with the server's own clock rather than one the app sends: a phone
 * whose date is a week ahead would otherwise mark every future notice read on
 * arrival, and the customer would never hear about anything again.
 */
const noticesSeen = async (req, res) => {
    try {
        await userModel.updateOne({ _id: req.user._id }, { noticesSeenAt: new Date() });
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Notices seen error:", error.message);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

module.exports = {
    announcements,
    noticesSeen,
    rateTicket,
    ratingTags,
    savePushToken,
    listAddresses,
    addAddress,
    updateAddress,
    deleteAddress,
    makeAddressDefault,
    sendOtp,
    verifyOtp,
    me,
    logout,
    updateProfile,
    getServices,
    coverage,
    ask,
    chat,
    forgetChat,
    book,
    myTickets,
    ticketDetail,
};

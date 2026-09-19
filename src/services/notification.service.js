const whatsapp = require("./whatsapp.service");
const ticketModel = require("../models/ticket.model");
const { issueToken } = require("./track.service");
const Conversation = require("../models/conversation.model");
const { emitToRoom, userRoom, techRoom, adminRoom, roomSize } = require("../sockets/socket.instance");
const push = require("./push.service");
const userModel = require("../models/user.model");
const { copyFor } = require("../config/copy");

/**
 * The language this customer chose, for the few messages we write ourselves.
 *
 * The assistant has answered in it since the first turn - it is handed the
 * choice on every call - but these lines are the office speaking, not the
 * assistant, and they were written once in English and sent to everybody. On
 * an Odia thread that reads as a second, colder company; and the two that
 * matter most are a code somebody reads out at their own door and a bill.
 *
 * English is the fallback, as it is everywhere else here: a customer who never
 * picked is a customer who was never asked.
 */
const speaks = async (ticket) => {
    try {
        const user = await userModel
            .findById(ticket.customer)
            .select("language languageConfirmedAt")
            .lean();

        return copyFor(user?.languageConfirmedAt ? user.language : null);
    } catch {
        return copyFor(null);
    }
};

// Google Maps deep link - no API key, no cost. Opens the Maps app with
// navigation ready to go.
const buildDirectionsUrl = (lat, lon) => {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
    return "https://www.google.com/maps/dir/?api=1&destination=" + lat + "," + lon + "&travelmode=driving";
};

const buildPinUrl = (lat, lon) => {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
    return "https://www.google.com/maps/search/?api=1&query=" + lat + "," + lon;
};

/**
 * Every customer-facing message goes through here. Web chat gets a socket
 * event, WhatsApp gets a real message - and the same call handles both so
 * no caller has to remember which channel the customer came in on.
 */
const notifyCustomer = async ({ ticket, text }) => {
    emitToRoom(userRoom(ticket.customer), "ai-response", {
        content: text,
        sender: "system",
        chat: ticket.ticketNumber,
    });

    const phone = ticket.customerSnapshot?.phone;
    if (!phone) {
        console.warn("[NOTIFY] No phone on ticket " + ticket.ticketNumber + " - WhatsApp skipped");
        return;
    }

    // Older tickets were created before the channel field existed, and a
    // missing channel shouldn't mean a silent customer. If there's a phone
    // number, send it.
    if (ticket.channel === "web") return;

    await whatsapp.sendText(phone, text);
};

/**
 * Where a customer can watch their job.
 *
 * The first origin in CLIENT_ORIGINS is the real site; the rest of that list
 * exists for CORS during development, so taking [0] rather than joining them
 * is deliberate.
 */
const publicOrigin = () =>
    (process.env.CLIENT_ORIGINS || "http://localhost:5173").split(",")[0].trim();

/**
 * Gives a ticket its tracking link, once.
 *
 * Issued the first time the customer is told about the job at all - a link
 * that exists before anyone has been sent one is a secret with no owner.
 * Re-assigning does not mint a new one.
 *
 * Nothing sends the URL any more. The app's own tracking screen is built on
 * this token, and opening a web page inside WhatsApp's browser was slower and
 * worse than the screen the customer already had. The token is what is wanted;
 * the link is a leftover of how it used to be delivered.
 */
const ensureTrackingLink = async (ticket) => {
    if (ticket.tracking?.token) return publicOrigin() + "/track/" + ticket.tracking.token;

    const token = issueToken();

    await ticketModel.updateOne(
        { _id: ticket._id, "tracking.token": { $in: [null, ""] } },
        { $set: { "tracking.token": token, "tracking.issuedAt": new Date() } }
    );

    // Another assignment in the same instant may have won the write, so read
    // back rather than trusting the token we generated
    const saved = await ticketModel.findById(ticket._id).select("tracking.token").lean();
    return publicOrigin() + "/track/" + (saved?.tracking?.token || token);
};

/**
 * Somebody is coming, and the app is where they are told.
 *
 * This was four lines of WhatsApp - name, number, rating, tracking - and every
 * one of them is now a card on the job screen, live, with a map under it. The
 * message was the same words a second time, and from October 2026 Meta bills
 * for each one.
 *
 * Sent to nobody without the app, because there is nobody without the app: the
 * assistant will not talk to an unregistered number at all - it hands out the
 * download link and waits. So the push is not a shortcut for app users, it is
 * the channel.
 */
const notifyCustomerAssigned = async (ticket) => {
    const tech = ticket.technicianSnapshot || {};

    /*
     * The token first, either way.
     *
     * It is minted here rather than used here: the app's own tracking screen
     * is built on it, so skipping this would leave a customer with a screen
     * that has nothing to open.
     */
    await ensureTrackingLink(ticket);

    push.sendToCustomer(ticket.customer, {
        title: "Your technician has been assigned",
        body: (tech.name || "A technician") + " is coming for " + (ticket.serviceLabel || "your job") + ".",
        data: { ticketId: String(ticket._id), kind: "accepted" },
    });
};

/**
 * The technician has accepted, so now the customer hears about him.
 *
 * This used to fire the moment the office assigned somebody, which meant a
 * technician who turned the job down had already been introduced by name and
 * phone number - and the next one was introduced the same way a few minutes
 * later. Nothing goes out until somebody has agreed to come.
 *
 * Queued or not makes no difference to what is sent any more. It used to: a
 * queued job got different wording on WhatsApp, because "expect him at your
 * door" would have been a lie. The app says which it is on its own - the job
 * sits there with his name on it and its own stage - so there is one
 * announcement and the screen carries the detail.
 */
const notifyCustomerAccepted = async (ticket) => notifyCustomerAssigned(ticket);

/**
 * The code the technician has to be told before he can start, or close.
 *
 * Sent to the customer, never to the technician - the whole point is that he
 * has to be standing in front of them to learn it.
 */
const sendCustomerOtp = async (ticket, code, purpose) => {
    const t = await speaks(ticket);

    const text = purpose === "close"
        ? t.otpClose(code, ticket.ticketNumber)
        : t.otpStart(code, ticket.ticketNumber);

    await notifyCustomer({ ticket, text });
};

/**
 * The work has started.
 *
 * The customer read a code out to him thirty seconds ago, so they know he is
 * inside; the job screen says "Work under way" by itself. A notification is
 * enough to mark the moment - see notifyCustomerAssigned for why it is not a
 * WhatsApp message any more.
 */
const notifyCustomerWorkStarted = async (ticket) => {
    const tech = ticket.technicianSnapshot || {};

    push.sendToCustomer(ticket.customer, {
        title: "Work has started",
        body: (tech.name || "Your technician") + " has begun on " + (ticket.serviceLabel || "your job") + ".",
        data: { ticketId: String(ticket._id), kind: "working" },
    });
};

/**
 * The technician has set off.
 *
 * No estimated arrival time, and no message. A printed estimate is a promise
 * that goes stale the moment traffic does; the tracking screen is right
 * without anybody sending anything, and it is two taps away from the
 * notification this fires.
 *
 * The tracking token is still minted here - that screen is built on it.
 */
const notifyCustomerTechnicianEnRoute = async (ticket) => {
    const tech = ticket.technicianSnapshot || {};

    await ensureTrackingLink(ticket);

    push.sendToCustomer(ticket.customer, {
        title: (tech.name || "Your technician") + " is on the way",
        body: "They have set off for " + (ticket.serviceLabel || "your job") + ".",
        data: { ticketId: String(ticket._id), kind: "on_the_way" },
    });
};

/**
 * They are at the door.
 *
 * The one moment on the whole job where a second matters, and a notification
 * is better at it than a chat message: it lands on the lock screen of a phone
 * somebody is not looking at, which is exactly where this customer is.
 */
const notifyCustomerArrived = async (ticket) => {
    const who = ticket.technicianSnapshot?.name || "Your technician";

    push.sendToCustomer(ticket.customer, {
        title: who + " has arrived",
        body: "They are at your address for " + (ticket.serviceLabel || "your job") + ".",
        data: { ticketId: String(ticket._id), kind: "arrived" },
    });
};

const notifyCustomerCancelled = async (ticket) => {
    const t = await speaks(ticket);

    const text = t.ticketCancelled(
        ticket.ticketNumber,
        ticket.cancelReason || "Not specified"
    );

    await notifyCustomer({ ticket, text });
};

/**
 * A cancelled or closed ticket has to unstick the WhatsApp conversation.
 * Otherwise the customer's next message lands on a step that assumes a
 * live ticket, and they end up typing into a dead-end instead of seeing
 * the service menu.
 */
const resetConversation = async (ticket) => {
    const phone = ticket.customerSnapshot?.phone;
    if (!phone) return;

    // Conversation records store the wa_id form (91XXXXXXXXXX), while the
    // ticket snapshot holds the plain 10-digit number
    const digits = String(phone).replace(/\D/g, "");
    const candidates = [digits, digits.length === 10 ? "91" + digits : digits.replace(/^91/, "")];

    try {
        await Conversation.updateOne(
            { phone: { $in: candidates } },
            {
                step: "AWAITING_SERVICE",
                activeTicket: null,
                selectedServiceKey: undefined,
                selectedIssues: [],
            }
        );
    } catch (err) {
        console.error("[NOTIFY] Could not reset conversation:", err.message);
    }
};

/**
 * The invoice itself, once it has somewhere to live.
 *
 * Sent after the closing message rather than with it: the figures are what
 * the customer wants to read in the chat, and a document arriving on top of
 * them would bury the one line - the amount - that they actually check. This
 * is the copy they keep.
 *
 * Nothing is said when it fails. The bill has already reached them in words,
 * the URL is on the ticket for both apps to offer, and an apology for a PDF
 * that did not arrive is a message about our plumbing, not about their job.
 */
const sendCustomerInvoice = async (ticket, url) => {
    const phone = ticket?.customerSnapshot?.phone;
    if (!phone || !url) return;

    const number = ticket.billing?.invoiceNumber || ticket.ticketNumber;

    await whatsapp.sendDocument(phone, {
        url,
        filename: String(number).replace(/[^A-Za-z0-9-]/g, "-") + ".pdf",
        caption: "Invoice " + number + " for " + (ticket.serviceLabel || "your job") + ".",
    });
};

/* ---------- TECHNICIAN ---------- */

const notifyTechnicianAssigned = (ticket) => {
    if (!ticket.technician) return;

    const lat = ticket.customerSnapshot?.lat;
    const lon = ticket.customerSnapshot?.lon;

    /*
     * Whether there is anybody there to hear it.
     *
     * An emit into an empty room succeeds. That is what made "the phone did
     * not ring" impossible to chase from this end: the log said the job was
     * sent, and it was - into a room with nothing in it, because the vendor
     * app only holds a socket while the vendor is on duty. Counting first
     * turns the silence into a sentence.
     */
    const listening = roomSize(techRoom(ticket.technician));

    console.log(
        "[NOTIFY] " + ticket.ticketNumber + " assigned to "
        + (ticket.technicianSnapshot?.name || ticket.technician)
        + (listening
            ? " - " + listening + " device(s) listening, the app will ring"
            : " - NO device listening (app closed or vendor off duty), so only the push and WhatsApp can reach them")
    );

    emitToRoom(techRoom(ticket.technician), "ticket:assigned", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        serviceLabel: ticket.serviceLabel,
        selectedIssues: ticket.selectedIssues,
        problemDescription: ticket.problemDescription,
        scheduledFor: ticket.scheduling?.scheduledFor || null,
        customer: {
            name: ticket.customerSnapshot?.name,
            phone: ticket.customerSnapshot?.phone,
            address: ticket.customerSnapshot?.address,
            area: ticket.customerSnapshot?.area,
            landmark: ticket.customerSnapshot?.landmark,
            lat,
            lon,
        },
        directionsUrl: buildDirectionsUrl(lat, lon),
    });

    /*
     * And through the platform, for the phone that is not listening.
     *
     * The emit above only reaches a vendor whose app is in front of them.
     * Press the home button and Android freezes the process - the socket
     * goes with it, and so does the code that would have made a sound.
     * This is the one thing that still lands, because Android delivers it
     * rather than us.
     *
     * Deliberately not awaited. Assigning a job must not get slower, or
     * fail, because a push server is having a bad minute.
     */
    push.sendToTechnician(ticket.technician, {
        title: "New job assigned",
        body: [ticket.serviceLabel, ticket.customerSnapshot?.area].filter(Boolean).join(" - ")
            || "A job has been given to you. Open it to see where.",
        data: { kind: "ticket:assigned", ticketId: String(ticket._id) },
    });
};

/**
 * The socket event only lands if their panel happens to be open. A
 * technician on the road has it closed, so the job also goes to their
 * WhatsApp - that's the one they'll actually see.
 */
const notifyTechnicianAssignedOnWhatsApp = async (ticket) => {
    const tech = ticket.technicianSnapshot || {};
    if (!tech.phone) return;

    const customer = ticket.customerSnapshot || {};
    const directionsUrl = buildDirectionsUrl(customer.lat, customer.lon);

    const text =
        "*New job assigned*\n\n" +
        "Ticket: " + ticket.ticketNumber + "\n" +
        "Service: " + ticket.serviceLabel + "\n" +
        (ticket.problemDescription ? "Issue: " + ticket.problemDescription + "\n" : "") +
        "\nCustomer: " + (customer.name || "-") + "\n" +
        "Phone: " + (customer.phone || "-") + "\n" +
        "Area: " + (customer.area || "-") + "\n" +
        (customer.address ? "Address: " + customer.address + "\n" : "") +
        (directionsUrl ? "\nDirections:\n" + directionsUrl : "");

    await whatsapp.sendText(tech.phone, text);
};

const notifyTechnicianQueued = (ticket) => {
    if (!ticket.technician) return;
    emitToRoom(techRoom(ticket.technician), "ticket:queued", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        serviceLabel: ticket.serviceLabel,
        customerName: ticket.customerSnapshot?.name,
        area: ticket.customerSnapshot?.area,
        scheduledFor: ticket.scheduling?.scheduledFor || null,
    });

    // Quieter than an assignment - it is work for later, not work now -
    // but it still has to reach a closed app, or the vendor finds out
    // about tomorrow's job by opening the app tomorrow.
    push.sendToTechnician(ticket.technician, {
        title: "Another job queued",
        body: [ticket.serviceLabel, ticket.customerSnapshot?.area].filter(Boolean).join(" - ")
            || "One more job is waiting behind your current one.",
        data: { kind: "ticket:queued", ticketId: String(ticket._id) },
    });
};

const notifyTechnicianUnassigned = (technicianId, ticket) => {
    emitToRoom(techRoom(technicianId), "ticket:removed", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        reason: "This job is no longer assigned to you. Please refresh your panel.",
    });
};

const notifyTechnicianPaymentReceived = (ticket) => {
    if (!ticket.technician) return;
    emitToRoom(techRoom(ticket.technician), "ticket:closed", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        invoiceNumber: ticket.billing?.invoiceNumber,
    });
};

const notifyTechnicianCashVerified = (technicianId, payment) => {
    emitToRoom(techRoom(technicianId), "cash:verified", {
        paymentId: String(payment._id),
        ticketNumber: payment.ticketNumber,
        invoiceNumber: payment.invoiceNumber,
        amountPaise: payment.amountPaise,
    });
};

/**
 * The office has sent a technician his share of the online jobs.
 *
 * He is not sitting in the app waiting for it - the money lands in his bank
 * days after the customer paid, and the first thing he does is ask the office
 * whether it went out. So the confirmation goes to the number he registered
 * with, with the reference on it, and that conversation stops happening.
 */
const notifyTechnicianPaidOnWhatsApp = async (technician, { amountDisplay, method, reference, balanceDisplay, owes }) => {
    if (!technician?.phone) return;

    const text =
        "*Payment sent. Rs " + amountDisplay + "*\n\n" +
        "This is your share of the jobs customers paid online.\n\n" +
        (method ? "Sent by: " + method + "\n" : "") +
        (reference ? "Reference: " + reference + "\n" : "") +
        "\n" +
        (owes
            ? "Still to deposit with the office: Rs " + balanceDisplay
            : Number(balanceDisplay) > 0
                ? "Still with the office for you: Rs " + balanceDisplay
                : "Your wallet is now clear - nothing pending either way.") +
        "\n\nIt can take a few hours to show in your bank. Message us here if it does not arrive.";

    await whatsapp.sendText(technician.phone, text);
};

const notifyTechnicianBlocked = (technicianId) => {
    emitToRoom(techRoom(technicianId), "account:blocked", {
        message: "This account has been blocked. Contact the office.",
    });
};

/**
 * The technician is out for the rest of the day.
 *
 * Told to him over his own socket so the app can put a wall up immediately,
 * and to the office because his queue has just landed back on their desk.
 * Neither is a courtesy: somebody has to reassign those jobs today.
 */
const notifyTechnicianPaused = (technicianId, count, until) => {
    emitToRoom(techRoom(technicianId), "account:paused", {
        declines: count,
        until,
        message: "You have turned down " + count + " jobs today. Your account is paused until tomorrow morning.",
    });
};

/* ---------- ADMINS ---------- */

const notifyAdminsTechnicianPaused = (technician, count, until) => {
    notifyTechnicianPaused(technician._id, count, until);

    emitToRoom(adminRoom(), "technician:paused", {
        technicianId: String(technician._id),
        name: technician.name,
        phone: technician.phone,
        declines: count,
        until,
    });
};


const notifyAdminsNewTicket = (ticket) => {
    emitToRoom(adminRoom(), "ticket:new", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        serviceLabel: ticket.serviceLabel,
        customerName: ticket.customerSnapshot?.name,
        area: ticket.customerSnapshot?.area,
        createdAt: ticket.createdAt,
    });
};

const notifyAdminsTicketRejected = (ticket, technicianName, reason) => {
    emitToRoom(adminRoom(), "ticket:rejected", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        serviceLabel: ticket.serviceLabel,
        customerName: ticket.customerSnapshot?.name,
        area: ticket.customerSnapshot?.area,
        technicianName,
        reason,
    });
};

const notifyAdminsScheduledStartedEarly = (ticket, technicianName) => {
    emitToRoom(adminRoom(), "ticket:started-early", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        technicianName,
        customerName: ticket.customerSnapshot?.name,
        area: ticket.customerSnapshot?.area,
    });
};

const notifyAdminsTicketTaken = (ticketId, adminName) => {
    emitToRoom(adminRoom(), "ticket:taken", { ticketId: String(ticketId), by: adminName });
};

// Carries the polyline so the admin map can draw the same route the
// technician is following, without spending a second route call.
const notifyAdminsRideStarted = (ticket) => {
    emitToRoom(adminRoom(), "ticket:ride-started", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        technicianId: String(ticket.technician || ""),
        technicianName: ticket.technicianSnapshot?.name,
        customerName: ticket.customerSnapshot?.name,
        origin: ticket.ride?.origin || null,
        etaSeconds: ticket.ride?.etaSeconds ?? null,
        distanceMeters: ticket.ride?.distanceMeters ?? null,
        etaAt: ticket.ride?.etaAt || null,
        encodedPolyline: ticket.ride?.encodedPolyline || null,
        startedAt: ticket.ride?.startedAt || null,
    });
};

// The badge counts read from dashboard stats, so any status change that
// moves a ticket in or out of Pending has to tell the other panels to
// refetch. Without these, a cancel or a reschedule left stale numbers on
// every screen except the one that made the change.
const notifyAdminsTicketCancelled = (ticket, adminName, reason) => {
    emitToRoom(adminRoom(), "ticket:cancelled", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        customerName: ticket.customerSnapshot?.name,
        adminName,
        reason,
    });
};

const notifyAdminsTicketRescheduled = (ticket, adminName) => {
    emitToRoom(adminRoom(), "ticket:rescheduled", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        customerName: ticket.customerSnapshot?.name,
        technicianName: ticket.technicianSnapshot?.name,
        scheduledFor: ticket.scheduling?.scheduledFor,
        adminName,
    });
};

/**
 * The loudest thing the office gets, because a person is standing in someone's
 * house waiting for an answer. Everything else here can be dealt with when
 * somebody gets round to it; this one is costing a technician's time by the
 * minute.
 */
const notifyAdminsCustomerRefused = (ticket, technicianName, reason) => {
    emitToRoom(adminRoom(), "ticket:customer-refused", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        customerName: ticket.customerSnapshot?.name,
        customerPhone: ticket.customerSnapshot?.phone,
        technicianName,
        reason,
    });
};

/** The office's answer, back to the technician still standing there. */
const notifyTechnicianRefusalResolved = (ticket, decision, officeNote) => {
    if (!ticket.technician) return;
    emitToRoom(techRoom(ticket.technician), "refusal:resolved", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        decision,
        officeNote: officeNote || null,
    });
};

const notifyAdminsPaymentCollected = (ticket, technicianName) => {
    emitToRoom(adminRoom(), "payment:collected", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        invoiceNumber: ticket.billing?.invoiceNumber,
        totalPaise: ticket.billing?.totalPaise,
        method: ticket.payment?.method,
        technicianName,
    });
};

module.exports = {
    buildDirectionsUrl,
    buildPinUrl,
    notifyCustomer,
    notifyCustomerAssigned,
    notifyCustomerAccepted,
    sendCustomerOtp,
    ensureTrackingLink,
    notifyCustomerWorkStarted,
    notifyCustomerTechnicianEnRoute,
    notifyCustomerArrived,
    notifyCustomerCancelled,
    sendCustomerInvoice,
    resetConversation,
    notifyTechnicianAssigned,
    notifyTechnicianAssignedOnWhatsApp,
    notifyTechnicianQueued,
    notifyTechnicianUnassigned,
    notifyTechnicianPaymentReceived,
    notifyTechnicianCashVerified,
    notifyTechnicianPaidOnWhatsApp,
    notifyTechnicianBlocked,
    notifyAdminsNewTicket,
    notifyAdminsTicketRejected,
    notifyAdminsTechnicianPaused,
    notifyTechnicianPaused,
    notifyAdminsScheduledStartedEarly,
    notifyAdminsRideStarted,
    notifyAdminsTicketTaken,
    notifyAdminsTicketCancelled,
    notifyAdminsTicketRescheduled,
    notifyAdminsPaymentCollected,
    notifyAdminsCustomerRefused,
    notifyTechnicianRefusalResolved,
};
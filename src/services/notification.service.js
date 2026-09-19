const whatsapp = require("./whatsapp.service");
const ticketModel = require("../models/ticket.model");
const { issueToken } = require("./track.service");
const Conversation = require("../models/conversation.model");
const { emitToRoom, userRoom, techRoom, adminRoom, roomSize } = require("../sockets/socket.instance");
const push = require("./push.service");

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
 * Issued here rather than at assignment because this is the moment the
 * customer is told about the job at all - a link that exists before anyone
 * has been sent one is a secret with no owner. Re-assigning does not mint a
 * new one, so a customer who scrolled back to the first message still has a
 * link that works.
 */
/**
 * Where to watch the technician, now that it is not a link.
 *
 * The public tracking page still exists and the token is still minted - the
 * app's own tracking screen is built on it. What stopped is sending the URL
 * over WhatsApp. Opening it there loads a whole web page inside WhatsApp's own
 * browser, on a phone that already has the app installed, and it was slower
 * and worse than the screen the customer could have been looking at instead.
 *
 * The download link only appears once there is one. Until the Play listing
 * exists, APP_DOWNLOAD_URL is empty and a sentence is better than a broken
 * link.
 */
const trackInApp = () => {
    const url = String(process.env.APP_DOWNLOAD_URL || "").trim();

    return url
        ? "Track them live in the Cosmosgen app:\n" + url
        : "Track them live in the Cosmosgen app.";
};

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

const notifyCustomerAssigned = async (ticket) => {
    const tech = ticket.technicianSnapshot || {};
    /*
     * Called for the token, not for the URL.
     *
     * This is what mints the tracking token, and the app's own tracking screen
     * is built on it - dropping the call because the link is no longer sent
     * would leave the customer with an app screen that has nothing to open.
     */
    await ensureTrackingLink(ticket);

    const text =
        "Your technician has been assigned.\n\n" +
        "Ticket: " + ticket.ticketNumber + "\n" +
        "Service: " + ticket.serviceLabel + "\n\n" +
        "Technician: " + tech.name + "\n" +
        "Phone: " + tech.phone + "\n" +
        "Rating: " + (tech.rating ? Number(tech.rating).toFixed(1) : "5.0") + "\n\n" +
        trackInApp() + "\n\n" +
        "They will reach your address soon. Feel free to call them directly " +
        "if you need anything.";

    await notifyCustomer({ ticket, text });
};

/**
 * The technician has accepted, so now the customer hears about him.
 *
 * This used to fire the moment the office assigned somebody, which meant a
 * technician who turned the job down had already been introduced by name and
 * phone number - and the next one was introduced the same way a few minutes
 * later. Nothing goes out until somebody has agreed to come.
 *
 * Two wordings, because a technician can accept a job he cannot start yet. A
 * queued job is a promise; telling the customer to expect somebody at the door
 * would be a lie, so it says what is actually true and leaves the arrival to
 * the "on the way" message that follows when he sets off.
 */
const notifyCustomerAccepted = async (ticket) => {
    const tech = ticket.technicianSnapshot || {};

    /*
     * The same moment, on the phone as well.
     *
     * Until somebody accepts, the customer's app shows a map with an arc on it
     * and no name - so being told who is coming is real news, and it is the
     * news they have been waiting on since they booked. WhatsApp carries it
     * either way; this is what reaches the person who booked in the app and
     * then put it down.
     */
    push.sendToCustomer(ticket.customer, {
        title: "Your technician has been assigned",
        body: (tech.name || "A technician") + " is coming for " + (ticket.serviceLabel || "your job") + ".",
        data: { ticketId: String(ticket._id), kind: "accepted" },
    });

    if (ticket.status !== "Queued") return notifyCustomerAssigned(ticket);

    await notifyCustomer({
        ticket,
        text:
            "Your request " + ticket.ticketNumber + " has been assigned to " + tech.name + ".\n\n" +
            "They're finishing another job right now and will reach you soon. " +
            "We'll message you as soon as they're on the way.",
    });
};

/**
 * The code the technician has to be told before he can start, or close.
 *
 * Sent to the customer, never to the technician - the whole point is that he
 * has to be standing in front of them to learn it.
 */
const sendCustomerOtp = async (ticket, code, purpose) => {
    const text =
        purpose === "close"
            ? "*" + code + "* is your code to confirm the work is finished.\n\n" +
              "Ticket: " + ticket.ticketNumber + "\n\n" +
              "Share it with the technician only once you are happy the job is done."
            : "*" + code + "* is your code to let the technician start.\n\n" +
              "Ticket: " + ticket.ticketNumber + "\n\n" +
              "Share it with them when they are at your door.";

    await notifyCustomer({ ticket, text });
};

const notifyCustomerWorkStarted = async (ticket) => {
    const tech = ticket.technicianSnapshot || {};
    const text =
        (tech.name || "Your technician") + " has arrived and started work.\n\n" +
        "Ticket: " + ticket.ticketNumber + "\n" +
        "Service: " + ticket.serviceLabel + "\n\n" +
        "You'll get the invoice here once the work is done.";

    await notifyCustomer({ ticket, text });
};

/**
 * Technician has left for the job.
 *
 * No estimated arrival time any more. A printed estimate is a promise that
 * goes stale the moment traffic does - the customer holds you to a number that
 * was true when the vendor set off, and the correction never comes. The
 * tracking link replaces it: it shows where the vendor actually is, and keeps
 * being right without anybody having to send anything.
 */
const notifyCustomerTechnicianEnRoute = async (ticket) => {
    const tech = ticket.technicianSnapshot || {};
    /*
     * Called for the token, not for the URL.
     *
     * This is what mints the tracking token, and the app's own tracking screen
     * is built on it - dropping the call because the link is no longer sent
     * would leave the customer with an app screen that has nothing to open.
     */
    await ensureTrackingLink(ticket);

    let text =
        (tech.name || "Your technician") + " is on the way to you.\n\n" +
        "Ticket: " + ticket.ticketNumber + "\n" +
        "Service: " + ticket.serviceLabel + "\n";

    text += "\n" + trackInApp() + "\n";

    text += "\nReply here if you need to reach us.";

    await notifyCustomer({ ticket, text });
};

/**
 * They are at the door.
 *
 * Two ways, because they answer different situations. WhatsApp always goes -
 * it is the one channel every customer has and the one that survives the app
 * being uninstalled. The push is what reaches somebody who has the app and is
 * not looking at it, which is precisely the person waiting for this.
 */
const notifyCustomerArrived = async (ticket) => {
    const who = ticket.technicianSnapshot?.name || "Your technician";

    await notifyCustomer({
        ticket,
        text: who + " has arrived at your location.\n\nReply here if you need to reach us.",
    });

    push.sendToCustomer(ticket.customer, {
        title: who + " has arrived",
        body: "They are at your address for " + (ticket.serviceLabel || "your job") + ".",
        data: { ticketId: String(ticket._id), kind: "arrived" },
    });
};

const notifyCustomerCancelled = async (ticket) => {
    const text =
        "Your service request has been cancelled.\n\n" +
        "Ticket: " + ticket.ticketNumber + "\n" +
        "Reason: " + (ticket.cancelReason || "Not specified") + "\n\n" +
        "Send us a message anytime if you'd like to book again.";

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
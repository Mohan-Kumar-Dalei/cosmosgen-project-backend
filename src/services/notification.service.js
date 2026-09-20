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
 *
 * `alsoWhatsApp` is how a message opts out of the second half of that.
 *
 * Mohan's rule is that WhatsApp carries one thing and one thing only: the code
 * the customer has to read out to the technician. Everything else the customer
 * used to be told there - the job was cancelled, the payment went through,
 * here is your invoice - is a notification on their phone now, and the
 * assistant answers for it when they ask. It knows all of it: the amount, the
 * invoice number, what was repaired and where the copy lives.
 *
 * The reason is money. From October 2026 Meta bills for these, and every one
 * of them said something the app was already showing. The socket event stays
 * either way, because that is the message appearing in the chat the customer
 * is looking at, and it costs nothing.
 */
const notifyCustomer = async ({ ticket, text, alsoWhatsApp = true }) => {
    emitToRoom(userRoom(ticket.customer), "ai-response", {
        content: text,
        sender: "system",
        chat: ticket.ticketNumber,
    });

    if (!alsoWhatsApp) return;

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
 * The customer's own screens, told that one of their jobs has moved.
 *
 * Their job list used to reload whenever a message arrived, which worked
 * because every step of a job sent one. Cutting those messages - the right
 * call, they said nothing the app was not already showing and Meta bills for
 * each - quietly took the reloads with them, so a card could sit reading "On
 * the way" while the map behind it showed him at the door. Mohan found it at
 * once: the card only caught up when he pulled to refresh.
 *
 * So the moment itself is sent instead of a message about it. It carries no
 * detail on purpose: the screens re-read the job, which is one request and
 * always the whole truth, rather than trying to patch themselves from an event.
 */
const jobMoved = (ticket) => {
    if (!ticket?.customer) return;

    emitToRoom(userRoom(ticket.customer), "job:changed", {
        id: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        status: ticket.status,
    });
};

/**
 * Gives a ticket its tracking token, once.
 *
 * Issued the first time the customer is told about the job at all, and
 * re-assigning does not mint a new one.
 *
 * It used to build a URL and hand that back, from when the customer was sent a
 * web page to watch. Nobody is sent one now: every customer who can reach the
 * assistant has the app - registration happens there and nowhere else - and
 * the app's own tracking screen is built on this token. So the token is the
 * whole of the answer, and dressing it up as a link was a leftover of a
 * delivery nobody uses.
 */
const ensureTrackingToken = async (ticket) => {
    if (ticket.tracking?.token) return ticket.tracking.token;

    const token = issueToken();

    await ticketModel.updateOne(
        { _id: ticket._id, "tracking.token": { $in: [null, ""] } },
        { $set: { "tracking.token": token, "tracking.issuedAt": new Date() } }
    );

    // Another assignment in the same instant may have won the write, so read
    // back rather than trusting the token we generated
    const saved = await ticketModel.findById(ticket._id).select("tracking.token").lean();
    return saved?.tracking?.token || token;
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
    jobMoved(ticket);

    const tech = ticket.technicianSnapshot || {};

    /*
     * The token first, either way.
     *
     * It is minted here rather than used here: the app's own tracking screen
     * is built on it, so skipping this would leave a customer with a screen
     * that has nothing to open.
     */
    await ensureTrackingToken(ticket);

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
    jobMoved(ticket);

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
    jobMoved(ticket);

    const tech = ticket.technicianSnapshot || {};

    await ensureTrackingToken(ticket);

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
    jobMoved(ticket);

    const who = ticket.technicianSnapshot?.name || "Your technician";

    push.sendToCustomer(ticket.customer, {
        title: who + " has arrived",
        body: "They are at your address for " + (ticket.serviceLabel || "your job") + ".",
        data: { ticketId: String(ticket._id), kind: "arrived" },
    });
};

/**
 * The job is off.
 *
 * A notification rather than a WhatsApp message, like the rest of the job's
 * steps - but this one carries the reason in its body rather than only a
 * heading, because "cancelled" without a why is the message that makes
 * somebody ring up angry. The office always records a reason; it is on the
 * ticket, it is in the chat, and the assistant will repeat it with the ticket
 * number if they ask.
 */
const notifyCustomerCancelled = async (ticket) => {
    jobMoved(ticket);

    const t = await speaks(ticket);

    const text = t.ticketCancelled(
        ticket.ticketNumber,
        ticket.cancelReason || "Not specified"
    );

    await notifyCustomer({ ticket, text, alsoWhatsApp: false });

    push.sendToCustomer(ticket.customer, {
        title: (ticket.serviceLabel || "Your job") + " has been cancelled",
        body: ticket.cancelReason
            ? ticket.ticketNumber + " - " + ticket.cancelReason
            : ticket.ticketNumber + " has been cancelled. Open it to see why.",
        data: { ticketId: String(ticket._id), kind: "cancelled" },
    });
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
 * The job has been moved to another day.
 *
 * The chat carries the full sentence - the new date, the slot, who is coming
 * and their number - because that is what somebody re-reads later. The
 * notification carries the date alone, which is the thing they need to know
 * from a lock screen.
 */
const notifyCustomerRescheduled = (ticket, whenText) => {
    push.sendToCustomer(ticket.customer, {
        title: (ticket.serviceLabel || "Your job") + " moved to " + whenText,
        body: ticket.ticketNumber + " - open it to see who is coming.",
        data: { ticketId: String(ticket._id), kind: "rescheduled" },
    });
};

/**
 * The money is in and the job is finished.
 *
 * The amount goes in the title rather than the body, because that is the one
 * thing somebody checks from the lock screen without opening anything. What it
 * was for goes underneath.
 */
const notifyCustomerPaid = (ticket, totalRupees) => {
    jobMoved(ticket);

    push.sendToCustomer(ticket.customer, {
        title: "Payment received - Rs " + totalRupees,
        body: (ticket.serviceLabel || "Your job") + " is complete. "
            + (ticket.billing?.invoiceNumber
                ? "Invoice " + ticket.billing.invoiceNumber + "."
                : "Your invoice is on its way."),
        data: { ticketId: String(ticket._id), kind: "paid" },
    });
};

/**
 * The invoice is ready, once it has somewhere to live.
 *
 * The PDF itself used to be pushed at them on WhatsApp the moment it existed,
 * which is a document nobody asked for landing in a chat - and a billed
 * message, from October 2026, for a file most people open once a year when a
 * landlord wants it. So the file is not sent any more; they are told it exists
 * and where to find it.
 *
 * Nothing is lost by that. `publishInvoice` has already written the URL onto
 * the ticket, which is what both apps offer as "Download invoice", and the
 * assistant carries the same link - so "bhej do bill" is answered in the chat,
 * by somebody who was asked.
 */
const sendCustomerInvoice = async (ticket, url) => {
    if (!url) return;

    const number = ticket.billing?.invoiceNumber || ticket.ticketNumber;

    push.sendToCustomer(ticket.customer, {
        title: "Your invoice is ready",
        body: number + " for " + (ticket.serviceLabel || "your job") + ".",
        data: { ticketId: String(ticket._id), kind: "invoice" },
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
            : " - NO device listening (app closed or vendor off duty), so the push is the only thing that can reach them")
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
     * It is now the only thing. The same job used to go to the vendor's
     * WhatsApp as well, with the customer's name, number and a directions
     * link in it - three channels carrying one job, and the WhatsApp copy was
     * the least likely of them to arrive: it was a message we started, so
     * outside the vendor's twenty-four hour window Meta accepted it and
     * delivered nothing. Everything it held is on the job screen this push
     * opens.
     *
     * So the body carries the ticket number now. It used to be a hint before
     * a fuller message; standing alone it should say which job, for the
     * vendor glancing at a lock screen with two of them already in hand.
     *
     * Deliberately not awaited. Assigning a job must not get slower, or
     * fail, because a push server is having a bad minute.
     */
    push.sendToTechnician(ticket.technician, {
        title: "New job assigned",
        body: [ticket.ticketNumber, ticket.serviceLabel, ticket.customerSnapshot?.area]
            .filter(Boolean).join(" - ")
            || "A job has been given to you. Open it to see where.",
        data: { kind: "ticket:assigned", ticketId: String(ticket._id) },
    });
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
    jobMoved,
    // Exported so the controllers that write their own customer messages can
    // write them in the right language too - see speaks().
    speaks,
    buildDirectionsUrl,
    buildPinUrl,
    notifyCustomer,
    notifyCustomerAssigned,
    notifyCustomerAccepted,
    sendCustomerOtp,
    ensureTrackingToken,
    notifyCustomerWorkStarted,
    notifyCustomerTechnicianEnRoute,
    notifyCustomerArrived,
    notifyCustomerCancelled,
    notifyCustomerRescheduled,
    notifyCustomerPaid,
    sendCustomerInvoice,
    resetConversation,
    notifyTechnicianAssigned,
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
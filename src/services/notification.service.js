const routeService = require("./route.service");
const whatsapp = require("./whatsapp.service");
const Conversation = require("../models/conversation.model");
const { emitToRoom, userRoom, techRoom, adminRoom } = require("../sockets/socket.instance");

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

const notifyCustomerAssigned = async (ticket) => {
    const tech = ticket.technicianSnapshot || {};
    const text =
        "Your technician has been assigned.\n\n" +
        "Ticket: " + ticket.ticketNumber + "\n" +
        "Service: " + ticket.serviceLabel + "\n\n" +
        "Technician: " + tech.name + "\n" +
        "Phone: " + tech.phone + "\n" +
        "Rating: " + (tech.rating ? Number(tech.rating).toFixed(1) : "5.0") + "\n\n" +
        "They will reach your address soon. Feel free to call them directly " +
        "if you need anything.";

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
 * Technician has left for the job. The ETA here is read off the ticket, not
 * recomputed - startRide already paid for that route call.
 */
const notifyCustomerTechnicianEnRoute = async (ticket) => {
    const tech = ticket.technicianSnapshot || {};
    const eta = routeService.formatEta(ticket.ride?.etaSeconds);

    let text =
        (tech.name || "Your technician") + " is on the way to you.\n\n" +
        "Ticket: " + ticket.ticketNumber + "\n" +
        "Service: " + ticket.serviceLabel + "\n";

    // No ETA line at all when the route call failed. A vague "soon" reads as
    // evasive, and a wrong number is worse than none.
    if (eta) {
        text += "Estimated arrival: " + eta + "\n";
    }

    text += "\nReply here if you need to reach us.";

    await notifyCustomer({ ticket, text });
};

const notifyCustomerArrived = async (ticket) => { const text = (ticket.technicianSnapshot?.name || "Your technician") + " has arrived at your location.\n\nReply here if you need to reach us."; await notifyCustomer({ ticket, text }); };

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

/* ---------- TECHNICIAN ---------- */

const notifyTechnicianAssigned = (ticket) => {
    if (!ticket.technician) return;

    const lat = ticket.customerSnapshot?.lat;
    const lon = ticket.customerSnapshot?.lon;

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

/* ---------- ADMINS ---------- */

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
    notifyCustomerWorkStarted,
    notifyCustomerTechnicianEnRoute,
    notifyCustomerArrived,
    notifyCustomerCancelled,
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
    notifyAdminsScheduledStartedEarly,
    notifyAdminsRideStarted,
    notifyAdminsTicketTaken,
    notifyAdminsTicketCancelled,
    notifyAdminsTicketRescheduled,
    notifyAdminsPaymentCollected,
    notifyAdminsCustomerRefused,
    notifyTechnicianRefusalResolved,
};
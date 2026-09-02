const crypto = require("crypto");
const ticketModel = require("../models/ticket.model");
const technicianModel = require("../models/technician.model");
const Payment = require("../models/payment.model");
const notification = require("../services/notification.service");
const { paiseToRupees } = require("../services/payment.service");
const { promoteQueuedTicket } = require("../services/dispatch.service");
const walletService = require("../services/wallet.service");

/**
 * POST /api/webhook/razorpay
 *
 * req.body must be a RAW BUFFER here, not parsed JSON - the signature is
 * calculated over the raw bytes. See the mounting order in app.js: this
 * route is registered BEFORE express.json().
 */
const razorpayWebhook = async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!secret) {
        console.error("RAZORPAY_WEBHOOK_SECRET missing");
        return res.status(500).json({ success: false });
    }

    const rawBody = req.body;

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    if (!signature || expected !== signature) {
        console.error("Razorpay webhook signature mismatch");
        return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    let event;
    try {
        event = JSON.parse(rawBody.toString("utf8"));
    } catch {
        return res.status(400).json({ success: false, message: "Invalid JSON" });
    }

    // Respond immediately - Razorpay retries anything slower than 5 seconds
    res.status(200).json({ success: true });

    try {
        await handleRazorpayEvent(event);
    } catch (err) {
        console.error("Razorpay event processing failed:", err.message);
    }
};

const handleRazorpayEvent = async (event) => {
    const eventType = event.event;
    const eventId = event.id || `${eventType}-${event.created_at}`;

    console.log("Razorpay webhook:", eventType);

    if (eventType !== "payment_link.paid" && eventType !== "payment.captured") {
        return;
    }

    const link = event.payload?.payment_link?.entity;
    const payment = event.payload?.payment?.entity;

    const notes = link?.notes || payment?.notes || {};
    const ticketId = notes.ticketId;
    const linkId = link?.id;
    const paymentId = payment?.id;
    const method = payment?.method;

    // A wallet recharge has no ticket - it settles commission the technician
    // already owed. Handling it before the ticket lookup keeps the two flows
    // from tripping over each other.
    if (notes.type === "wallet_recharge" && notes.technicianId) {
        const alreadyDone = await Payment.exists({ processedEventIds: eventId });
        if (alreadyDone) {
            console.log("Recharge event already processed:", eventId);
            return;
        }

        const amountPaise = Number(payment?.amount) || Number(link?.amount) || 0;

        try {
            await walletService.recordRecharge(notes.technicianId, amountPaise, paymentId || linkId);

            // A Payment row purely to hold the event id, so a retry of the
            // same webhook can't credit the wallet twice
            await Payment.create({
                ticket: null,
                amountPaise,
                method: "online",
                status: "verified",
                collectedBy: notes.technicianId,
                collectedAt: new Date(),
                razorpayPaymentId: paymentId,
                razorpayLinkId: linkId,
                note: "Technician commission settlement",
                processedEventIds: [eventId],
            });

            console.log("Wallet recharge credited:", notes.technicianId, amountPaise);
        } catch (err) {
            console.error("Wallet recharge failed:", err.message);
        }
        return;
    }

    if (!ticketId) {
        console.warn("Webhook has no ticketId in notes, skipping");
        return;
    }

    // Razorpay reports its cut in paise on the payment entity. Capturing it
    // here is the only chance - it isn't queryable later without another API
    // call per payment.
    const feePaise = Number(payment?.fee) || 0;
    const taxPaise = Number(payment?.tax) || 0;

    // Idempotency - the $ne filter makes this atomic, so two parallel
    // deliveries of the same event can't both process
    const paymentRecord = await Payment.findOneAndUpdate(
        { ticket: ticketId, processedEventIds: { $ne: eventId } },
        {
            status: "collected",
            razorpayPaymentId: paymentId,
            method: method || "online",
            collectedAt: new Date(),
            gatewayFeePaise: feePaise,
            gatewayTaxPaise: taxPaise,
            $push: { processedEventIds: eventId },
        },
        { returnDocument: "after" }
    );

    if (!paymentRecord) {
        console.log("Event already processed or payment record missing:", eventId);
        return;
    }

    const ticket = await ticketModel.findOneAndUpdate(
        { _id: ticketId, status: "Payment-Pending" },
        {
            status: "Closed",
            "payment.status": "Paid",
            "payment.method": method || "online",
            "payment.razorpayPaymentId": paymentId,
            "payment.razorpayLinkId": linkId,
            "payment.gatewayFeePaise": feePaise + taxPaise,
            "payment.paidAt": new Date(),
            $push: {
                statusHistory: {
                    from: "Payment-Pending",
                    to: "Closed",
                    actorRole: "system",
                    reason: "Payment confirmed by Razorpay webhook",
                    at: new Date(),
                },
            },
        },
        { returnDocument: "after" }
    ).lean();

    if (!ticket) {
        console.warn("Ticket not in Payment-Pending state:", ticketId);
        return;
    }

    if (ticket.technician) {
        // Use the rate frozen on the invoice, not the technician's current
        // rate - the customer was billed against that split
        const commissionPercent = ticket.billing?.commissionPercent ?? 20;

        try {
            await walletService.addEarningsForOnlineJob(
                ticket.technician,
                ticket._id,
                ticket.ticketNumber,
                ticket.billing?.totalPaise || 0,
                commissionPercent
            );
        } catch (walletErr) {
            console.error("Wallet credit failed for", ticket.ticketNumber, walletErr.message);
        }

        const tech = await technicianModel.findByIdAndUpdate(
            ticket.technician,
            { $inc: { completedJobs: 1 } },
            { returnDocument: "after" }
        ).select("completedJobs rating performanceLevel").lean();

        if (tech) {
            let level = "STARTER";
            if (tech.completedJobs >= 20 && tech.rating >= 4.5) level = "EXPERT";
            else if (tech.completedJobs >= 5 && tech.rating >= 4.0) level = "PRO";

            if (level !== tech.performanceLevel) {
                await technicianModel.updateOne({ _id: ticket.technician }, { performanceLevel: level });
            }
        }

        // Pulls in the next queued ticket, or frees them up if nothing's waiting
        await promoteQueuedTicket(ticket.technician);
    }

    await notification.notifyCustomer({
        ticket,
        text:
            "Payment received - Rs " + paiseToRupees(ticket.billing?.totalPaise || 0) + "\n" +
            "Invoice: " + ticket.billing?.invoiceNumber + "\n\n" +
            "Thank you for choosing Cosmosgen. Ticket " + ticket.ticketNumber + " is now closed.",
    });

    notification.notifyTechnicianPaymentReceived(ticket);
    notification.notifyAdminsPaymentCollected(ticket, ticket.technicianSnapshot?.name || "Technician");
};

module.exports = { razorpayWebhook };
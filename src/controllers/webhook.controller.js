const crypto = require("crypto");
const ticketModel = require("../models/ticket.model");
const technicianModel = require("../models/technician.model");
const Payment = require("../models/payment.model");
const notification = require("../services/notification.service");
const { paiseToRupees } = require("../services/payment.service");
const { promoteQueuedTicket } = require("../services/dispatch.service");
const walletService = require("../services/wallet.service");
const { emitToRoom, techRoom, adminRoom } = require("../sockets/socket.instance");

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
        const amountPaise = Number(payment?.amount) || Number(link?.amount) || 0;

        // Razorpay sends TWO events for one payment-link payment -
        // payment.captured and payment_link.paid - each with its own event id.
        // Keying on the event id let both through, so a single settlement was
        // credited twice and left the technician holding a balance the company
        // then paid out. The payment id is the same on both, so claim on that.
        //
        // The claim is one atomic upsert: whichever event arrives first
        // inserts the row and credits the wallet, and the other one finds the
        // row already there and stops. Crediting first and recording after
        // leaves exactly the window this bug fell through.
        const claimKey = paymentId || linkId;

        if (!claimKey) {
            console.warn("Recharge webhook carries no payment or link id, skipping");
            return;
        }

        let existing;
        try {
            existing = await Payment.findOneAndUpdate(
                { ticket: null, razorpayPaymentId: claimKey },
                {
                    $setOnInsert: {
                        ticket: null,
                        amountPaise,
                        method: "online",
                        // Not verified. The office checks the reference
                        // against Razorpay and then records it against the
                        // right ticket in the wallet - that is what clears
                        // the due. Marking it verified here skipped both
                        // steps, so the settlement never appeared in the
                        // queue and nobody ever looked at it.
                        status: "collected",
                        collectedBy: notes.technicianId,
                        collectedAt: new Date(),
                        razorpayPaymentId: claimKey,
                        razorpayLinkId: linkId,
                        note: "Technician commission settlement",
                    },
                    $addToSet: { processedEventIds: eventId },
                },
                { upsert: true, returnDocument: "before" }
            );
        } catch (err) {
            // The unique index rejected a genuinely simultaneous delivery
            if (err.code === 11000) {
                console.log("Recharge already claimed by the other event:", claimKey);
                return;
            }
            throw err;
        }

        if (existing) {
            console.log("Settlement already recorded for", claimKey, "- ignoring", eventType);
            return;
        }

        // The wallet is NOT credited here. The office verifies the reference
        // and records it against the ticket, and that is the step that clears
        // the due - crediting it now would leave nothing for them to record
        // and no record of which job the money was for.
        //
        // Both ends are told instead: the office so it lands in the queue,
        // and the technician so he can see it arrived and does not pay twice
        // while waiting for someone to confirm it.
        // The row that only recorded "a link was sent to him" has served its
        // purpose now that the real payment is here.
        if (linkId) {
            await Payment.deleteOne({ ticket: null, razorpayLinkId: linkId, status: "pending" });
        }

        const payer = await technicianModel
            .findById(notes.technicianId)
            .select("name")
            .lean();

        emitToRoom(adminRoom(), "payment:collected", {
            technicianName: payer?.name || "A technician",
            invoiceNumber: "commission settlement",
            amountDisplay: paiseToRupees(amountPaise),
        });

        emitToRoom(techRoom(notes.technicianId), "settlement:received", {
            amountPaise,
            amountDisplay: paiseToRupees(amountPaise),
            reference: claimKey,
        });

        console.log("Commission settlement received, awaiting office check:", claimKey);
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

    // A split bill is only half settled by this webhook. The customer has
    // paid the company's commission; the technician still has to confirm he
    // took his own share in cash. Closing the ticket here would let him walk
    // away without recording it, and would credit him a share the company
    // never held.
    if (notes.type === "split_commission") {
        const splitTicket = await ticketModel.findOneAndUpdate(
            {
                _id: ticketId,
                status: "Payment-Pending",
                "payment.method": "split",
                "payment.split.onlinePaidAt": null,
            },
            {
                "payment.split.onlinePaidAt": new Date(),
                "payment.razorpayPaymentId": paymentId,
                $push: {
                    statusHistory: {
                        from: "Payment-Pending",
                        to: "Payment-Pending",
                        actorRole: "system",
                        reason: "Service charge paid online by the customer",
                        at: new Date(),
                    },
                },
            },
            { returnDocument: "after" }
        ).lean();

        if (!splitTicket) {
            console.log("Split commission already recorded, or ticket not waiting:", ticketId);
            return;
        }

        // The gateway fee lands on the commission, not on the whole bill -
        // which is the entire reason for taking a job this way.
        await Payment.updateOne(
            { ticket: ticketId },
            {
                razorpayPaymentId: paymentId,
                gatewayFeePaise: feePaise,
                gatewayTaxPaise: taxPaise,
                $addToSet: { processedEventIds: eventId },
            }
        );

        if (splitTicket.technician) {
            emitToRoom(techRoom(splitTicket.technician), "split:commission-paid", {
                ticketId: String(splitTicket._id),
                ticketNumber: splitTicket.ticketNumber,
            });
        }

        console.log("Split commission received for", splitTicket.ticketNumber);
        return;
    }

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
            "Payment received. Rs " + paiseToRupees(ticket.billing?.totalPaise || 0) + "\n" +
            "Invoice: " + ticket.billing?.invoiceNumber + "\n\n" +
            "Thank you for choosing Cosmosgen. Ticket " + ticket.ticketNumber + " is now closed.",
    });

    notification.notifyTechnicianPaymentReceived(ticket);
    notification.notifyAdminsPaymentCollected(ticket, ticket.technicianSnapshot?.name || "Technician");
};

module.exports = { razorpayWebhook };
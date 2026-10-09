const crypto = require("crypto");
const ticketModel = require("../models/ticket.model");
const technicianModel = require("../models/technician.model");
const Payment = require("../models/payment.model");
const notification = require("../services/notification.service");
const settingsService = require("../services/settings.service");
const { paiseToRupees } = require("../services/payment.service");
const { webhookIsGenuine, estimateGatewayFee } = require("../config/phonepe");
const { promoteQueuedTicket } = require("../services/dispatch.service");
const walletService = require("../services/wallet.service");
const { emitToRoom, techRoom, adminRoom } = require("../sockets/socket.instance");

/** The body, whether express handed it over raw or already parsed. */
const bodyOf = (req) => {
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
    if (typeof req.body === "string") return JSON.parse(req.body);
    return req.body || {};
};

/**
 * POST /api/webhook/phonepe
 *
 * PhonePe's word that a QR was paid. It signs nothing: the Authorization
 * header is SHA256 of the username and password set on the dashboard's
 * webhook, and that is the whole of the check (see webhookIsGenuine).
 *
 * Only pg.order.completed moves money here. A failed or lapsed order needs
 * nothing doing - the bill is still waiting, and the vendor asks for a new QR.
 */
const phonepeWebhook = async (req, res) => {
    /*
     * Anything that cannot prove it is PhonePe is acknowledged and ignored.
     *
     * Not refused with a 401: the dashboard checks the URL answers before it
     * will save a webhook ("Webhook validation failed" on anything but a 2xx),
     * and that check can arrive before the username and password are in this
     * server's .env. Answering 200 costs nothing - nothing below runs without
     * the hash matching - and if the pair ever disagrees for real, the
     * reconciler still finds every paid order by asking PhonePe directly
     * (reconcile.service.js), so no payment is lost to a wrong password.
     */
    if (!webhookIsGenuine(req.headers.authorization)) {
        console.warn("PhonePe webhook: Authorization does not match PHONEPE_WEBHOOK_USERNAME/PASSWORD - acknowledged, not processed");
        return res.status(200).json({ success: true, processed: false });
    }

    let body;
    try {
        body = bodyOf(req);
    } catch {
        return res.status(400).json({ success: false, message: "Invalid JSON" });
    }

    // Answer at once; the work below can take longer than PhonePe waits.
    res.status(200).json({ success: true });

    try {
        await handlePhonePeEvent(body);
    } catch (err) {
        console.error("PhonePe event processing failed:", err.message);
    }
};

/**
 * One PhonePe order event, turned into the payment it stands for.
 *
 * PhonePe's guidance is to go by `event` and `payload.state` and nothing
 * else - `type` is not to be relied on - and to read the rest loosely.
 */
const handlePhonePeEvent = async (body) => {
    const event = body?.event;
    const order = body?.payload || {};

    console.log("PhonePe webhook:", event, order.merchantOrderId, order.state);

    if (event !== "pg.order.completed" || order.state !== "COMPLETED") return;

    const attempts = order.paymentDetails || [];
    const attempt = attempts.find((a) => a.state === "COMPLETED") || attempts[0] || {};
    const meta = order.metaInfo || {};
    const amountPaise = Number(order.amount) || 0;

    // PhonePe does not report its own cut on the order, so the company's cost
    // is the owner's rate - zero while the free offer runs.
    const { feePaise, taxPaise } = estimateGatewayFee(
        amountPaise,
        await settingsService.getSetting("GATEWAY_FEE_PERCENT"),
        await settingsService.getSetting("GATEWAY_FEE_GST_PERCENT"),
    );

    await settleGatewayPayment({
        // Keyed on the transaction, so the status check and the reconciler
        // replaying the same payment are recognised as the same payment.
        eventId: "pp-" + (attempt.transactionId || order.merchantOrderId),
        orderId: order.merchantOrderId,
        paymentId: attempt.transactionId || order.orderId,
        utr: attempt.rail?.utr || attempt.splitInstruments?.[0]?.rail?.utr || null,
        amountPaise,
        method: "upi",
        feePaise,
        taxPaise,
        notes: {
            type: meta.udf1 || "bill",
            ticketId: meta.udf2 || null,
            technicianId: meta.udf3 || null,
            invoiceNumber: meta.udf4 || null,
        },
        by: "PhonePe",
    });
};

/**
 * POST /api/webhook/razorpay - kept only for bills sent before the move.
 *
 * A Razorpay link already sitting in a customer's messages can still be paid
 * after the company stopped making new ones, and that money must still close
 * the job. With RAZORPAY_WEBHOOK_SECRET unset this route refuses everything,
 * which is the right state once the last old link has lapsed.
 *
 * req.body must be a RAW BUFFER here - the signature is over the raw bytes.
 */
const razorpayWebhook = async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!secret) return res.status(410).json({ success: false, message: "Razorpay is no longer in use" });

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

    res.status(200).json({ success: true });

    const type = event.event;
    if (type !== "payment_link.paid" && type !== "payment.captured") return;

    const link = event.payload?.payment_link?.entity;
    const payment = event.payload?.payment?.entity;

    try {
        await settleGatewayPayment({
            eventId: event.id || type + "-" + event.created_at,
            // Razorpay sends two events for one payment; the payment id is
            // the same on both, which is what the claims below key on.
            orderId: link?.id || null,
            paymentId: payment?.id,
            utr: payment?.acquirer_data?.rrn || null,
            amountPaise: Number(payment?.amount) || Number(link?.amount) || 0,
            method: payment?.method || "online",
            feePaise: Number(payment?.fee) || 0,
            taxPaise: Number(payment?.tax) || 0,
            notes: link?.notes || payment?.notes || {},
            by: "Razorpay",
            legacy: true,
        });
    } catch (err) {
        console.error("Razorpay event processing failed:", err.message);
    }
};

/**
 * Money the gateway says has landed, filed against what it was for.
 *
 * One path for every way we hear about it - PhonePe's webhook, the vendor's
 * "check now", the reconciler, an old Razorpay link - so the four of them
 * cannot come to disagree about money. Safe to run twice: every write below
 * is guarded on the state it moves away from.
 *
 * `paid`: { eventId, orderId, paymentId, utr, amountPaise, method, feePaise,
 * taxPaise, notes: { type, ticketId, technicianId, invoiceNumber }, by }
 */
const settleGatewayPayment = async (paid) => {
    const { eventId, orderId: linkId, paymentId, utr, method, feePaise = 0, taxPaise = 0, notes = {} } = paid;
    const ticketId = notes.ticketId;

    // A wallet recharge has no ticket - it settles commission the technician
    // already owed. Handling it before the ticket lookup keeps the two flows
    // from tripping over each other.
    if (notes.type === "wallet_recharge" && notes.technicianId) {
        const amountPaise = paid.amountPaise || 0;

        // The claim is one atomic upsert on the payment id: whichever report
        // arrives first inserts the row, and any other - a second webhook,
        // the vendor's own check, the reconciler - finds the row already
        // there and stops. Keying on the event id instead once let two
        // Razorpay events for one payment both through, and a single
        // settlement was credited twice.
        const claimKey = paymentId || linkId;

        if (!claimKey) {
            console.warn("Recharge report carries no payment or order id, skipping");
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
                        // against the gateway and then records it against the
                        // right ticket in the wallet - that is what clears the
                        // due. Marking it verified here skipped both steps.
                        status: "collected",
                        collectedBy: notes.technicianId,
                        collectedAt: new Date(),
                        razorpayPaymentId: claimKey,
                        razorpayLinkId: linkId,
                        utr: utr || undefined,
                        note: "Technician commission settlement",
                    },
                    $addToSet: { processedEventIds: eventId },
                },
                { upsert: true, returnDocument: "before" }
            );
        } catch (err) {
            // The unique index rejected a genuinely simultaneous delivery
            if (err.code === 11000) {
                console.log("Recharge already claimed:", claimKey);
                return;
            }
            throw err;
        }

        if (existing) {
            console.log("Settlement already recorded for", claimKey);
            return;
        }

        // The wallet is NOT credited here. The office verifies the reference
        // and records it against the ticket, and that is the step that clears
        // the due. Both ends are told instead: the office so it lands in the
        // queue, and the vendor so he can see it arrived and does not pay
        // twice while waiting for someone to confirm it.
        //
        // The row that only recorded "a QR was made for him" has served its
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
        console.warn("Payment report has no ticket on it, skipping");
        return;
    }

    /*
     * Paid on a QR the bill has since moved past.
     *
     * PhonePe cannot cancel an order, so a corrected bill leaves the old QR
     * payable until it lapses. Money paid on it is real, but it is the wrong
     * figure for this bill - closing the job on it would settle a corrected
     * bill with the amount it was corrected away from. The office is told
     * instead, with the ticket and the reference, to put right by hand.
     */
    if (!paid.legacy && linkId) {
        const current = await ticketModel.findById(ticketId)
            .select("ticketNumber payment.razorpayLinkId")
            .lean();

        if (current && current.payment?.razorpayLinkId && current.payment.razorpayLinkId !== linkId) {
            console.warn(
                "Paid on a superseded QR for", current.ticketNumber,
                "- order", linkId, "Rs", paiseToRupees(paid.amountPaise), "- left for the office"
            );
            emitToRoom(adminRoom(), "payment:stray", {
                ticketId: String(ticketId),
                ticketNumber: current.ticketNumber,
                reference: paymentId || linkId,
                amountDisplay: paiseToRupees(paid.amountPaise),
            });
            return;
        }
    }

    // A split bill is only half settled by this. The customer has paid the
    // company's commission; the vendor still has to confirm he took his own
    // share in cash. Closing the ticket here would let him walk away without
    // recording it, and would credit him a share the company never held.
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
                ...(utr ? { "payment.utr": utr } : {}),
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
                ...(utr ? { utr } : {}),
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
    // reports of the same payment can't both process
    const paymentRecord = await Payment.findOneAndUpdate(
        { ticket: ticketId, processedEventIds: { $ne: eventId } },
        {
            status: "collected",
            razorpayPaymentId: paymentId,
            ...(utr ? { utr } : {}),
            method: method || "online",
            collectedAt: new Date(),
            gatewayFeePaise: feePaise,
            gatewayTaxPaise: taxPaise,
            $push: { processedEventIds: eventId },
        },
        { returnDocument: "after" }
    );

    if (!paymentRecord) {
        console.log("Payment already processed or record missing:", eventId);
        return;
    }

    const ticket = await ticketModel.findOneAndUpdate(
        { _id: ticketId, status: "Payment-Pending" },
        {
            status: "Closed",
            "payment.status": "Collected",   // see the note on the enum in ticket.model.js
            "payment.method": method || "online",
            "payment.razorpayPaymentId": paymentId,
            ...(linkId ? { "payment.razorpayLinkId": linkId } : {}),
            ...(utr ? { "payment.utr": utr } : {}),
            "payment.gatewayFeePaise": feePaise + taxPaise,
            "payment.paidAt": new Date(),
            $push: {
                statusHistory: {
                    from: "Payment-Pending",
                    to: "Closed",
                    actorRole: "system",
                    reason: "Payment confirmed by " + (paid.by || "the gateway"),
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

    // Their own language, as with every other message - see speaks().
    const said = await notification.speaks(ticket);

    // The receipt goes to the chat and to the phone, not to WhatsApp - see
    // notifyCustomer.
    await notification.notifyCustomer({
        ticket,
        alsoWhatsApp: false,
        text: said.paymentDone(
            paiseToRupees(ticket.billing?.totalPaise || 0),
            ticket.billing?.invoiceNumber,
            ticket.ticketNumber,
            ""
        ),
    });

    notification.notifyCustomerPaid(ticket, paiseToRupees(ticket.billing?.totalPaise || 0));

    notification.notifyTechnicianPaymentReceived(ticket);
    notification.notifyAdminsPaymentCollected(ticket, ticket.technicianSnapshot?.name || "Technician");
};

/*
 * `handlePhonePeEvent` is exported for the reconciler, and
 * `settleGatewayPayment` for the vendor's own "check now" - both of which
 * have asked PhonePe themselves. Nothing else should call them: they trust
 * that whatever handed them a payment has already established it is genuine,
 * which the routes above do with the Authorization header or the signature.
 */
/**
 * GET /api/webhook/phonepe - "is this URL alive?", for the dashboard's check
 * and for anybody setting it up with a browser. Says nothing else.
 */
const phonepeWebhookAlive = (req, res) => res.status(200).json({ success: true });

module.exports = { phonepeWebhook, phonepeWebhookAlive, razorpayWebhook, handlePhonePeEvent, settleGatewayPayment };

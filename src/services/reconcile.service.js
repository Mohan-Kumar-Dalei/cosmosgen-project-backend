const Ticket = require("../models/ticket.model");
const Payment = require("../models/payment.model");
const settingsService = require("./settings.service");
const { isConfigured, estimateGatewayFee } = require("../config/phonepe");
const { fetchOrderStatus } = require("./payment.service");
const { settleGatewayPayment } = require("../controllers/webhook.controller");

/**
 * Asking the gateway about the payments we never heard about.
 *
 * Everything we know about a customer paying online arrives as a webhook, and
 * a webhook is one delivery over the internet to one server. It can be missed:
 * the server was restarting, the gateway was having an hour, the webhook's
 * password was wrong for a day. When it is missed the money is in the
 * company's account and the ticket still says Payment-Pending, so the customer
 * is shown an unpaid job, the assistant believes they still owe it, and the
 * engineer is never credited. Nothing in the system ever noticed, because
 * nothing ever asked.
 *
 * This asks. Every quarter of an hour it takes the jobs - and the vendors'
 * settlement QRs - still waiting on money, asks PhonePe about each order, and
 * for any PhonePe calls completed it files the payment through the same path
 * the webhook uses.
 *
 * The same path on purpose. One path closes a ticket, credits a vendor, counts
 * the gateway's fee and sends the receipt; a second path doing the same thing
 * slightly differently is how the two come to disagree about money. That path
 * is also safe to run twice - every write in it is guarded on the state it
 * moves away from.
 */

/** Far enough back to catch an outage nobody noticed over a weekend. */
const LOOK_BACK_DAYS = 7;

/** Enough that a bad hour at the gateway cannot queue up forever. */
const PER_RUN = 25;

/** A paid order, as the one settling path wants it. */
const settle = async (orderId, status, notes) => {
    const { feePaise, taxPaise } = estimateGatewayFee(
        status.amountPaidPaise,
        await settingsService.getSetting("GATEWAY_FEE_PERCENT"),
        await settingsService.getSetting("GATEWAY_FEE_GST_PERCENT"),
    );

    await settleGatewayPayment({
        // The same id the webhook would have used, so a late webhook after
        // this is recognised as the same payment.
        eventId: "pp-" + (status.paymentId || orderId),
        orderId,
        paymentId: status.paymentId || orderId,
        utr: status.utr,
        amountPaise: status.amountPaidPaise,
        method: "upi",
        feePaise,
        taxPaise,
        notes,
        by: "PhonePe (reconciled)",
    });
};

const reconcileOnlinePayments = async () => {
    if (!isConfigured()) return { checked: 0, settled: 0 };

    const since = new Date(Date.now() - LOOK_BACK_DAYS * 24 * 60 * 60 * 1000);

    const waiting = await Ticket.find({
        status: "Payment-Pending",
        // Our own PhonePe orders only - an old Razorpay link id is nothing
        // PhonePe can answer about.
        "payment.razorpayLinkId": { $regex: /^(BIL|SPL)-/ },
        updatedAt: { $gte: since },
    })
        .select("ticketNumber payment.razorpayLinkId payment.method billing.invoiceNumber")
        .limit(PER_RUN)
        .lean();

    const settlements = await Payment.find({
        ticket: null,
        status: "pending",
        razorpayLinkId: { $regex: /^STL-/ },
        createdAt: { $gte: since },
    })
        .select("razorpayLinkId collectedBy")
        .limit(PER_RUN)
        .lean();

    let settled = 0;

    for (const ticket of waiting) {
        const orderId = ticket.payment.razorpayLinkId;
        try {
            const status = await fetchOrderStatus(orderId);
            if (!status?.isPaid) continue;

            await settle(orderId, status, {
                type: ticket.payment.method === "split" ? "split_commission" : "bill",
                ticketId: String(ticket._id),
                invoiceNumber: ticket.billing?.invoiceNumber,
            });

            settled += 1;
            console.log("[RECONCILE] settled a payment nobody told us about:", ticket.ticketNumber);
        } catch (error) {
            // One ticket that cannot be checked is one ticket; the rest of the
            // run carries on, and the next run tries this one again.
            console.error("[RECONCILE] could not check " + ticket.ticketNumber + ":", error.message);
        }
    }

    for (const row of settlements) {
        try {
            const status = await fetchOrderStatus(row.razorpayLinkId);

            // A QR that lapsed unpaid is nothing for the office to look
            // into, and would otherwise be asked about every run for a week.
            if (status?.status === "failed") {
                await Payment.deleteOne({ _id: row._id, status: "pending" });
                continue;
            }
            if (!status?.isPaid) continue;

            await settle(row.razorpayLinkId, status, {
                type: "wallet_recharge",
                technicianId: String(row.collectedBy),
            });

            settled += 1;
            console.log("[RECONCILE] filed a vendor settlement nobody told us about:", row.razorpayLinkId);
        } catch (error) {
            console.error("[RECONCILE] could not check " + row.razorpayLinkId + ":", error.message);
        }
    }

    const checked = waiting.length + settlements.length;
    if (settled) console.log("[RECONCILE] " + settled + " of " + checked + " were already paid");

    return { checked, settled };
};

module.exports = { reconcileOnlinePayments };

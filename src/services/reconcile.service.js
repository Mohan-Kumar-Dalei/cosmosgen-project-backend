const Ticket = require("../models/ticket.model");
const { getRazorpay, isConfigured } = require("../config/razorpay");
const { handleRazorpayEvent } = require("../controllers/webhook.controller");

/**
 * Asking the gateway about the payments we never heard about.
 *
 * Everything we know about a customer paying online arrives as a webhook, and
 * a webhook is one delivery over the internet to one server. It can be missed:
 * the server was restarting, Razorpay was having an hour, the signing secret
 * was wrong for a day - which it was. When it is missed the money is in the
 * company's account and the ticket still says Payment-Pending, so the customer
 * is shown an unpaid job, the assistant believes they still owe it, and the
 * engineer is never credited. Nothing in the system ever noticed, because
 * nothing ever asked.
 *
 * This asks. Every quarter of an hour it takes the jobs that are still waiting
 * on money, fetches each one's payment link from Razorpay, and for any the
 * gateway calls paid it replays the event the webhook would have handled.
 *
 * Replaying rather than settling it here on purpose. One path closes a ticket,
 * credits a vendor, counts the gateway's fee and sends the receipt; a second
 * path doing the same thing slightly differently is how the two come to
 * disagree about money. The handler is also already safe to run twice - the
 * ticket update is guarded on Payment-Pending, so a job that has been settled
 * since falls out before anybody is credited for it.
 */

/** Far enough back to catch an outage nobody noticed over a weekend. */
const LOOK_BACK_DAYS = 7;

/** Enough that a bad hour at the gateway cannot queue up forever. */
const PER_RUN = 25;

const reconcileOnlinePayments = async () => {
    if (!isConfigured()) return { checked: 0, settled: 0 };

    const since = new Date(Date.now() - LOOK_BACK_DAYS * 24 * 60 * 60 * 1000);

    const waiting = await Ticket.find({
        status: "Payment-Pending",
        "payment.razorpayLinkId": { $nin: [null, ""] },
        updatedAt: { $gte: since },
    })
        .select("ticketNumber payment.razorpayLinkId")
        .limit(PER_RUN)
        .lean();

    if (!waiting.length) return { checked: 0, settled: 0 };

    let settled = 0;

    for (const ticket of waiting) {
        try {
            const link = await getRazorpay().paymentLink.fetch(ticket.payment.razorpayLinkId);

            if (link?.status !== "paid") continue;

            /*
             * The capture itself, which carries the fee and the method.
             *
             * A link can hold more than one attempt and only one of them is
             * the one that worked. Without it the handler would still close
             * the ticket, but the gateway's cut would be recorded as zero and
             * the company's margin would read high from then on.
             */
            const captured = (link.payments || []).find((p) => p.status === "captured");

            await handleRazorpayEvent({
                event: "payment_link.paid",

                /*
                 * Keyed on the payment, not on the moment this ran.
                 *
                 * The handler skips an event id it has already seen. A fresh
                 * id every quarter of an hour would defeat that and have this
                 * rewriting the same payment record all week.
                 */
                id: "reconcile-" + (captured?.payment_id || link.id),

                payload: {
                    payment_link: { entity: link },
                    payment: captured
                        ? {
                            entity: {
                                id: captured.payment_id,
                                amount: captured.amount,
                                method: captured.method,
                                fee: captured.fee,
                                tax: captured.tax,
                                notes: link.notes,
                            },
                        }
                        : undefined,
                },
            });

            settled += 1;
            console.log("[RECONCILE] settled a payment nobody told us about:", ticket.ticketNumber);
        } catch (error) {
            // One ticket that cannot be checked is one ticket; the rest of the
            // run carries on, and the next run tries this one again.
            console.error(
                "[RECONCILE] could not check " + ticket.ticketNumber + ":",
                error?.error?.description || error.message
            );
        }
    }

    if (settled) console.log("[RECONCILE] " + settled + " of " + waiting.length + " were already paid");

    return { checked: waiting.length, settled };
};

module.exports = { reconcileOnlinePayments };

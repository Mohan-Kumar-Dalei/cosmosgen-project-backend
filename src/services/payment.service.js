const Payment = require("../models/payment.model");
const Counter = require("../models/counter.model");
const discountService = require("./discount.service");
const Ticket = require("../models/ticket.model");
const QRCode = require("qrcode");
const phonepe = require("../config/phonepe");

const { isConfigured } = phonepe;

const paiseToRupees = (paise) => (Number(paise || 0) / 100).toFixed(2);
const rupeesToPaise = (rupees) => Math.round(Number(rupees) * 100);

const LIMITS = {
    MAX_ITEMS: 20,
    MIN_ITEM_RUPEES: 1,
    MAX_ITEM_RUPEES: 50000,
    MAX_TOTAL_RUPEES: 200000,
    MIN_DESC_LENGTH: 3,
    MAX_DESC_LENGTH: 60,
};

/**
 * Builds a bill from catalog items (priced server-side) plus any custom
 * lines the technician typed in. Catalog prices always win over anything
 * the client sends - only custom lines carry a client-supplied amount.
 *
 * `held` is the offer the ticket was booked with, if any - see the `discount`
 * field on the ticket. It is passed in rather than looked up here so this stays
 * a pure calculation: given the same lines and the same offer it always returns
 * the same figures, which is what makes an invoice reproducible.
 *
 * The order matters and is the Indian one: lines, then the discount off the
 * subtotal, then GST on what is left. Taking the discount off after tax would
 * have the company paying GST on money it never collected.
 */
const buildBill = ({ catalogItems = [], customItems = [], workDone = "", priceMap, held = null }) => {
    const lineItems = [];

    for (const entry of catalogItems) {
        const priced = priceMap.get(String(entry.id));
        if (!priced) {
            return { error: "One of the selected items is no longer available" };
        }
        const qty = Math.max(1, Math.min(20, Number(entry.qty) || 1));
        lineItems.push({
            description: qty > 1 ? `${priced.name} x${qty}` : priced.name,
            amountPaise: priced.pricePaise * qty,
            catalogItemId: String(entry.id),
            qty,
        });
    }

    for (const item of customItems) {
        const description = String(item.description || "").trim();
        const rupees = Number(item.amountRupees);

        if (description.length < LIMITS.MIN_DESC_LENGTH) {
            return { error: `Each custom line needs a description of at least ${LIMITS.MIN_DESC_LENGTH} characters` };
        }
        if (description.length > LIMITS.MAX_DESC_LENGTH) {
            return { error: `Description is too long (max ${LIMITS.MAX_DESC_LENGTH} characters)` };
        }
        if (!Number.isFinite(rupees) || rupees < LIMITS.MIN_ITEM_RUPEES || rupees > LIMITS.MAX_ITEM_RUPEES) {
            return { error: `"${description}" must be between ₹${LIMITS.MIN_ITEM_RUPEES} and ₹${LIMITS.MAX_ITEM_RUPEES}` };
        }

        lineItems.push({ description, amountPaise: rupeesToPaise(rupees), catalogItemId: null, qty: 1 });
    }

    if (lineItems.length === 0) {
        return { error: "Add at least one item to the bill" };
    }
    if (lineItems.length > LIMITS.MAX_ITEMS) {
        return { error: `You can add up to ${LIMITS.MAX_ITEMS} items` };
    }

    const subtotalPaise = lineItems.reduce((sum, l) => sum + l.amountPaise, 0);
    if (subtotalPaise > rupeesToPaise(LIMITS.MAX_TOTAL_RUPEES)) {
        return { error: `Total cannot exceed ₹${LIMITS.MAX_TOTAL_RUPEES}` };
    }

    /*
     * The offer, worked out against the bill that actually exists.
     *
     * Whatever was quoted at booking was a guess against an estimate - nobody
     * knows what a job comes to until the vendor has looked at it - so the
     * figure is computed again here, from the snapshot the ticket is carrying,
     * against the real subtotal. Without an offer this is zero and everything
     * below is the arithmetic that was always here.
     */
    const discountPaise = held ? discountService.amountOn(held, subtotalPaise) : 0;
    const taxablePaise = subtotalPaise - discountPaise;

    const gstPercent = Number(process.env.GST_PERCENT) || 0;
    const gstPaise = Math.round((taxablePaise * gstPercent) / 100);

    // What it would have come to at full price. The vendor's share is worked
    // out on this when the company is carrying the offer, and the invoice shows
    // the customer the difference.
    const grossTotalPaise = subtotalPaise + Math.round((subtotalPaise * gstPercent) / 100);

    return {
        lineItems,
        workDone: String(workDone || "").trim().slice(0, 300),
        subtotalPaise,

        discountPaise,
        discountLabel: discountPaise > 0 ? (held.label || "Discount") : null,
        discountCode: discountPaise > 0 ? (held.code || null) : null,

        taxablePaise,
        gstPercent,
        gstPaise,
        totalPaise: taxablePaise + gstPaise,
        grossTotalPaise,
    };
};

const generateInvoiceNumber = async () => {
    const now = new Date();
    const prefix = `INV-${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
    const counter = await Counter.findByIdAndUpdate(
        `invoice-${prefix}`,
        { $inc: { seq: 1 } },
        { returnDocument: "after", upsert: true }
    );
    return `${prefix}-${String(counter.seq).padStart(4, "0")}`;
};

/**
 * Ask the gateway again before giving up on it.
 *
 * A QR was one attempt. PhonePe refusing for a second - a timeout, a 502, one
 * of the brief wobbles every gateway has - failed the whole bill: the vendor
 * got a 502 of his own, the ticket was not touched, and he was told to take
 * cash instead while standing in somebody's kitchen. For a fault that would
 * very often have been over before he had read the message.
 *
 * Three tries with a growing gap, and only for the faults worth retrying. A
 * refusal with a reason - a bad amount, keys that are wrong, a merchant not
 * yet enabled for QR - fails the same way however many times it is asked, and
 * trying again only makes the vendor wait longer for the same answer.
 *
 * This is not a circuit breaker and does not pretend to be one. It rides out a
 * blip; a gateway that is properly down still ends with the vendor taking cash,
 * which is the right answer and the one the office already understands.
 */
const RETRY_WAITS_MS = [600, 1800];

const worthRetrying = (error) => {
    const status = error?.response?.status || error?.statusCode || error?.status;

    // PhonePe's sandbox answers a merchant with no test template configured
    // with a 500 that says "Scenario ... not found". It is a setup problem,
    // not a wobble, and asking twice more only keeps the vendor waiting.
    if (/scenario/i.test(gatewaySaid(error))) return false;

    // No status at all is a connection that never landed - the most retryable
    // thing there is. 5xx is the gateway's own trouble. 429 is being asked to
    // wait, which is a request to try again rather than a refusal.
    if (!status) return true;
    return status >= 500 || status === 429;
};

/** What PhonePe said, in one line, for the log. */
const gatewaySaid = (error) => {
    const body = error?.response?.data;
    return body?.message || body?.code || error?.message || "unknown error";
};

const askGateway = async (what, call) => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await call();
        } catch (error) {
            const last = attempt >= RETRY_WAITS_MS.length;
            const reason = gatewaySaid(error);

            if (last || !worthRetrying(error)) {
                console.error("PhonePe " + what + " failed:", reason);
                return null;
            }

            console.warn(
                "PhonePe " + what + " did not answer (" + reason + ") - trying again in "
                + RETRY_WAITS_MS[attempt] + "ms"
            );

            await new Promise((resolve) => { setTimeout(resolve, RETRY_WAITS_MS[attempt]); });
        }
    }
};

/*
 * How long a QR stays payable.
 *
 * Long enough for a customer to find their phone, open an app and scan; short
 * enough that a QR left on a screen, or one replaced by a corrected bill,
 * stops taking money soon after. PhonePe has no way to cancel an order, so the
 * expiry is the only thing that retires an old one. When it lapses before the
 * customer gets to it the vendor asks for a new QR, which is a new order.
 */
const BILL_QR_SECONDS = 20 * 60;
const SETTLEMENT_QR_SECONDS = 15 * 60;

/** A QR order, in the shape every caller here stores and hands on. */
const qrOrder = async (what, { prefix, parts, amountPaise, seconds, meta }) => {
    if (!isConfigured()) {
        console.log("PhonePe not configured - no QR created");
        return null;
    }

    const order = await askGateway(what, () => phonepe.createQrOrder({
        merchantOrderId: phonepe.orderIdFor(prefix, ...parts),
        amountPaise,
        expireAfterSeconds: seconds,
        meta,
    }));

    // askGateway has already said why, and said it once.
    if (!order) return null;

    return {
        orderId: order.merchantOrderId,
        qrData: order.qrData || order.intentUrl,
        intentUrl: order.intentUrl || order.qrData,
        expiresAt: order.expiresAt,
    };
};

/**
 * The QR for a bill: the whole of it on an online job, or only the company's
 * share on a split, where the vendor takes his own share in cash.
 */
const createBillQr = async ({ ticket, amountPaise, invoiceNumber, split = false }) => qrOrder("bill QR", {
    prefix: split ? "SPL" : "BIL",
    parts: [ticket.ticketNumber],
    amountPaise,
    seconds: BILL_QR_SECONDS,
    meta: {
        type: split ? "split_commission" : "bill",
        ticketId: String(ticket._id),
        invoiceNumber,
    },
});

/**
 * A QR for a vendor clearing his own dues. The type tells the webhook to file
 * it as a settlement for the office to record, not to close a ticket.
 */
const createSettlementQr = async ({ technician, amountPaise }) => qrOrder("settlement QR", {
    prefix: "STL",
    parts: [String(technician._id).slice(-8)],
    amountPaise,
    seconds: SETTLEMENT_QR_SECONDS,
    meta: { type: "wallet_recharge", technicianId: String(technician._id) },
});

/**
 * The QR itself, as a picture.
 *
 * Drawn here rather than on each phone, so the vendor app, the web panel and
 * anything after them show the same QR without each carrying a QR library.
 * A PNG data URI is a few kilobytes - smaller than the screen it sits on.
 */
const qrImage = async (qrData) => {
    if (!qrData) return null;
    try {
        return await QRCode.toDataURL(qrData, { errorCorrectionLevel: "M", margin: 1, width: 480 });
    } catch (error) {
        console.error("QR could not be drawn:", error.message);
        return null;
    }
};

/**
 * Where an order stands, in the shape the rest of the server already reads.
 *
 * PhonePe's order is PENDING until somebody pays, COMPLETED once they have,
 * and FAILED when the attempt failed or the QR lapsed unpaid. The latest
 * attempt carries the transaction id - the one id that names the money - and
 * the UTR the customer's own app shows them.
 */
const fetchOrderStatus = async (orderId) => {
    if (!isConfigured() || !orderId) return null;

    const order = await askGateway("status check", () => phonepe.getOrderStatus(orderId));
    if (!order) return null;

    const attempt = (order.paymentDetails || [])[0] || null;
    const paid = order.state === "COMPLETED";

    return {
        // paid | created | failed - the words the screens already used
        status: paid ? "paid" : order.state === "FAILED" ? "failed" : "created",
        isPaid: paid,
        amountPaidPaise: paid ? Number(order.amount) || 0 : 0,
        paymentId: paid ? attempt?.transactionId || null : null,
        utr: attempt?.rail?.utr || attempt?.splitInstruments?.[0]?.rail?.utr || null,
        method: paid ? "upi" : null,
        paidAt: paid && attempt?.timestamp ? new Date(Number(attempt.timestamp)) : null,
        expiresAt: order.expireAt ? new Date(Number(order.expireAt)) : null,
        meta: order.metaInfo || {},
    };
};

/**
 * The money behind a reference, whatever the office has in hand.
 *
 * PhonePe is asked by our own order id and by nothing else - there is no
 * "look up this transaction" call. The office, though, has whatever the row
 * shows or the vendor read out: our order id, PhonePe's transaction id, or
 * the UTR from the customer's app. Each of those is written down beside the
 * order id it belongs to when the money lands, so the order is found here
 * first and then asked about.
 *
 * Answers in the shape the office screens were written for - status
 * "captured" when the money is in - and throws with statusCode 404 when the
 * reference is nothing we know of.
 */
const fetchCharge = async (reference) => {
    const ref = String(reference || "").trim();

    const row = await Payment.findOne({
        $or: [{ razorpayPaymentId: ref }, { razorpayLinkId: ref }, { utr: ref }],
    }).select("razorpayLinkId").lean();

    let orderId = row?.razorpayLinkId || null;

    if (!orderId) {
        const ticket = await Ticket.findOne({
            $or: [
                { "payment.razorpayPaymentId": ref },
                { "payment.razorpayLinkId": ref },
                { "payment.utr": ref },
            ],
        }).select("payment.razorpayLinkId").lean();
        orderId = ticket?.payment?.razorpayLinkId || null;
    }

    // Our own order ids all start with one of these. Anything else that was
    // not found above is a reference this company has never issued.
    if (!orderId && /^(BIL|SPL|STL)-/.test(ref)) orderId = ref;

    if (!orderId) {
        const error = new Error("No order for " + ref);
        error.statusCode = 404;
        throw error;
    }

    let order;
    try {
        order = await phonepe.getOrderStatus(orderId);
    } catch (error) {
        const status = error?.response?.status;
        const wrapped = new Error(gatewaySaid(error));
        wrapped.statusCode = status === 400 || status === 404 ? 404 : status || 502;
        throw wrapped;
    }

    const attempt = (order.paymentDetails || [])[0] || null;

    return {
        id: attempt?.transactionId || orderId,
        orderId,
        status: order.state === "COMPLETED" ? "captured" : String(order.state || "PENDING").toLowerCase(),
        amount: Number(order.amount) || 0,
        method: "upi",
        utr: attempt?.rail?.utr || null,
        created_at: attempt?.timestamp ? Math.floor(Number(attempt.timestamp) / 1000) : null,
    };
};


module.exports = {
    buildBill,
    generateInvoiceNumber,
    createBillQr,
    createSettlementQr,
    qrImage,
    fetchOrderStatus,
    fetchCharge,
    paiseToRupees,
    rupeesToPaise,
    LIMITS,
    isGatewayActive: isConfigured,
};
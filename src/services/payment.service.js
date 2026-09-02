const Payment = require("../models/payment.model");
const Counter = require("../models/counter.model");
const { getRazorpay, isConfigured } = require("../config/razorpay");

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
 */
const buildBill = ({ catalogItems = [], customItems = [], workDone = "", priceMap }) => {
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

        lineItems.push({ description, amountPaise: rupeesToPaise(rupees) });
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

    const gstPercent = Number(process.env.GST_PERCENT) || 0;
    const gstPaise = Math.round((subtotalPaise * gstPercent) / 100);

    return {
        lineItems,
        workDone: String(workDone || "").trim().slice(0, 300),
        subtotalPaise,
        gstPercent,
        gstPaise,
        totalPaise: subtotalPaise + gstPaise,
    };
};

const generateInvoiceNumber = async () => {
    const now = new Date();
    const prefix = `INV-${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
    const counter = await Counter.findByIdAndUpdate(
        `invoice-${prefix}`,
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );
    return `${prefix}-${String(counter.seq).padStart(4, "0")}`;
};

const createPaymentLink = async ({ ticket, amountPaise, invoiceNumber }) => {
    if (!isConfigured()) {
        console.log("Razorpay not configured - no payment link created");
        return null;
    }

    try {
        const customer = ticket.customerSnapshot || {};
        const phone = String(customer.phone || "").replace(/\D/g, "");

        const link = await getRazorpay().paymentLink.create({
            amount: amountPaise,
            currency: "INR",
            description: `${ticket.serviceLabel} - ${ticket.ticketNumber}`,
            customer: {
                name: customer.name || "Customer",
                contact: phone.length === 10 ? `+91${phone}` : `+${phone}`,
            },
            notify: { sms: true, email: false },
            reminder_enable: true,
            notes: {
                ticketId: String(ticket._id),
                ticketNumber: ticket.ticketNumber,
                invoiceNumber,
            },
            callback_url: process.env.PAYMENT_CALLBACK_URL || undefined,
            callback_method: process.env.PAYMENT_CALLBACK_URL ? "get" : undefined,
        });

        return { linkId: link.id, linkUrl: link.short_url };
    } catch (error) {
        console.error("Razorpay link failed:", error?.error?.description || error.message);
        return null;
    }
};

/**
 * Live status check against Razorpay. The webhook is the source of truth for
 * closing tickets, but technicians need to see confirmation on their screen
 * without waiting - this gives them a pull-based check.
 */
const fetchPaymentLinkStatus = async (linkId) => {
    if (!isConfigured() || !linkId) return null;

    try {
        const link = await getRazorpay().paymentLink.fetch(linkId);

        // payments[] holds the actual transaction once someone pays
        const paidPayment = (link.payments || []).find((p) => p.status === "captured");

        return {
            status: link.status, // created | partially_paid | expired | cancelled | paid
            isPaid: link.status === "paid",
            amountPaidPaise: link.amount_paid || 0,
            paymentId: paidPayment?.payment_id || null,
            method: paidPayment?.method || null,
            paidAt: paidPayment?.created_at ? new Date(paidPayment.created_at * 1000) : null,
        };
    } catch (error) {
        console.error("Razorpay status fetch failed:", error?.error?.description || error.message);
        return null;
    }
};


/**
 * A link for a technician clearing their own commission dues. The notes
 * carry a different type so the webhook credits a wallet instead of
 * closing a ticket.
 */
const createWalletRechargeLink = async ({ technician, amountPaise }) => {
    if (!isConfigured()) return null;

    try {
        const phone = String(technician.phone || "").replace(/\D/g, "");

        const link = await getRazorpay().paymentLink.create({
            amount: amountPaise,
            currency: "INR",
            description: "Commission settlement - Cosmosgen",
            customer: {
                name: technician.name || "Technician",
                contact: phone.length === 10 ? "+91" + phone : "+" + phone,
            },
            notify: { sms: true, email: false },
            reminder_enable: false,
            notes: {
                type: "wallet_recharge",
                technicianId: String(technician._id),
            },
        });

        return { linkId: link.id, linkUrl: link.short_url };
    } catch (error) {
        console.error("Recharge link failed:", error?.error?.description || error.message);
        return null;
    }
};


module.exports = {
    buildBill,
    generateInvoiceNumber,
    createPaymentLink,
    fetchPaymentLinkStatus,
    paiseToRupees,
    rupeesToPaise,
    createWalletRechargeLink,
    LIMITS,
    isRazorpayActive: isConfigured,
    
};
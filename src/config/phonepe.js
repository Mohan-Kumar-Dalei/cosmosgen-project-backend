const crypto = require("crypto");
const axios = require("axios");
const keyring = require("../services/keyring.service");

/**
 * PhonePe Payment Gateway - Custom Checkout v2, UPI QR only.
 *
 * Every rupee the company collects online is a QR now: the vendor's phone
 * shows it, the customer scans it with whichever UPI app they already have,
 * and PhonePe tells us it landed. No card form, no link in a message, nothing
 * for the customer to sign up to.
 *
 * Two hosts, picked by PHONEPE_ENV. "sandbox" is PhonePe's UAT, where a QR
 * scanned with any UPI app opens a page that lets you choose Success, Failure
 * or Pending - no money moves. Anything else is production. The keys for each
 * come from the PhonePe Business Dashboard, Developer Settings, with the Test
 * Mode toggle ON for sandbox and OFF for production; they are not the same
 * keys and one will not work against the other host.
 */
const HOSTS = {
    sandbox: {
        token: "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token",
        pg: "https://api-preprod.phonepe.com/apis/pg-sandbox",
    },
    production: {
        token: "https://api.phonepe.com/apis/identity-manager/v1/oauth/token",
        pg: "https://api.phonepe.com/apis/pg",
    },
};

const host = () => (process.env.PHONEPE_ENV === "production" ? HOSTS.production : HOSTS.sandbox);

const isConfigured = () =>
    Boolean(process.env.PHONEPE_CLIENT_ID && process.env.PHONEPE_CLIENT_SECRET);

/*
 * The O-Bearer token, kept until a minute before PhonePe says it runs out.
 *
 * Asking for a fresh one before every order doubled the round trips while the
 * vendor stood at the door waiting for a QR. The minute of slack is so a token
 * that is about to lapse is never the one a request is sent with.
 */
let token = null;
let tokenFor = null;

const getToken = async () => {
    const id = process.env.PHONEPE_CLIENT_ID;
    const now = Math.floor(Date.now() / 1000);

    // A key changed under a running server is a different token.
    if (token && tokenFor === id + host().token && token.expiresAt - 60 > now) {
        return token.value;
    }

    const form = new URLSearchParams({
        client_id: id,
        client_version: process.env.PHONEPE_CLIENT_VERSION || "1",
        client_secret: process.env.PHONEPE_CLIENT_SECRET,
        grant_type: "client_credentials",
    });

    const { data } = await axios.post(host().token, form.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
    });

    token = { value: data.access_token, expiresAt: Number(data.expires_at) || now + 600 };
    tokenFor = id + host().token;
    return token.value;
};

/** One call to the PG API, with the token in front of it. */
const call = async (method, path, body) => {
    if (!isConfigured()) throw new Error("PhonePe keys missing in .env");

    // One per order, status check or refund - the count of what the gateway
    // is being asked for, the same as every other provider on the keys page.
    keyring.count("phonepe");

    const send = async () => axios({
        method,
        url: host().pg + path,
        data: body,
        timeout: 15000,
        headers: {
            "Content-Type": "application/json",
            Authorization: "O-Bearer " + (await getToken()),
        },
    });

    try {
        return (await send()).data;
    } catch (error) {
        // A token PhonePe has stopped honouring early: fetch a new one and
        // ask once more, rather than failing a bill over it.
        if (error?.response?.status === 401) {
            token = null;
            return (await send()).data;
        }
        throw error;
    }
};

/**
 * Our own order id: what PhonePe files the order under, and what we ask about.
 *
 * At most 63 characters, letters, digits, "_" and "-" only. The prefix says
 * what the money is for at a glance on the PhonePe dashboard; the time on the
 * end keeps a corrected bill or a fresh QR from colliding with the order it
 * replaces.
 */
const orderIdFor = (prefix, ...parts) =>
    [prefix, ...parts, Date.now().toString(36).toUpperCase()]
        .join("-")
        .replace(/[^A-Za-z0-9_-]/g, "")
        .slice(0, 63);

/**
 * A UPI QR for one amount.
 *
 * `meta` rides along as udf1..udf4 and comes back on the webhook and the
 * status call - it is how the webhook knows which ticket or which vendor the
 * money is for without a database lookup on the order id first.
 */
const createQrOrder = async ({ merchantOrderId, amountPaise, expireAfterSeconds, meta = {} }) => {
    const data = await call("post", "/payments/v2/pay", {
        merchantOrderId,
        amount: amountPaise,
        expireAfter: Math.max(300, Math.min(5184000, expireAfterSeconds || 900)),
        metaInfo: {
            udf1: String(meta.type || ""),
            udf2: String(meta.ticketId || ""),
            udf3: String(meta.technicianId || ""),
            udf4: String(meta.invoiceNumber || ""),
        },
        paymentFlow: { type: "PG", paymentMode: { type: "UPI_QR" } },
    });

    return {
        merchantOrderId,
        orderId: data.orderId,
        state: data.state,
        // What the QR encodes. PhonePe returns it as qrData; intentUrl is the
        // same upi:// payment as a link a phone can open straight into its
        // UPI app.
        qrData: data.qrData || "",
        intentUrl: data.intentUrl || "",
        expiresAt: new Date(Number(data.expireAt || data.expiryAt) || Date.now() + 900000),
    };
};

/** The order as PhonePe has it now, attempts and all. */
const getOrderStatus = async (merchantOrderId) =>
    call("get", "/payments/v2/order/" + encodeURIComponent(merchantOrderId) + "/status?details=false");

/**
 * Is this webhook really from PhonePe?
 *
 * PhonePe signs nothing; it sends SHA256("username:password") of the pair set
 * on the dashboard's webhook, in the Authorization header. Compared in
 * constant time so the comparison itself gives nothing away.
 */
const webhookIsGenuine = (header) => {
    const user = process.env.PHONEPE_WEBHOOK_USERNAME;
    const pass = process.env.PHONEPE_WEBHOOK_PASSWORD;
    if (!user || !pass || !header) return false;

    const expected = crypto.createHash("sha256").update(user + ":" + pass).digest("hex");
    const got = String(header).replace(/^SHA256\s+/i, "").trim().toLowerCase();

    return got.length === expected.length
        && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
};

/*
 * What the gateway will take, when nobody has told us.
 *
 * PhonePe does not put its own cut on the order the way Razorpay put it on the
 * payment - feeAmount on a PhonePe order is a convenience fee charged to the
 * payer, not the merchant's rate. So the company's cost is always this
 * estimate from the owner's setting (GATEWAY_FEE_PERCENT in settings.service):
 * zero while PhonePe's free offer runs, their published rate once it ends.
 */
const estimateGatewayFee = (amountPaise, percent = 0, gstPercent = 18) => {
    const feePaise = Math.round((amountPaise * percent) / 100);
    const taxPaise = Math.round((feePaise * gstPercent) / 100);
    return { feePaise, taxPaise };
};

module.exports = {
    isConfigured,
    orderIdFor,
    createQrOrder,
    getOrderStatus,
    webhookIsGenuine,
    estimateGatewayFee,
};

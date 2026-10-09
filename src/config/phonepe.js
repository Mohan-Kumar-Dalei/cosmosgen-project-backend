const crypto = require("crypto");
const axios = require("axios");
const keyring = require("../services/keyring.service");

/**
 * PhonePe Payment Gateway, UPI only.
 *
 * Every rupee the company collects online is a QR now: the vendor's phone
 * shows it, the customer scans it and pays by UPI, and PhonePe tells us it
 * landed. No card form, nothing for the customer to sign up to. Whether the
 * QR is a UPI QR or a link to PhonePe's payment page is PHONEPE_FLOW - see
 * flow() below.
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
 * Which of PhonePe's two products the money goes through, from PHONEPE_FLOW.
 *
 * "custom" is Custom Checkout: PhonePe hands back a real UPI QR, which any
 * UPI app scans straight into a payment. It is what this was built for, and
 * PhonePe has to switch it on for the merchant - on this account it answers
 * "Scenario with name null not found" until they do.
 *
 * "standard" (the default, Mohan 2026-10-09: "abhi keliye standard wala
 * method") is Standard Checkout: PhonePe hands back a link to its own payment
 * page. The QR then carries that link - the customer scans it with the phone
 * camera, PhonePe's page opens, and they pay from any UPI app there. One step
 * more, and available on every account. Changing the variable and restarting
 * is the whole switch; nothing else here cares which it is.
 */
const flow = () => (process.env.PHONEPE_FLOW === "custom" ? "custom" : "standard");

const PATHS = {
    custom: { pay: "/payments/v2/pay", order: "/payments/v2/order/" },
    standard: { pay: "/checkout/v2/pay", order: "/checkout/v2/order/" },
};

/**
 * Where PhonePe's page sends the customer once they have paid on it. Only
 * the standard flow has a page to come back from.
 */
const returnUrl = () =>
    String(process.env.PUBLIC_API_URL || "https://cosmosgen-api.duckdns.org").trim().replace(/\/+$/, "")
    + "/api/webhook/phonepe/return";

/**
 * A payment for one amount, as something to put in a QR.
 *
 * `meta` rides along as udf1..udf4 and comes back on the webhook and the
 * status call - it is how the webhook knows which ticket or which vendor the
 * money is for without a database lookup on the order id first.
 */
const createQrOrder = async ({ merchantOrderId, amountPaise, expireAfterSeconds, meta = {} }) => {
    const base = {
        merchantOrderId,
        amount: amountPaise,
        expireAfter: Math.max(300, Math.min(5184000, expireAfterSeconds || 900)),
        metaInfo: {
            udf1: String(meta.type || ""),
            udf2: String(meta.ticketId || ""),
            udf3: String(meta.technicianId || ""),
            udf4: String(meta.invoiceNumber || ""),
        },
    };

    if (flow() === "custom") {
        const data = await call("post", PATHS.custom.pay, {
            ...base,
            paymentFlow: { type: "PG", paymentMode: { type: "UPI_QR" } },
        });

        return {
            merchantOrderId,
            orderId: data.orderId,
            state: data.state,
            // What the QR encodes. PhonePe returns it as qrData; intentUrl is
            // the same upi:// payment as a link a phone can open straight into
            // its UPI app.
            qrData: data.qrData || "",
            intentUrl: data.intentUrl || "",
            expiresAt: new Date(Number(data.expireAt || data.expiryAt) || Date.now() + 900000),
        };
    }

    // UPI only on PhonePe's page: customers are never asked for a card.
    const checkout = (modes) => ({
        ...base,
        paymentFlow: {
            type: "PG_CHECKOUT",
            message: "Cosmosgen " + (meta.invoiceNumber || "payment"),
            merchantUrls: { redirectUrl: returnUrl() },
            ...(modes ? { paymentModeConfig: { enabledPaymentModes: modes } } : {}),
        },
    });

    /*
     * UPI only - plus, in the sandbox alone, net banking.
     *
     * PhonePe's UAT takes no real money, so a real UPI app (the iPhone that
     * tried first, 2026-10-09) cannot finish a sandbox payment: only PhonePe's
     * Android Test App can, or a UAT QR shown on a desktop. Sandbox net
     * banking is a page where username "test", password "test" and a Success
     * button complete the order from any phone - which is what lets the flow
     * be shown to anybody. It never reaches production.
     */
    const modes = [{ type: "UPI_INTENT" }, { type: "UPI_QR" }];
    if (process.env.PHONEPE_ENV !== "production") modes.push({ type: "NET_BANKING" });

    let data;
    try {
        data = await call("post", PATHS.standard.pay, checkout(modes));
    } catch (error) {
        // An account that will not take a payment-mode list still takes the
        // order without one; the page then offers whatever PhonePe allows.
        if (error?.response?.status !== 400) throw error;
        console.warn("PhonePe refused the UPI-only page, asking without it:", error.response?.data?.message);
        data = await call("post", PATHS.standard.pay, checkout(null));
    }

    return {
        merchantOrderId,
        orderId: data.orderId,
        state: data.state,
        // The page's address is both what the QR carries and what opens on a
        // phone that cannot scan its own screen.
        qrData: data.redirectUrl || "",
        intentUrl: data.redirectUrl || "",
        expiresAt: new Date(Number(data.expireAt || data.expiryAt) || Date.now() + 900000),
    };
};

/**
 * The order as PhonePe has it now, attempts and all.
 *
 * Asked under the flow in use, and under the other if PhonePe does not know
 * the order there - an order made before PHONEPE_FLOW was changed lives under
 * the product it was made with.
 */
const getOrderStatus = async (merchantOrderId) => {
    const id = encodeURIComponent(merchantOrderId);
    const [first, second] = flow() === "custom" ? ["custom", "standard"] : ["standard", "custom"];

    try {
        return await call("get", PATHS[first].order + id + "/status?details=false");
    } catch (error) {
        const status = error?.response?.status;
        if (status !== 400 && status !== 404) throw error;
        return call("get", PATHS[second].order + id + "/status?details=false");
    }
};

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

    // The hash itself, however it is wrapped - bare, "SHA256 <hash>" or
    // "SHA256(<hash>)", which is how PhonePe's own page writes it.
    const got = (String(header).match(/[a-f0-9]{64}/i) || [""])[0].toLowerCase();

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

/**
 * Why a webhook was turned away, for the log - without printing the header
 * or the password. "No username/password in .env" and "a header that is not
 * a hash at all" each need a different fix from "the pair on the dashboard is
 * not the pair in .env".
 */
const whyNotGenuine = (header) => {
    if (!process.env.PHONEPE_WEBHOOK_USERNAME || !process.env.PHONEPE_WEBHOOK_PASSWORD) {
        return "PHONEPE_WEBHOOK_USERNAME / PHONEPE_WEBHOOK_PASSWORD are not set in .env";
    }
    if (!header) return "the request carried no Authorization header (a URL check, not an event)";
    if (!/[a-f0-9]{64}/i.test(String(header))) {
        return "the Authorization header is not a SHA256 hash (" + String(header).length + " characters)";
    }
    return "the hash is of a different username:password than the one in .env - "
        + "the pair typed on the dashboard's webhook must be exactly the pair in .env";
};

module.exports = {
    flow,
    whyNotGenuine,
    isConfigured,
    orderIdFor,
    createQrOrder,
    getOrderStatus,
    webhookIsGenuine,
    estimateGatewayFee,
};

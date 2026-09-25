const Razorpay = require("razorpay");
const keyring = require("../services/keyring.service");

let instance = null;

const isConfigured = () =>
    Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

const getRazorpay = () => {
    if (!isConfigured()) {
        throw new Error("Razorpay keys missing in .env");
    }

    // Fetched once per payment link, refund or lookup, which makes this the
    // count of what the gateway is being asked for
    keyring.count("razorpay");
    if (!instance) {
        instance = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
    }
    return instance;
};

/*
 * What the gateway will take, when nobody has told us yet.
 *
 * Razorpay reports the real fee on the payment entity and the webhook writes
 * it down - so this is only ever used for money that has not moved: the
 * commission a vendor still owes on a cash job. The rate is passed in rather
 * than read here, because it is an owner setting now (GATEWAY_FEE_PERCENT in
 * settings.service) and not a deploy-time constant.
 *
 * The defaults are the fallback of a fallback: if a caller somehow has no
 * setting to hand, an estimate slightly on the high side is the safer error -
 * it understates the margin rather than overstating it.
 */
const estimateGatewayFee = (amountPaise, percent = 2.2, gstPercent = 18) => {
    const feePaise = Math.round((amountPaise * percent) / 100);
    const taxPaise = Math.round((feePaise * gstPercent) / 100);
    return { feePaise, taxPaise };
};

module.exports = { getRazorpay, isConfigured, estimateGatewayFee };
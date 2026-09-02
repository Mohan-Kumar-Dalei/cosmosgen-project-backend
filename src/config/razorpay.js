const Razorpay = require("razorpay");

let instance = null;

const isConfigured = () =>
    Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

const getRazorpay = () => {
    if (!isConfigured()) {
        throw new Error("Razorpay keys missing in .env");
    }
    if (!instance) {
        instance = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
    }
    return instance;
};

// Razorpay charges roughly 2% plus 18% GST on that fee. The webhook gives
// the exact number, but a link can be paid before the webhook lands - this
// keeps the P&L close until the real figure arrives.
const GATEWAY_FEE_PERCENT = Number(process.env.GATEWAY_FEE_PERCENT) || 2;
const GATEWAY_GST_PERCENT = 18;

const estimateGatewayFee = (amountPaise) => {
    const feePaise = Math.round((amountPaise * GATEWAY_FEE_PERCENT) / 100);
    const taxPaise = Math.round((feePaise * GATEWAY_GST_PERCENT) / 100);
    return { feePaise, taxPaise };
};

module.exports = { getRazorpay, isConfigured, estimateGatewayFee, GATEWAY_FEE_PERCENT };
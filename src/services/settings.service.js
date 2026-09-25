const Setting = require("../models/setting.model");

/**
 * Owner-editable numbers, with the built-in value as the floor.
 *
 * Everything here has a default that keeps the app working if the row was
 * never written - a fresh database must not mean "bills can be edited zero
 * times" or "refunds are unlimited".
 */
const DEFAULTS = {
    // How many times a technician may correct a bill they already generated.
    // Three covers an honest slip; past that the office should be looking at
    // why one job needed rewriting four times.
    BILL_EDIT_LIMIT: 3,

    // Charged when a technician has travelled out and the customer refuses
    // the quote, so a wasted trip is not a total loss.
    VISIT_CHARGE_RUPEES: 149,

    // The company's cut of that visit charge. Zero deliberately: the
    // technician burned the fuel, and taking a share of the only thing he
    // earned on a wasted trip costs more in goodwill than it makes.
    VISIT_COMMISSION_PERCENT: Number(process.env.VISIT_COMMISSION_PERCENT) || 0,

    // Working days between a customer paying online and the technician's
    // share reaching his bank. The money is not the company's to send until
    // Razorpay settles it, which takes four days or so - the fifth is the
    // office actually making the transfer. This is the number the technician
    // is told, so it should be the honest one, not the optimistic one.
    PAYOUT_DAYS: 5,

    /*
     * What Razorpay takes, as a percentage, before its own GST.
     *
     * This lived in the environment at 2, and the environment is the wrong
     * place for it: the real rate on this account is nearer 2.5, it is
     * negotiable, and changing it meant editing a file on the server and
     * restarting. Meanwhile the screen printed "Razorpay 2% + GST" beside a
     * figure Razorpay had actually charged - the two disagreed in front of
     * the office, which is the fastest way to make somebody stop believing a
     * financial screen.
     *
     * It is only ever an estimate. Wherever the gateway has told us what it
     * really took - every online and split payment, through the webhook -
     * that figure wins and this one is not consulted. It matters for the one
     * case where the money has not moved yet: the commission a vendor still
     * has to send back on a cash job.
     */
    GATEWAY_FEE_PERCENT: Number(process.env.GATEWAY_FEE_PERCENT) || 2.2,

    // GST on the gateway's fee. Eighteen per cent, and not ours to choose -
    // it is here so the arithmetic is in one place rather than written into
    // four files as a bare 18.
    GATEWAY_FEE_GST_PERCENT: 18,
};

const RULES = {
    BILL_EDIT_LIMIT: { min: 0, max: 20, label: "Bill edits allowed per job" },
    VISIT_CHARGE_RUPEES: { min: 0, max: 2000, label: "Visit charge when a customer refuses (Rs)" },
    VISIT_COMMISSION_PERCENT: { min: 0, max: 100, label: "Company's cut of the visit charge (%)" },
    PAYOUT_DAYS: { min: 1, max: 30, label: "Days to pay a technician after an online job" },
    GATEWAY_FEE_PERCENT: { min: 0, max: 10, label: "Razorpay's fee before GST (%)" },
    GATEWAY_FEE_GST_PERCENT: { min: 0, max: 30, label: "GST charged on the gateway's fee (%)" },
};

/** Read-through with a short cache - these change perhaps twice a year. */
let cache = {};
let cachedAt = 0;
const CACHE_MS = 60 * 1000;

const loadAll = async () => {
    if (Date.now() - cachedAt < CACHE_MS && Object.keys(cache).length) return cache;

    const rows = await Setting.find({}).lean();
    const next = { ...DEFAULTS };
    rows.forEach((r) => {
        if (r.key in DEFAULTS) next[r.key] = r.value;
    });

    cache = next;
    cachedAt = Date.now();
    return cache;
};

const getSetting = async (key) => {
    const all = await loadAll();
    return all[key] ?? DEFAULTS[key];
};

const setSetting = async (key, value, adminId) => {
    if (!(key in DEFAULTS)) throw new Error("Unknown setting: " + key);

    const rule = RULES[key];
    const num = Number(value);

    if (!Number.isFinite(num) || !Number.isInteger(num)) {
        throw new Error(rule.label + " must be a whole number");
    }
    if (num < rule.min || num > rule.max) {
        throw new Error(rule.label + " must be between " + rule.min + " and " + rule.max);
    }

    await Setting.findOneAndUpdate(
        { key },
        { value: num, updatedBy: adminId },
        { upsert: true }
    );

    cachedAt = 0; // next read picks it up immediately
    return num;
};

const listSettings = async () => {
    const all = await loadAll();
    return Object.keys(DEFAULTS).map((key) => ({
        key,
        value: all[key],
        default: DEFAULTS[key],
        label: RULES[key].label,
        min: RULES[key].min,
        max: RULES[key].max,
    }));
};

module.exports = { getSetting, setSetting, listSettings, DEFAULTS };

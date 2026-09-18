const technicianModel = require("../models/technician.model");
const userModel = require("../models/user.model");

/**
 * Waking a phone that has stopped listening.
 *
 * The socket is the right channel while the vendor is looking at the app, and
 * it is the wrong one the moment they press the home button. Android freezes a
 * backgrounded app: the socket goes, and the JavaScript that would have played
 * the alert and filed a notification is not running to be told anything. That
 * is exactly what Mohan saw - a job assigned while the app sat on the home
 * screen, and a phone that never made a sound.
 *
 * A push is the only thing the platform will act on in that state, because the
 * platform itself acts on it. The payload names the notification channel the
 * app created (src/alerts.js), and Android plays that channel's sound and
 * vibration pattern whether the app is frozen, backgrounded or not running at
 * all. Our code is not involved in the noise.
 *
 * Expo's service is used rather than Firebase directly. It is the same FCM
 * underneath - Expo holds the server credentials the app was built with - and
 * it takes a token the app can fetch in one call instead of a Firebase SDK in
 * the app and a service account on this machine.
 */
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** The channel in the vendor app. Must match alerts.js or Android picks its own. */
const JOB_CHANNEL = "jobs-v2";

/**
 * Expo hands out two shapes and only one of them belongs here.
 *
 * A token from a development build looks the same as one from a store build,
 * but a stale or hand-edited value does not, and Expo rejects the whole batch
 * rather than the bad row. Cheaper to check here.
 */
const looksLikeAToken = (value) =>
    typeof value === "string" && /^Expo(nent)?PushToken\[.+\]$/.test(value.trim());

/**
 * Send one, and forget it.
 *
 * Never awaited by a caller that has work left to do: assigning a job must not
 * be slower, or fail, because a phone company's server is slow. A push that
 * does not arrive costs an alert, not the job - the socket, the WhatsApp
 * message and the app's own list are all still there.
 */
const sendToTechnician = async (technicianId, { title, body, data = {} }) => {
    if (!technicianId) return;

    try {
        const tech = await technicianModel
            .findById(technicianId)
            .select("pushToken name")
            .lean();

        const token = tech?.pushToken;

        if (!looksLikeAToken(token)) {
            // Worth a line: a vendor whose phone never registered is a vendor
            // who will never be woken, and nothing else in the system says so.
            console.log(
                "[PUSH] no usable token for " + (tech?.name || technicianId)
                + " - they will only be alerted while the app is open"
            );
            return;
        }

        const response = await fetch(EXPO_PUSH_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                to: token.trim(),
                title,
                body,
                data,

                sound: "default",

                /*
                 * The three things that decide whether a locked, dozing phone
                 * actually rings.
                 *
                 * `channelId` points Android at the channel the app made, which
                 * is where the vibration pattern and max importance live.
                 * `priority: high` asks FCM to deliver now rather than batching
                 * it into the next maintenance window - Doze will otherwise
                 * hold it for minutes. `ttl` throws it away rather than
                 * delivering it late: a job alert that arrives an hour after the
                 * job was assigned is worse than none.
                 */
                channelId: JOB_CHANNEL,
                priority: "high",
                ttl: 600,
            }),
        });

        const result = await response.json().catch(() => null);
        const ticket = result?.data;

        if (ticket?.status === "error") {
            console.log("[PUSH] rejected: " + (ticket.message || "unknown"));

            /*
             * A device that has been wiped, reinstalled or signed out keeps
             * answering with this forever. Dropping the token stops us asking
             * again every time a job is assigned, and the app writes a fresh
             * one the next time it starts.
             */
            if (ticket.details?.error === "DeviceNotRegistered") {
                await technicianModel
                    .updateOne({ _id: technicianId }, { $unset: { pushToken: 1 } })
                    .catch(() => { /* it will be tried again and dropped again */ });
            }
            return;
        }

        console.log("[PUSH] sent to " + (tech.name || technicianId) + ": " + title);
    } catch (err) {
        console.log("[PUSH] could not send: " + err.message);
    }
};

/**
 * The same thing, to a customer.
 *
 * Separate from sendToTechnician rather than merged with it, because the two
 * differ in the parts that matter: a different collection, a different channel
 * - a customer's phone should not buzz like a work phone - and a different
 * answer when the token is dead.
 *
 * Silent when there is no token, which is every customer until the app has
 * been built with Firebase credentials for its own package. Nothing here
 * fails; the WhatsApp message is still the message that always arrives.
 */
const sendToCustomer = async (customerId, { title, body, data = {} }) => {
    if (!customerId) return;

    try {
        const user = await userModel.findById(customerId).select("name pushToken").lean();

        if (!looksLikeAToken(user?.pushToken)) return;

        const res = await fetch(EXPO_PUSH_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify([{
                to: user.pushToken,
                title,
                body,
                data,
                sound: "default",
                priority: "high",
                channelId: "updates",
            }]),
        });

        const out = await res.json().catch(() => null);
        const ticket = out?.data?.[0];

        /*
         * A token the device has stopped accepting is cleared, not retried.
         * Keeping it means every later message is sent into nothing and the
         * log fills with the same failure.
         */
        if (ticket?.details?.error === "DeviceNotRegistered") {
            await userModel.updateOne({ _id: customerId }, { $unset: { pushToken: 1 } }).catch(() => {});
            return;
        }

        console.log("[PUSH] sent to customer " + (user.name || customerId) + ": " + title);
    } catch (err) {
        console.error("[PUSH] customer send failed:", err.message);
    }
};

module.exports = { sendToTechnician, sendToCustomer, JOB_CHANNEL };

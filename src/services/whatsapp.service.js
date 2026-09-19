const errors = require("../config/sentry");
const axios = require("axios");
const keyring = require("./keyring.service");

const GRAPH_URL = "https://graph.facebook.com/v21.0";

const isConfigured = () =>
    Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);

const client = () => {
    // Every send builds one of these, so this is the honest place to
    // count what the WhatsApp number is being asked to do today
    keyring.count("meta");

    return axios.create({
        baseURL: `${GRAPH_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}`,
        headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
        },
        timeout: 10000,
    });
};

// India ke numbers ke liye 91 prefix. WhatsApp bina + ke chahta hai.
const formatPhone = (phone) => {
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length === 10) return `91${digits}`;
    return digits;
};

const sendText = async (to, body) => {
    if (!isConfigured()) {
        console.warn("[WA] Not configured. TOKEN set?", !!process.env.WHATSAPP_TOKEN,
            "| PHONE_NUMBER_ID set?", !!process.env.WHATSAPP_PHONE_NUMBER_ID);
        return null;
    }
    try {
        const { data } = await client().post("/messages", {
            messaging_product: "whatsapp",
            to: formatPhone(to),
            type: "text",
            text: { preview_url: false, body },
        });
        /**
         * "accepted" is not "delivered".
         *
         * Meta answers 200 and hands back a message id for anything it will
         * take, including a free-form message to somebody outside the
         * twenty four hour window - who will never receive it. The status it
         * returns is the only hint in the response, so it is printed rather
         * than swallowed: a log that says "Sent" while nothing arrives is
         * worse than no log at all.
         */
        const status = data?.messages?.[0]?.message_status;
        console.log("[WA] Sent text to " + to + (status ? " (" + status + ")" : ""));
        return data;
    } catch (error) {
        // Meta's error body says exactly what's wrong - wrong id, expired
        // token, recipient not on the allow list - so print all of it
        console.error("[WA] Send failed:", JSON.stringify(error.response?.data || error.message, null, 2));
        return null;
    }
};

/**
 * Blue ticks, and the "typing..." bubble while the model thinks.
 *
 * Both ride on the same call. The typing indicator is a newer field, so a
 * rejection falls back to a plain receipt rather than costing us the tick as
 * well. Callers must not await this: a read receipt that arrives late is
 * harmless, one that delays the reply is not.
 */
const markAsRead = async (messageId) => {
    if (!isConfigured() || !messageId) return null;

    const receipt = { messaging_product: "whatsapp", status: "read", message_id: messageId };

    try {
        const { data } = await client().post("/messages", {
            ...receipt,
            typing_indicator: { type: "text" },
        });
        return data;
    } catch {
        try {
            const { data } = await client().post("/messages", receipt);
            return data;
        } catch (error) {
            console.error("[WA] Mark read failed:", error.response?.data || error.message);
            return null;
        }
    }
};

// Interactive list - services ya issues dikhane ke liye.
// User ko kuch type nahi karna padta, bas select karta hai.
// NOTE: WhatsApp limit - max 10 rows, title max 24 chars, description max 72 chars
const sendList = async (to, { body, buttonText, sectionTitle, rows }) => {
    if (!isConfigured()) return null;
    try {
        const { data } = await client().post("/messages", {
            messaging_product: "whatsapp",
            to: formatPhone(to),
            type: "interactive",
            interactive: {
                type: "list",
                body: { text: body },
                action: {
                    button: buttonText,
                    sections: [{
                        title: sectionTitle,
                        rows: rows.slice(0, 10).map((r) => ({
                            id: r.id,
                            title: String(r.title).slice(0, 24),
                            description: r.description ? String(r.description).slice(0, 72) : undefined,
                        })),
                    }],
                },
            },
        });
        return data;
    } catch (error) {
        console.error("WhatsApp list failed:", error.response?.data || error.message);
        errors.report(error, "whatsapp.list");
        return null;
    }
};

// Reply buttons - max 3. Yes/No type confirmation ke liye
const sendButtons = async (to, { body, buttons }) => {
    if (!isConfigured()) return null;
    try {
        const { data } = await client().post("/messages", {
            messaging_product: "whatsapp",
            to: formatPhone(to),
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: body },
                action: {
                    buttons: buttons.slice(0, 3).map((b) => ({
                        type: "reply",
                        reply: { id: b.id, title: String(b.title).slice(0, 20) },
                    })),
                },
            },
        });
        return data;
    } catch (error) {
        console.error("WhatsApp buttons failed:", error.response?.data || error.message);
        return null;
    }
};

/**
 * A file, sent as a file.
 *
 * WhatsApp fetches the link itself rather than taking bytes from us, so the
 * URL has to be public and reachable from Meta's servers - which is exactly
 * what an ImageKit address is. The customer gets a document they can open,
 * forward and keep, not a link they have to tap through a browser.
 *
 * The filename is what they see in the chat and what lands in their Downloads
 * folder, so it carries the invoice number rather than whatever the CDN made
 * of it.
 */
const sendDocument = async (to, { url, filename, caption }) => {
    if (!isConfigured() || !url) return null;

    try {
        const { data } = await client().post("/messages", {
            messaging_product: "whatsapp",
            to: formatPhone(to),
            type: "document",
            document: {
                link: url,
                filename: filename || "document.pdf",
                ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
            },
        });
        return data;
    } catch (error) {
        console.error("WhatsApp document failed:", error.response?.data || error.message);
        return null;
    }
};

module.exports = { sendText, sendList, sendButtons, sendDocument, markAsRead, formatPhone, isConfigured };
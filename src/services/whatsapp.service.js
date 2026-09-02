const axios = require("axios");

const GRAPH_URL = "https://graph.facebook.com/v21.0";

const isConfigured = () =>
    Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);

const client = () =>
    axios.create({
        baseURL: `${GRAPH_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}`,
        headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
        },
        timeout: 10000,
    });

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
        console.log("[WA] Sent text to", to);
        return data;
    } catch (error) {
        // Meta's error body says exactly what's wrong - wrong id, expired
        // token, recipient not on the allow list - so print all of it
        console.error("[WA] Send failed:", JSON.stringify(error.response?.data || error.message, null, 2));
        return null;
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

// Location request - user ka exact coordinates maangne ke liye.
// Ye services dikhane se PEHLE bhejna hai.
const sendLocationRequest = async (to, body) => {
    if (!isConfigured()) return null;
    try {
        const { data } = await client().post("/messages", {
            messaging_product: "whatsapp",
            to: formatPhone(to),
            type: "interactive",
            interactive: {
                type: "location_request_message",
                body: { text: body },
                action: { name: "send_location" },
            },
        });
        return data;
    } catch (error) {
        console.error("WhatsApp location request failed:", error.response?.data || error.message);
        return null;
    }
};

module.exports = { sendText, sendList, sendButtons, sendLocationRequest, formatPhone, isConfigured };
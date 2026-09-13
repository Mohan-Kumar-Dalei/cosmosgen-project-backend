const crypto = require("crypto");

/**
 * The code a new vendor gets on WhatsApp before they can register.
 *
 * WhatsApp is already the channel this platform runs on, so rather than pay a
 * second provider to send an SMS, the signup asks for the number, we send six
 * digits to it ourselves, and the vendor types them back. The app and the web
 * panel both come through here.
 *
 * Held in memory rather than in Mongo. These live for ten minutes and are
 * worth nothing afterwards, so a restart losing a handful of pending codes
 * costs somebody one extra tap - and a collection of dead codes would need
 * sweeping for ever.
 */
const pending = new Map();

const TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 45 * 1000;
const MAX_ATTEMPTS = 5;

const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");

/**
 * Old entries are cleared when a new one is made rather than on a timer.
 *
 * A setInterval here would keep the process alive and would run all night for
 * a map that is empty most of the time. Registration is rare enough that
 * sweeping on each send costs nothing.
 */
const sweep = () => {
    const now = Date.now();
    for (const [phone, entry] of pending) {
        if (now - entry.sentAt > TTL_MS) pending.delete(phone);
    }
};

/**
 * Returns { code } to send, or { wait } when one has just gone out.
 *
 * The cooldown is what stops the button being used to send somebody a message
 * every second, and it is returned in seconds because that is what the screen
 * counts down.
 */
const issue = (phone) => {
    sweep();

    const existing = pending.get(phone);
    if (existing && Date.now() - existing.sentAt < RESEND_AFTER_MS) {
        return { wait: Math.ceil((RESEND_AFTER_MS - (Date.now() - existing.sentAt)) / 1000) };
    }

    const code = newCode();
    pending.set(phone, { code, sentAt: Date.now(), attempts: 0 });
    return { code };
};

/** Returns { ok } or { ok: false, message } written for the person typing. */
const check = (phone, entered) => {
    const entry = pending.get(phone);
    const typed = String(entered || "").trim();

    if (!entry) {
        return { ok: false, message: "No code has been sent to that number. Ask for one first." };
    }
    if (Date.now() - entry.sentAt > TTL_MS) {
        pending.delete(phone);
        return { ok: false, message: "That code has expired. Ask for a new one." };
    }
    if (entry.attempts >= MAX_ATTEMPTS) {
        pending.delete(phone);
        return { ok: false, message: "Too many wrong tries. Ask for a new code." };
    }
    if (!/^\d{6}$/.test(typed)) {
        return { ok: false, message: "Enter the six digits sent to your WhatsApp." };
    }

    entry.attempts += 1;

    const a = Buffer.from(typed);
    const b = Buffer.from(entry.code);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { ok: false, message: "That code does not match. Check it and try again." };
    }

    // Spent the moment it works, so the same six digits cannot be replayed
    pending.delete(phone);
    return { ok: true };
};

module.exports = { issue, check, TTL_MS, RESEND_AFTER_MS, MAX_ATTEMPTS };

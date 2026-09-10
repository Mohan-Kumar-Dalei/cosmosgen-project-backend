const crypto = require("crypto");

/**
 * The codes the customer reads out at the door.
 *
 * Two moments on a job need one. Before work begins, so a technician cannot
 * mark himself started from the car park; and before the job is closed, so a
 * job is only finished when the person who paid for it says it is. In both
 * cases the code goes to the customer and the technician has to be standing
 * in front of them to learn it.
 *
 * Nothing here talks to WhatsApp. It makes codes, checks them, and says why a
 * check failed - the sending is the caller's business, which keeps this
 * usable from any channel.
 */

// Six digits, from a real random source. Math.random() is predictable enough
// that a determined technician could guess the next code from the last one.
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");

const TTL_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/**
 * Long enough that a customer who put the phone down still has a valid code
 * when the technician is ready, short enough that yesterday's message is no
 * use to anyone.
 */
const issue = () => ({
    code: generateCode(),
    sentAt: new Date(),
    verifiedAt: null,
    attempts: 0,
});

/**
 * Returns { ok } or { ok: false, reason, message }.
 *
 * The message is written for the technician, because he is the one holding
 * the phone when it fails, and "invalid" on its own tells him nothing about
 * whether to ask again or ring the office.
 */
const check = (block, entered) => {
    const typed = String(entered || "").trim();

    if (!block || !block.code) {
        return {
            ok: false,
            reason: "not_sent",
            message: "No code has been sent yet. Send it to the customer first.",
        };
    }

    if (block.verifiedAt) {
        return { ok: true, alreadyVerified: true };
    }

    if ((block.attempts || 0) >= MAX_ATTEMPTS) {
        return {
            ok: false,
            reason: "locked",
            message: "Too many wrong tries. Send a new code to the customer.",
        };
    }

    if (Date.now() - new Date(block.sentAt).getTime() > TTL_MS) {
        return {
            ok: false,
            reason: "expired",
            message: "That code has expired. Send the customer a new one.",
        };
    }

    if (!/^\d{6}$/.test(typed)) {
        return {
            ok: false,
            reason: "malformed",
            message: "Enter the six digits the customer received.",
        };
    }

    // Constant-time compare. The codes are short-lived, but timing a
    // character-by-character comparison is a real way to walk a six digit
    // code, and the fix costs nothing.
    const a = Buffer.from(typed);
    const b = Buffer.from(String(block.code));

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return {
            ok: false,
            reason: "mismatch",
            message: "That code does not match. Ask the customer to read it again.",
        };
    }

    return { ok: true };
};

module.exports = { issue, check, MAX_ATTEMPTS, TTL_MS };

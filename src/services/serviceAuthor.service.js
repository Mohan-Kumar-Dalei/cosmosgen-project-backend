const { SERVICE_CATALOG } = require("../config/services");

/**
 * Writes a new service from its name, so the office only has to supply a
 * picture.
 *
 * What a service actually needs to work here is more than anybody would guess
 * from the form: a stable key, a worker noun, keywords that will match an
 * engineer's free-text skills, a line of customer-facing copy, a handful of
 * badges, and a list of faults with a key each and wording in three languages
 * that stays under WhatsApp's 24-character row limit. Asking the office to
 * type all of that is asking them to do a job they did not sign up for, and
 * they would do it differently every time.
 *
 * So the assistant drafts it and a person approves it. The draft is never
 * saved on its own - the controller hands it back for review first, because a
 * model that misreads "AC" as air conditioning when the office meant
 * something else should be caught by a human before it reaches a customer.
 */
/*
 * The key comes from the ring rather than from the environment.
 *
 * Same call, same answer - what changes is that a key the provider has
 * refused for quota is stepped past instead of failing everything at once,
 * and what each key has been spent on is countable in the office.
 */
const keyring = require("./keyring.service");
const MODEL_NAME = process.env.GEMINI_CHAT_MODEL || "gemini-3.1-flash-lite";

/** The house style, taken from the services that already exist. */
const examples = () => SERVICE_CATALOG.slice(0, 2).map((s) => ({
    key: s.key,
    label: s.label,
    worker: s.worker,
    keywords: s.keywords,
    issues: (s.issues || []).slice(0, 3).map((i) => ({
        key: i.key, en: i.en, hinglish: i.hinglish, odia: i.odia,
    })),
}));

const INSTRUCTION = `You write catalogue entries for Cosmosgen Engineers Pvt. Ltd., which sends approved engineers to people's homes across India.

You are given the name of a service the office wants to start offering, and sometimes a note about it. Return ONE JSON object and nothing else.

Shape:
{
  "key": "UPPER_SNAKE_CASE, short, unique, derived from the name",
  "label": "the service as a customer would see it, title case, under 40 characters",
  "labelHinglish": "the same, as a Hindi speaker here would say it - keep English words people actually use",
  "labelOdia": "the same, as an Odia speaker would say it, written in Odia script - keep the English words people actually use in English letters",
  "worker": "one lower-case noun for the person who does it: electrician, plumber, carpenter, cleaner, technician",
  "keywords": ["lower case words that would appear in an engineer's own description of their skills"],
  "blurb": "one sentence, max 140 characters, in the words a customer would use about their own house. No marketing adjectives.",
  "badges": ["three or four two-to-three word tags, e.g. 'Same-day visits', 'Parts from the list'"],
  "issues": [
    { "key": "UPPER_SNAKE", "en": "the fault in plain English", "hinglish": "...", "odia": "..." }
  ],
  "appliances": []
}

HARD RULES
The "odia" strings are Odia and must be written in Odia script, never in Latin letters - transliterated Odia is unreadable even to an Odia speaker. Words people say in English (AC, fuse, spin, servicing, cleaning) stay in English letters inside the Odia sentence.
Every "en", "hinglish" and "odia" string must be 24 characters or fewer. They are rows in a WhatsApp list and anything longer is cut off mid-word. Count them.
Give between four and six issues. They must be the faults people actually report, not categories.
"appliances" stays an empty array unless the service genuinely covers several different machines, in which case give each one a key, a label and its own issues under the same 24-character rule.
Never invent a price, a duration or a guarantee. Nothing in the blurb or a badge may promise a time or an amount.
Write plainly. No exclamation marks, no "hassle-free", no "expert".

Here are two existing entries, for house style only - do not copy their content:
`;

const parse = (text) => {
    const clean = String(text || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    return JSON.parse(clean);
};

/** Belt and braces: the model is told the limit, and the limit is enforced. */
const clip = (value) => (typeof value === "string" && value.length > 24
    ? value.slice(0, 24).trim()
    : value);

const tidyIssue = (issue, i) => ({
    key: String(issue.key || "ISSUE_" + (i + 1)).toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
    en: clip(issue.en || ""),
    hinglish: clip(issue.hinglish || issue.en || ""),
    odia: clip(issue.odia || issue.en || ""),
});

/**
 * @param {string} name  what the office typed
 * @param {string} note  anything they added about what it covers
 */
const draft = async (name, note = "") => {
    const response = await keyring.generate({
        model: MODEL_NAME,
        contents: [{
            role: "user",
            parts: [{
                text: "Service name: " + name
                    + (note ? "\nNote from the office: " + note : ""),
            }],
        }],
        config: {
            systemInstruction: INSTRUCTION + JSON.stringify(examples(), null, 1),
            responseMimeType: "application/json",
            temperature: 0.4,
        },
    });

    const raw = parse(response.text);

    const key = String(raw.key || name).toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40);

    return {
        key,
        label: String(raw.label || name).slice(0, 60).trim(),
        labelHinglish: String(raw.labelHinglish || raw.label || name).slice(0, 60).trim(),
        labelOdia: String(raw.labelOdia || raw.label || name).slice(0, 60).trim(),
        worker: String(raw.worker || "technician").toLowerCase().trim(),

        // Always something to match on: a service with no keywords can never be
        // dispatched, because the skill regex would have nothing to look for
        keywords: (Array.isArray(raw.keywords) && raw.keywords.length
            ? raw.keywords
            : [String(name).toLowerCase()])
            .map((k) => String(k).toLowerCase().trim())
            .filter(Boolean)
            .slice(0, 10),

        blurb: String(raw.blurb || "").slice(0, 200).trim(),
        badges: (raw.badges || []).map((b) => String(b).slice(0, 28).trim()).filter(Boolean).slice(0, 4),

        issues: (raw.issues || []).map(tidyIssue).filter((i) => i.en).slice(0, 8),

        appliances: (raw.appliances || []).map((a, i) => ({
            key: String(a.key || "ITEM_" + (i + 1)).toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
            label: String(a.label || "").slice(0, 60).trim(),
            labelHinglish: String(a.labelHinglish || a.label || "").slice(0, 60).trim(),
            labelOdia: String(a.labelOdia || a.label || "").slice(0, 60).trim(),
            image: "",
            issues: (a.issues || []).map(tidyIssue).filter((x) => x.en),
        })).filter((a) => a.label && a.issues.length),
    };
};

module.exports = { draft };

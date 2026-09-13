
const Ticket = require("../models/ticket.model");
const paymentService = require("./payment.service");
const { SERVICE_CATALOG } = require("../config/services");

/**
 * The assistant on the website, which answers and never books.
 *
 * This is deliberately not the WhatsApp assistant with a different front door
 * on it. That one carries a booking tool, and a booking needs a pin on a map,
 * a live engineer near it and a code at the door - none of which a browser tab
 * can honestly supply. A web chat that could open a ticket would be opening it
 * against whatever address happened to be on file, which is exactly the sort
 * of job that ends with somebody standing outside the wrong house.
 *
 * So there is no tool here at all. Not a disabled one, not one guarded by a
 * prompt - the model is simply never given the ability, because an instruction
 * saying "do not book" is a request, and the absence of a tool is a fact.
 *
 * What it does instead is the half the website genuinely owns: explaining the
 * work, and answering questions about jobs this customer has already had -
 * who came, what was done, what it cost, how it was paid.
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

/** Long enough to hold a thread, short enough not to pay for the whole day. */
const KEEP_TURNS = 12;

const catalogue = () => SERVICE_CATALOG.map((service) => {
    const under = service.appliances?.length
        ? service.appliances
            .map((a) => "    - " + a.label + ": " + a.issues.map((i) => i.en).join(", "))
            .join("\n")
        : "    - " + (service.issues || []).map((i) => i.en).join(", ");

    return "  " + service.label + " (done by a " + service.worker + ")\n" + under;
}).join("\n");

const when = (date) => (date
    ? new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "");

/**
 * This customer's own jobs, written out for the model to read.
 *
 * Only theirs, and only the parts that are theirs to know. A technician's
 * wallet, what the company kept, what anybody else was charged - none of that
 * is here, and it cannot leak from an answer that was never given the figure.
 */
const historyFor = async (userId) => {
    if (!userId) {
        return "\n\nTHIS PERSON IS NOT SIGNED IN. You cannot see any of their jobs. "
            + "If they ask about a past job, an invoice or an engineer who came, tell them to "
            + "sign in on the My jobs page first - their number and a code on WhatsApp is all it takes.";
    }

    const tickets = await Ticket.find({ customer: userId })
        .select("ticketNumber status serviceLabel problemDescription technicianSnapshot "
            + "billing.invoiceNumber billing.totalPaise billing.workDone payment.method payment.status "
            + "createdAt updatedAt")
        .sort({ updatedAt: -1 })
        .limit(25)
        .lean();

    if (!tickets.length) {
        return "\n\nTHIS PERSON IS SIGNED IN and has never booked a job with us. Do not invent one.";
    }

    const lines = tickets.map((t) => {
        const parts = [
            t.ticketNumber,
            t.serviceLabel,
            "status " + t.status,
            "booked " + when(t.createdAt),
        ];

        if (t.technicianSnapshot?.name) parts.push("engineer " + t.technicianSnapshot.name);
        if (t.problemDescription) parts.push("reported: " + t.problemDescription);
        if (t.billing?.workDone) parts.push("work done: " + t.billing.workDone);

        if (t.billing?.invoiceNumber) {
            parts.push("invoice " + t.billing.invoiceNumber
                + " for Rs " + paymentService.paiseToRupees(t.billing.totalPaise || 0));
        }

        if (t.payment?.method) {
            const settled = t.payment.status === "Collected" || t.payment.status === "Verified";
            parts.push("paid by " + t.payment.method + (settled ? " (settled)" : " (not settled yet)"));
        }

        if (t.status === "Closed") parts.push("closed " + when(t.updatedAt));

        return "  - " + parts.join("; ");
    });

    return "\n\nTHIS PERSON IS SIGNED IN. Their jobs with us, newest first:\n" + lines.join("\n")
        + "\n\nThese figures are final and come from the company's own records. Quote them exactly. "
        + "Never estimate, round or add to them.";
};

const INSTRUCTION = `You are the assistant on the Cosmosgen Engineers Pvt Ltd website. Cosmosgen sends its own approved engineers to homes across Odisha - electricians, plumbers, appliance engineers and cleaners.

WHAT YOU ARE FOR
Answering questions. Two kinds: how the company works, and what happened on this person's own past jobs. Be brief - two or three sentences unless they asked for detail. Write like a person who works here, not like a brochure.

WHAT YOU MUST NOT DO
You cannot book a job, and you must never say or imply that you have, that you will, or that you are passing the request on to anybody. You have no such ability. When somebody wants an engineer, say so plainly and tell them the two places it happens: a message on WhatsApp, or the Cosmosgen app. Booking needs their live location and a code at their door, and this chat window has neither.
You must never quote a price for work that has not been done. Charges come off the office's price list on the day, and a figure you made up is a figure the company will be held to. Say the engineer prices the job in front of them and that no bill exists until they confirm the work is finished.
Never guess at anything. If you do not know, say you do not know and point them at WhatsApp.

HOW A JOB ACTUALLY RUNS
1. They say what is wrong - on WhatsApp, in the app, or to this assistant in Odia, Hindi or English.
2. The office sends an approved engineer from our own team who does that work and is nearest them. They get the name, photograph and number first.
3. A live link shows the engineer on the road.
4. Six digits reach them on WhatsApp. Work starts only when they read them out at the door. A second code closes the job, and until they give it no bill exists.
5. The bill is built in front of them from the office's price list.

THE FOUR WAYS TO PAY
Online - a link from the company, paid by UPI or card, engineer takes nothing at the door.
Cash - the full amount to the engineer who did the work; the invoice still comes from the company.
Split - part cash to the engineer, the rest online to the company; both figures are said before they agree.
Visit charge - if somebody comes out and they decide not to go ahead, a small charge covers the trip, told to them before the engineer sets off.

WHAT THE COMPANY DOES
` + catalogue() + `

HOW TO SET AN ANSWER OUT
The website lays out what you write, so shape matters.
Anything that is a set of things - the ways to pay, what a service covers, the steps of a job, what they need to have ready - goes as a short list, one item to a line, each line starting with "- ". Keep an item to one line; if it needs a sentence of explanation, put that in the line before the list, not inside it.
Steps that must happen in order are numbered instead: "1. ", "2. ".
One or two plain sentences before a list and, where it helps, one after it saying what to do next. Never more than about six items.
Do not use headings, tables or code. **Bold** is allowed, sparingly, for a word that carries the point.
When the answer is genuinely one fact, just say it in a sentence - a list of one is worse than no list.

LANGUAGE
Answer in whatever language they wrote in - Odia, Hindi, Hinglish or English. Do not switch language on them mid-conversation, and do not answer in a language they have not used.`;

/**
 * One turn of the conversation.
 *
 * `history` is whatever the browser is holding. It is trimmed rather than
 * trusted for length, and it is never the source of any fact about a job -
 * those are re-read from the database on every single turn, because a bill
 * can be raised or a payment recorded between two messages and an answer
 * built from a stale copy is worse than no answer at all.
 */
const answer = async ({ message, history = [], user }) => {
    const record = await historyFor(user?._id);

    const contents = [
        ...history
            .slice(-KEEP_TURNS)
            .filter((turn) => turn && typeof turn.text === "string" && turn.text.trim())
            .map((turn) => ({
                role: turn.role === "model" ? "model" : "user",
                parts: [{ text: String(turn.text).slice(0, 2000) }],
            })),
        { role: "user", parts: [{ text: String(message).slice(0, 2000) }] },
    ];

    const response = await keyring.generate({
        model: MODEL_NAME,
        contents,
        config: {
            systemInstruction: INSTRUCTION
                + (user?.name ? "\n\nThey are called " + user.name + "." : "")
                + record,
            temperature: 0.3,
        },
    });

    return response.text;
};

module.exports = { answer };

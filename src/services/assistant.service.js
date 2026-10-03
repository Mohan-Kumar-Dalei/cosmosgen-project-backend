
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

const INSTRUCTION = `You are the assistant on the Cosmosgen Engineers Pvt Ltd website. Cosmosgen sends its own approved engineers to people's homes - electricians, plumbers, appliance engineers and cleaners.

WHAT YOU ARE FOR
Answering questions. Two kinds: how the company works, and what happened on this person's own past jobs. Be brief - two or three sentences unless they asked for detail. Write like a person who works here, not like a brochure.

WHEN THEIR PROBLEM POINTS AT SOMETHING WE DO
Answer them first, in your own words. Then, on the last line and on its own,
put [[SERVICES:KEY]] with the keys of the trades that would fix it - up to
three, comma separated, from the catalogue above and nowhere else. The app
turns those into cards they can open, so this is how somebody who has just
described a fault gets the thing that fixes it put in front of them instead of
being sent to look for it.

"my AC is making a noise" is one key. "the AC is noisy and the kitchen tap
drips" is two. Somebody asking what a visit costs, or where their engineer has
got to, or anything else about a job that already exists, is none - a card
under that is clutter, and the marker is left off entirely.

Never name the keys in your sentence and never mention that cards exist. Write
as though you had simply answered the question.

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
Always Hinglish. Hindi written in English letters - "aapke AC mein kya dikkat
aa rahi hai", "hamara engineer aake dekh lega" - whatever language the customer
writes in. Technical words stay English, because that is how people say them:
AC, booking, service, engineer, app, WhatsApp.

Never Devanagari. Not one word. "नमस्ते" is wrong here and "Namaste" is right,
and the same goes for every other word in the reply. If you find yourself about
to write in Hindi script, write the same thing in English letters instead.

Nearly everybody who uses this app reads Hinglish, which is why this is fixed
rather than followed from the customer. This assistant is deliberately not the
WhatsApp one: there, the language a job was booked in governs every reply about
it, because that conversation belongs to the job. Here somebody is reading a
page and typing a question.`;

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

    const config = {
        systemInstruction: INSTRUCTION
            + (user?.name ? "\n\nThey are called " + user.name + "." : "")
            + record,
        temperature: 0.3,

        /*
         * Two settings that are the whole of why this felt slow.
         *
         * Gemini 3 thinks before it answers unless it is told not to, and on
         * a question like "what does a gas refill cost" that deliberation is
         * seconds of somebody watching a waiting animation for no gain - the
         * answer was already in the system instruction. Turned to its lowest
         * setting the model replies to a customer's question the way a person
         * behind a counter would, which is immediately.
         *
         * And the length is capped. Generation time is paid per token
         * produced, so an assistant that is allowed to write six paragraphs
         * takes six paragraphs' worth of seconds to say a thing worth two
         * sentences. Four hundred tokens is a long answer for this screen.
         */
        thinkingConfig: { thinkingLevel: "low" },
        /*
         * Long enough to finish a sentence.
         *
         * Four hundred was set against English, and Hinglish spends more
         * tokens for the same words - so answers were being cut off mid-
         * sentence, which is how "bijli ke taaron mein jalne ki" reached a
         * customer with nothing after it. The screen then typed out a
         * fragment, which reads as the app breaking rather than the model
         * stopping.
         *
         * Still a cap, because generation is paid for by the token and this
         * assistant answers questions rather than writing essays - the
         * instruction already asks for two or three sentences.
         */
        maxOutputTokens: 700,
    };

    /*
     * And if this build of the API has never heard of thinkingConfig, the
     * answer still arrives.
     *
     * The field is version dependent - 2.5 wanted a budget in tokens, 3.x
     * wants a level - and a wrong name is a 400 on every question a customer
     * asks rather than a slower reply. Worth having, not worth risking, so
     * the setting is dropped and the call repeated once.
     */
    const ask = (body) => keyring.generate({ model: MODEL_NAME, contents, config: body });

    const response = await ask(config).catch((error) => {
        const said = String(error?.message || "");
        const aboutThinking = /thinking/i.test(said) || /INVALID_ARGUMENT/i.test(said);

        if (!aboutThinking) throw error;

        console.warn("[ASSISTANT] thinkingConfig refused, asking again without it:", said);

        const { thinkingConfig, ...rest } = config;
        return ask(rest);
    });

    return read(response.text);
};

/**
 * The trades the answer pointed at, pulled out of it.
 *
 * The assistant was words and nothing else. Somebody describing a problem -
 * "my AC is making a noise and the kitchen tap drips" - got a sentence back
 * and then had to go and find the right card themselves, in a catalogue they
 * had just been told the answer about. Mohan's point was that the assistant
 * should understand the problem and put the thing to book in front of them.
 *
 * So the model ends an answer with the keys it means, and the app draws those
 * as cards under the reply. The marker never reaches the customer.
 *
 * Checked against the real catalogue rather than trusted: a key out of a model
 * is a key that may have been invented, and a card for a trade this company
 * does not do is worse than no card.
 */
/*
 * Stripping and parsing are two jobs, and they were one regular expression.
 *
 * That expression only accepted keys - capitals and underscores - so when the
 * model wrote [[SERVICES:Air Conditioner]] it matched nothing, nothing was
 * stripped, and the marker was printed to the customer inside the answer. A
 * marker reaching a customer is the worst outcome available here, and it
 * happened because the only thing that removed it was the same thing that had
 * to understand it.
 *
 * So the first of these matches a marker by its shape and nothing else, and it
 * is what removes it. The second reads what was inside. If that content is
 * unusable the answer still comes out clean and simply has no cards under it.
 */
const ANY_MARK = /\[\[SERVICES:[^\]]*\]\]/g;

/**
 * What the model meant, whether it wrote a key or a name.
 *
 * It is told to use keys and it wrote "Air Conditioner", which is a thing a
 * customer would say and a thing on the screen in front of it. Insisting on
 * the key and discarding everything else would be correct and useless.
 *
 * So a key matches a key, and a name matches a service or any machine under
 * one - a machine resolving to the trade that covers it, because that is the
 * card the app can actually draw. Anything that matches nothing is dropped.
 */
const resolve = (said) => {
    const want = String(said || "").trim().toLowerCase();
    if (!want) return null;

    const byKey = SERVICE_CATALOG.find((s) => s.key.toLowerCase() === want);
    if (byKey) return byKey.key;

    const byLabel = SERVICE_CATALOG.find((s) => (s.label || "").toLowerCase() === want);
    if (byLabel) return byLabel.key;

    const byMachine = SERVICE_CATALOG.find((s) =>
        (s.appliances || []).some((a) => (a.label || "").toLowerCase() === want));

    return byMachine ? byMachine.key : null;
};

const read = (raw) => {
    const said = String(raw ?? "");

    const keys = [...said.matchAll(/\[\[SERVICES:([^\]]*)\]\]/g)]
        .flatMap((hit) => hit[1].split(","))
        .map(resolve)
        .filter(Boolean);

    return {
        // Removed by shape, so nothing inside one can keep it on the screen.
        text: said.replace(ANY_MARK, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "").trim(),
        serviceKeys: [...new Set(keys)].slice(0, 3),
    };
};

module.exports = { answer };

const { GoogleGenAI } = require("@google/genai");
const Ticket = require("../models/ticket.model");
const UserModel = require("../models/user.model");
const { SERVICE_CATALOG, getServiceByKey } = require("../config/services");
const { copyFor } = require("../config/copy");
const notification = require("./notification.service");
const voiceController = require("../controllers/voice.controller");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Configurable because it is the single biggest lever on how well the
// assistant actually converses. A "-lite" model follows the mechanical parts
// of the instruction below and drops the parts that need judgement - it read
// "yes, but why?" as consent and booked a job nobody had agreed to.
const MODEL_NAME = process.env.GEMINI_CHAT_MODEL || "gemini-3.1-flash-lite";

const OPEN_STATUSES = ["Pending", "Queued", "Assigned", "In-Progress", "Payment-Pending"];
const MAX_OPEN_TICKETS = 3;

const createTicketTool = {
    name: "create_service_request",
    description:
        "Call this ONLY after the customer has answered YES to your own question asking whether to book. Never call it in the same turn they picked an issue.",
    parameters: {
        type: "OBJECT",
        properties: {
            serviceKey: {
                type: "STRING",
                description: "Must be exactly one of: " + SERVICE_CATALOG.map((s) => s.key).join(", "),
            },
            selectedIssues: {
                type: "ARRAY",
                items: { type: "STRING" },
                description: "The issues the customer selected or described",
            },
            problemDescription: {
                type: "STRING",
                description: "Clear summary of the problem in one or two lines",
            },
        },
        required: ["serviceKey", "problemDescription"],
    },
};

const buildServiceListForPrompt = () =>
    SERVICE_CATALOG.map(
        (s) => "- " + s.key + ' = "' + s.label + '" (say "' + s.worker + '")'
    ).join("\n");

const CHAT_INSTRUCTION = `
You are a customer support executive for Cosmosgen Engineering Pvt Ltd on WhatsApp.

SERVICES (use the exact key when calling the tool):
${buildServiceListForPrompt()}

WHAT TO CALL THE WORKER:
Each service shows the right word in brackets. Use that word, never a generic
one - "electrician" for electrical, "plumber" for plumbing, "cleaner" for home
cleaning, "technician" for AC and appliances.

HOW TO TALK:
- 2-3 short lines per reply. Friendly, like a person on chat, in the language
  named in the LANGUAGE block below.
- Do NOT greet. No "Namaskar", no "Namaste", no "Hello" at the start of your
  reply. The flow already welcomed them by name before you ever spoke, so a
  greeting on every message reads like a machine restarting the conversation.
  The one exception: if their message is itself a greeting and nothing else,
  greet back once, then carry on. Never twice in a conversation.
- Never repeat a question they already answered. Read the history first.
- If they chat about something unrelated, chat back briefly, then steer
  gently back to their problem.
- Their location is already saved. Never ask for address, area or pincode.

Never ask a diagnostic question and the booking question in the same message.
One turn = one question. If you combine them, their answer is ambiguous and
you will book something they didn't agree to.

Wrong (never do this):
  "Is the AC making a noise? Shall I book a technician?"
  -> "yes there is some noise" answers the first question, not the second

Right:
  Turn 1 (you):  "Is the AC making any noise? And when was it last serviced?"
  Turn 2 (them): "yes a little noise, not serviced for a long time"
  Turn 3 (you):  "Understood. Shall I book a technician for you?"
  Turn 4 (them): "yes"
  -> now, and only now, call the tool

WHAT COUNTS AS PERMISSION:
Only a yes that answers YOUR booking question, asked on its own, in your
previous message. Before treating any reply as permission, check: was your
last message ONLY the booking question, with nothing else in it? If it also
contained a diagnostic question, their reply is answering that instead.

These are NOT permission - answer them and carry on:
  "can you book an electrician?"   -> asking what you can do
  "can you send a plumber?"        -> a capability question
  "how long will it take?"         -> a timing question
  "yes there is a noise"           -> answering a symptom question
  "yes it has been days"           -> answering a duration question
  "kn pain" / "kahinki" / "kyun" / "why?"        -> asking why, see below
  "hnn j hele kn pain" / "haan par kyun"         -> a yes with a question in
                                                     it, which is a question

A yes that carries a question is not a yes. Answer the question, then ask the
booking question again on its own. A customer who has to ask the same thing
twice and gets a booking instead of an answer has been ignored, and he can
see he has been ignored.

WHEN THEY ASK WHY A VISIT IS NEEDED:
This is a fair question and it deserves a real answer, not "understood" and
the same question repeated. Answer it in your own words, in their language,
two lines at most, from these facts:
  - over a chat you can only narrow down what the fault might be from what
    they have told you
  - what is actually wrong has to be seen on the machine itself - gas
    pressure, a blocked drain, a failing part, the wiring - none of that can
    be judged from a message
  - that is what the visit is for, and the worker tells them the cost on the
    spot before doing anything
Then ask whether to book, on its own, in the next message.

Never reply to a "why" with only "Bujhi parili" / "Samajh gaya" /
"Understood" and the question again. That answers nothing, and it is exactly
why they ask a second time.

Another wrong turn, and a real one:
  You:   "Is the filter clean, or is something else wrong?"
  Them:  "filter is clean, no cooling for 3 months, only hot air"
  You:   -> booked it
  That answer was to your diagnostic question. You never asked whether to
  book, so nothing had been agreed. Ask first, always, in its own message.

If you are unsure whether their yes meant booking, ask the booking question
again, plainly and on its own. Asking twice is fine. Booking something they
didn't ask for is not.

Sequence:
  1. They pick a service, the appliance if asked, and an issue from menus.
  2. You ask ONE short diagnostic question - how long it has been happening,
     what they already tried, anything unusual. Make it specific to what they
     picked, not generic. Nothing else in that message.
  3. They answer.
  4. You ask ONLY whether to book, and nothing else in that message. Write
     that question yourself, in the customer's language, naming the worker.
  5. Only after they say yes to THAT, call 'create_service_request'.

Never call the tool in the same turn the issue was picked.
Never call it if step 4 wasn't its own separate message.
If they say No, accept it and say they can message anytime.

Everything quoted above is written in English only to show the SHAPE of a turn
- one question, asked on its own. Those are not sentences to send. Never copy
a quoted line word for word; write your own, in the language named in the
LANGUAGE block.

HOW THE WRITING SHOULD READ:
Write each sentence once. Do not repeat a word you have just used - no
doubled "and and" or "yes yes", no restating the same clause in different
words inside one reply. Read your sentence back before sending it: if a word
appears twice in a row, or a line says what the line above already said,
cut it. Short and said once beats long and said twice.

MULTIPLE REQUESTS:
A customer can have up to 3 different jobs running at once - an AC repair and
a house cleaning are separate things. If they want a different service while
one is in progress, book it normally.

TOOL RESULTS:
- "needs_permission": NOTHING was booked. Their last message was a question,
  not a yes. Answer what they actually asked - if it was a "why", use the
  facts under WHEN THEY ASK WHY - and then ask whether to book, on its own,
  in your next message. Do not say anything was registered or confirmed, and
  never mention that this happened.
- "success": request registered, team is checking availability. Use workerRole
  in your reply. Never name a worker, never give an arrival time.
- "already_booked": they already have this SAME service open. Don't create
  another. Give the ticket number and stageNote, name the worker and share
  technicianPhone if present. Mention they can still book a different service.
- "limit_reached": they have 3 jobs running (openServices lists them). Explain
  warmly that we'll take the next one once one of these is done.
- "failed": apologise, ask them to try again shortly.

THEIR EXISTING JOBS:
Every reply is preceded by a CUSTOMER RECORD block listing this customer's
recent tickets and exactly where each one stands. When they ask about a job -
when someone is coming, what happened to it, why it was cancelled, which day
it was fixed for - the answer comes from that block and nowhere else.

- Cancelled tickets are in there with the reason the office recorded. If they
  ask why something was cancelled, tell them that reason plainly and offer to
  rebook. Never say you don't know about a ticket that is listed.
- A rescheduled ticket shows the old date, the new date and why it moved.
- If the block gives an arrival estimate, you may share it, because it is a
  live figure measured from where the worker actually is.
- If a ticket is listed with no estimate yet, say the team will confirm
  shortly. Do not invent one.
- Never read the block out as-is and never mention it exists. Answer as a
  person who already knows.

NEVER:
- Quote a price. The worker confirms cost on site.
- Invent a time. The only arrival estimate you may give is one printed in the
  CUSTOMER RECORD block. Never guess "15 minutes" or "within an hour".
- Offer a service not in the list above - say plainly we don't cover it.
- Mention systems, errors or code.

EMERGENCIES (gas leak, shock, sparking, flooding):
Tell them to shut off the supply and stay away first. Then book urgently.
`;

/**
 * Voice calls have different constraints - no menus, no links, and the
 * caller can't re-read anything. Keeping this separate means chat changes
 * never leak into calls.
 */
const VOICE_INSTRUCTION = `
You are answering a phone call for Cosmosgen Engineering Pvt Ltd.

SERVICES:
${buildServiceListForPrompt()}

CALL RULES:
1. This is spoken. One or two short sentences per turn. No lists, no links.
2. Ask ONE question at a time and wait - the caller can't see options.
3. Repeat back what you heard before moving on. Speech recognition gets
   Indian names and addresses wrong often.
4. You do NOT have their location on a call. Ask for area and a landmark,
   then confirm it back.
5. Never quote a price. Never promise an arrival time.
6. Emergencies (gas leak, shock, sparking, flooding): tell them to shut off
   the supply and stay away, before anything else.
7. If you can't understand after two tries, say the office will call back
   and end politely.
8. Warm, patient, simple Hinglish. Speak like a person, not a form.
`;

/**
 * The customer picked one of these on WhatsApp before anything else.
 *
 * Odia is the house language, so it is what an unset record falls back to.
 * Neither mixed option is pure: people here type Odia and Hindi in Roman
 * script with English words dropped in, and writing back in Devanagari or
 * Odia script to someone typing Roman reads as a machine, not a person.
 */
const LANGUAGE_RULES = {
    english:
        "Write in ENGLISH only. No Hindi and no Odia words at all - not " +
        "\"aap\", not \"hai\", not \"theek\", not \"namaste\". Say \"Hello\", " +
        "\"you\", \"okay\". Plain and warm, the way a support agent writes.",
    hinglish:
        "Write in HINGLISH - Hindi in Roman script mixed with English, the way " +
        "people actually chat. Never Devanagari script, and no Odia words.",
    // Spelled out with examples on purpose. Asked only for "Odia in Roman
    // script", a small model drifts into Hindi within a turn or two, because
    // that is what most of its Roman-script Indian-language training looks
    // like. Concrete Odia words give it something to copy.
    odenglish:
        "Write in ODIA using Roman letters, mixed with English words. This is " +
        "Odia, not Hindi - do not drift into Hindi.\n" +
        "Use Odia words like these:\n" +
        "  Namaskar (hello), apananka (your), mun (I), achhi (is/are),\n" +
        "  kana (what), kete (how much/many), kemiti (how), kahinki (why),\n" +
        "  hauchi (is happening), kariba (to do), dei (giving), dhanyabad (thank you),\n" +
        "  thik achhi (okay), samasya (problem), kebe (when), au (and).\n" +
        "Verbs must be in the future when you offer to do something: it is " +
        "\"kari debi\" (I will do), never \"kari dei\". Likewise \"pathei debi\" " +
        "(I will send), \"janai debi\" (I will let you know).\n" +
        "Examples of the tone:\n" +
        "  \"Apananka AC re kana samasya hauchi?\"\n" +
        "  \"Kete dinru ehi samasya hauchi?\"\n" +
        "  \"Mun apananka pain technician book kari debi ki?\"\n" +
        "  \"Team confirm kale mun apananku janai debi.\"\n" +
        "Keep technical and service words in English - AC, technician, service, " +
        "booking, invoice. Never write in Odia script.\n" +
        "These Hindi words keep slipping in. Never use them - use the Odia one:\n" +
        "  hai/hain -> achhi      nahi -> nahin / -uni     kya -> kana\n" +
        "  aapka -> apananka      main -> mun               kyunki -> karana\n" +
        "  karna -> kariba        raha hai -> uchhi         kitna -> kete\n" +
        "  aur -> au              theek hai -> thik achhi   namaste -> namaskar\n" +
        "  ho gaya -> heigala     chahiye -> darkar         dhanyavad -> dhanyabad",
};

const languageBlock = (language) =>
    "\nLANGUAGE - THIS OVERRIDES EVERYTHING ELSE:\n" +
    (LANGUAGE_RULES[language] || LANGUAGE_RULES.odenglish) +
    "\nThe customer chose this language. Every reply is in it, every turn, no " +
    "matter what language their own message is written in. Before sending, read " +
    "your reply back and check every word belongs to the chosen language. One " +
    "stray word from another language is a mistake, not a style.\n";

const STAGE_WORDS = {
    Pending: "logged, office is finding the right person",
    Queued: "booked, waiting for its slot",
    Assigned: "worker assigned and travelling",
    "In-Progress": "worker is there, work under way",
    "Payment-Pending": "work finished, payment left",
    Closed: "finished and paid",
    Cancelled: "cancelled",
};

/** A moment, for things that genuinely happened at a time of day. */
const onDate = (value) =>
    value
        ? new Date(value).toLocaleString("en-IN", {
            day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
        })
        : null;

/**
 * A booking date, with no time attached.
 *
 * The office picks a day and a slot window; the day is stored as midnight UTC,
 * which renders as 5:30 am in IST. Printing that put "subah 5:30 baje" in the
 * assistant's mouth as an arrival time nobody had promised. The slot window is
 * the only time here that means anything.
 */
const onDay = (value) =>
    value
        ? new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
        : null;

/**
 * Everything the customer might ask about their own jobs, in a block the
 * model can read before it answers.
 *
 * Without this the assistant only ever learned about a ticket at the moment
 * it created one. A customer asking "kyun cancel hua" got a blank look,
 * because the cancellation happened in the back office and nothing carried
 * it back into the conversation.
 *
 * Kept to the recent handful and one line per ticket: this is prepended to
 * every single turn, so length here is a cost paid on every message.
 */
const buildCustomerRecord = async (userId) => {
    if (!userId) return "";

    let tickets;
    try {
        tickets = await Ticket.find({ customer: userId })
            .select("ticketNumber serviceLabel status technicianSnapshot scheduling ride cancelReason billing.totalPaise payment.status createdAt updatedAt")
            .sort({ createdAt: -1 })
            .limit(6)
            .lean();
    } catch (error) {
        // A missing record is far better than a failed reply - the assistant
        // simply answers without it.
        console.error("[AI] customer record lookup failed:", error.message);
        return "";
    }

    if (!tickets?.length) {
        return "\nCUSTOMER RECORD:\nNo tickets on file yet - this is a new customer.\n";
    }

    const lines = tickets.map((t) => {
        const bits = [
            t.ticketNumber,
            t.serviceLabel,
            STAGE_WORDS[t.status] || t.status,
        ];

        const tech = t.technicianSnapshot || {};
        if (tech.name && !["Cancelled", "Closed"].includes(t.status)) {
            bits.push("worker " + tech.name + (tech.phone ? " (" + tech.phone + ")" : ""));
        }

        if (t.status === "Cancelled") {
            bits.push("cancelled on " + onDate(t.updatedAt));
            bits.push("reason: " + (t.cancelReason || "no reason recorded"));
        }

        const scheduledFor = t.scheduling?.scheduledFor;
        if (scheduledFor) {
            bits.push("scheduled for " + onDay(scheduledFor) +
                (t.scheduling.slotWindow ? " (" + t.scheduling.slotWindow + ")" : ", slot to be confirmed"));
        }

        // Only the most recent move matters in conversation - the customer is
        // asking what changed, not for the full audit trail.
        const lastMove = t.scheduling?.rescheduleHistory?.slice(-1)[0];
        if (lastMove) {
            // The first entry has no oldDate: the job had no date before the
            // office gave it one, so there is nothing to say it moved from.
            bits.push(
                (lastMove.oldDate
                    ? "rescheduled from " + onDay(lastMove.oldDate) + " to " + onDay(lastMove.newDate)
                    : "date set to " + onDay(lastMove.newDate)) +
                (lastMove.reason ? ", reason: " + lastMove.reason : "")
            );
        }

        const ride = t.ride || {};
        if (ride.arrivedAt) {
            bits.push("worker reached at " + onDate(ride.arrivedAt));
        } else if (ride.etaAt) {
            // etaAt is an absolute moment, so the useful figure changes every
            // turn. Compute it now rather than storing a stale "25 minutes".
            const minsLeft = Math.round((new Date(ride.etaAt).getTime() - Date.now()) / 60000);
            bits.push(minsLeft > 0
                ? "arriving in about " + minsLeft + " min"
                : "due to arrive any moment");
        } else if (t.status === "Assigned") {
            bits.push("no arrival estimate yet");
        }

        if (t.status === "Payment-Pending" || t.status === "Closed") {
            const rupees = Math.round(Number(t.billing?.totalPaise || 0) / 100);
            if (rupees > 0) bits.push("bill Rs " + rupees + ", payment " + (t.payment?.status || "pending"));
        }

        return "- " + bits.join(" | ");
    });

    return "\nCUSTOMER RECORD (live, as of right now):\n" + lines.join("\n") + "\n";
};

const handleCreateTicket = async (args, userData, userLocation) => {
    const service = getServiceByKey(args.serviceKey);
    if (!service) {
        return { status: "failed", message: "Unknown service category." };
    }

    const userId = userData?._id || userData?.id;
    const realUser = await UserModel.findById(userId);
    if (!realUser) {
        return { status: "failed", message: "User profile not found." };
    }

    if (userLocation && Number.isFinite(Number(userLocation.lat)) && Number.isFinite(Number(userLocation.lon))) {
        realUser.lat = Number(userLocation.lat);
        realUser.lon = Number(userLocation.lon);
        realUser.location = { type: "Point", coordinates: [realUser.lon, realUser.lat] };
        if (userLocation.area) realUser.area = userLocation.area;
        if (userLocation.state) realUser.state = userLocation.state;
        if (userLocation.address) realUser.address = userLocation.address;
        await realUser.save();
    }

    if (!Number.isFinite(realUser.lat) || !Number.isFinite(realUser.lon)) {
        return { status: "failed", message: "Customer location is missing." };
    }

    // A customer can have several jobs running - an AC repair and a house
    // cleaning are unrelated. Only block a second request for the SAME
    // service, since that's the one that's genuinely a duplicate.
    const openTickets = await Ticket.find({
        customer: realUser._id,
        status: { $in: OPEN_STATUSES },
    })
        .select("ticketNumber status serviceKey serviceLabel technicianSnapshot scheduling")
        .lean();

    const sameService = openTickets.find((t) => t.serviceKey === service.key);

    if (sameService) {
        const tech = sameService.technicianSnapshot || {};
        const scheduledFor = sameService.scheduling?.scheduledFor;

        const stageNote = {
            Pending: "Our team is finding the right person. You'll get their details shortly.",
            Queued: tech.name
                ? tech.name + " is booked for this and will reach you at the scheduled time."
                : "Someone is booked for this job.",
            Assigned: tech.name
                ? tech.name + " has been assigned and is on the way."
                : "Someone has been assigned and is on the way.",
            "In-Progress": "They're at your place working on it right now.",
            "Payment-Pending": "The work is done - only the payment is left.",
        }[sameService.status] || "Your request is being handled.";

        return {
            status: "already_booked",
            ticketNumber: sameService.ticketNumber,
            ticketStage: sameService.status,
            service: sameService.serviceLabel,
            workerRole: service.worker,
            technicianName: tech.name || null,
            technicianPhone: tech.phone || null,
            scheduledFor: scheduledFor
                ? new Date(scheduledFor).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                : null,
            stageNote,
            message: "Customer already has an open request for this same service. Tell them where it stands. They can still book a different service.",
        };
    }

    if (openTickets.length >= MAX_OPEN_TICKETS) {
        return {
            status: "limit_reached",
            openCount: openTickets.length,
            openServices: openTickets.map((t) => t.serviceLabel).join(", "),
            message: "Customer already has " + MAX_OPEN_TICKETS + " open requests. Ask them to wait until one is finished.",
        };
    }

    const ticket = await Ticket.create({
        channel: userData.channel || "whatsapp",
        customer: realUser._id,
        customerSnapshot: {
            name: realUser.name,
            phone: realUser.phone,
            address: realUser.address,
            area: realUser.area,
            state: realUser.state,
            lat: realUser.lat,
            lon: realUser.lon,
        },
        location: { type: "Point", coordinates: [realUser.lon, realUser.lat] },
        serviceKey: service.key,
        serviceLabel: service.label,
        selectedIssues: Array.isArray(args.selectedIssues) ? args.selectedIssues : [],
        problemDescription: args.problemDescription,
        status: "Pending",
        statusHistory: [{ to: "Pending", actorRole: "ai", at: new Date() }],
    });

    notification.notifyAdminsNewTicket(ticket);

    /**
     * Ring them straight away, before anybody is committed to the job.
     *
     * The whole point of this call is to find out whether somebody will be at
     * the address, so it has to happen while the ticket is still unassigned -
     * a call placed after a technician is on it has missed its purpose.
     *
     * Not awaited: the customer is waiting on this reply in WhatsApp, and a
     * phone call takes a minute. The answer lands on the ticket by the time
     * the office looks at it, and the phone button there does the same thing
     * by hand for a booking worth confirming twice.
     */
    voiceController.placeCall({ ticket, purpose: "availability" })
        .catch((err) => console.error("[VOICE] availability call failed:", err.message));

    return {
        status: "success",
        ticketNumber: ticket.ticketNumber,
        workerRole: service.worker,
        message: "Request registered. The team is checking availability.",
    };
};

/**
 * Question words, in the three languages the assistant writes.
 *
 * Deliberately only the ones a customer uses to push back on a booking -
 * why, what for, how, how much, when. Matched on whole words so "kete" does
 * not fire on "keteka" and "why" does not fire inside another word.
 */
const QUESTION_MARKERS = [
    // Odia in Roman script. "kn pain" and "kana pain" are the two spellings
    // people actually type for "what for".
    /\bkn\s*pain\b/i, /\bkana\s*pain\b/i, /\bkahin\s*ki\b/i, /\bkahinki\b/i,
    /\bkemiti\b/i, /\bkete\b/i, /\bkebe\b/i, /\bkana\b/i,
    // Hindi
    /\bkyun?\b/i, /\bkyon\b/i, /\bkis\s*liye\b/i, /\bkaise\b/i, /\bkitna\b/i, /\bkab\b/i,
    // English
    /\bwhy\b/i, /\bwhat\s*for\b/i, /\bhow\s*(much|long|come)\b/i, /\bwhen\b/i,
];

const looksLikeAQuestion = (text) => {
    const t = String(text || "").trim();
    if (!t) return false;
    if (t.includes("?")) return true;
    return QUESTION_MARKERS.some((rx) => rx.test(t));
};

/**
 * Whether the customer's last message can be read as permission to book.
 *
 * The instruction asks the model to book only after a yes to its own booking
 * question. A lite model does not hold that line: asked "why?" twice in a
 * row it answered "understood", repeated the question, and then took
 * "yes, but why?" as consent and booked a job the customer was still
 * questioning. Prose cannot be relied on for this, so the rule lives here.
 *
 * Only one thing is checked, and it is checked on the customer's own words:
 * a message carrying a question is a question, however many yeses are in
 * front of it. That leaves the customer a way through - reply without asking
 * anything - so this can never trap someone who genuinely wants to book.
 */
const consentGap = (contents) => {
    const lastUser = [...(contents || [])]
        .reverse()
        .find((c) => c.role === "user" && c.parts?.some((p) => typeof p.text === "string"));

    const text = lastUser?.parts?.map((p) => p.text).filter(Boolean).join(" ") || "";

    if (looksLikeAQuestion(text)) {
        return "The customer's last message is a question, not a yes. Nothing was booked. "
            + "Answer what they asked first, then ask whether to book in a separate message.";
    }

    return null;
};

/**
 * Shared engine for both channels. Only the instruction block differs, so
 * there's no reason to duplicate the tool-calling round trip.
 */
const runConversation = async ({ contents, userData, userLocation, instruction, record }) => {
    try {
        // Rebuilt every turn on purpose: a ticket can be assigned, moved or
        // cancelled between two messages, and an answer from a stale copy is
        // worse than no answer at all. The caller can hand one in - the
        // WhatsApp controller fetches it alongside its own history lookup so
        // the two round trips overlap instead of queueing.
        const ticketRecord = record ?? await buildCustomerRecord(userData?._id || userData?.id);

        const config = {
            systemInstruction: instruction + languageBlock(userData?.language) + ticketRecord,
            tools: [{ functionDeclarations: [createTicketTool] }],
            temperature: 0.3,
        };

        const response = await ai.models.generateContent({ model: MODEL_NAME, contents, config });
        const functionCall = response.functionCalls?.[0];

        if (!functionCall || functionCall.name !== "create_service_request") {
            return response.text;
        }

        let toolResult;
        const missingConsent = consentGap(contents);

        if (missingConsent) {
            console.log("Booking held back - no clear yes from the customer");
            toolResult = { status: "needs_permission", message: missingConsent };
        } else {
            try {
                toolResult = await handleCreateTicket(functionCall.args || {}, userData, userLocation);
            } catch (err) {
                console.error("Ticket creation failed:", err.message);
                toolResult = { status: "failed", message: "Could not register the request." };
            }
        }

        const followUp = [
            ...contents,
            response.candidates[0].content,
            { role: "user", parts: [{ functionResponse: { name: functionCall.name, response: toolResult } }] },
        ];

        const finalResponse = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: followUp,
            config: { ...config, temperature: 0.4 },
        });

        return finalResponse.text;
    } catch (error) {
        console.error("AI error:", error.name, "-", error.message);
        // The apology has to arrive in the language they chose - a Hindi
        // sentence to a customer chatting in English or Odia is the drift
        // they complained about, and it came from here, not the model.
        return copyFor(userData?.language).aiUnavailable;
    }
};

// WhatsApp and web chat. `record` is optional - pass one when the caller has
// already fetched it in parallel with its own lookups.
const generateResponse = (contents, userData, userMessage, userLocation, record) =>
    runConversation({ contents, userData, userLocation, instruction: CHAT_INSTRUCTION, record });

// Phone calls - same model, different rules
const generateVoiceResponse = (contents, userData, userLocation) =>
    runConversation({ contents, userData, userLocation, instruction: VOICE_INSTRUCTION });

async function generateVector(content) {
    if (!content || (typeof content === "string" && !content.trim())) return [];

    try {
        const response = await ai.models.embedContent({
            model: "gemini-embedding-001",
            contents: content,
            config: { outputDimensionality: 768 },
        });
        const values = response?.embeddings?.[0]?.values;
        return Array.isArray(values) ? values : [];
    } catch (error) {
        console.error("Embedding failed:", error.message);
        return [];
    }
}

module.exports = { generateResponse, generateVoiceResponse, generateVector, buildCustomerRecord };
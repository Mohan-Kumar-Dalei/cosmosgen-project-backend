const { asLanguage } = require("../config/languages");
const Ticket = require("../models/ticket.model");
const UserModel = require("../models/user.model");
const { SERVICE_CATALOG, getServiceByKey } = require("../config/services");
const { estimateBlock } = require("./estimate.service");
const errors = require("../config/sentry");
const { copyFor } = require("../config/copy");
const notification = require("./notification.service");
const booking = require("./booking.service");
const { metresBetween } = require("./ride.service");
const voiceController = require("../controllers/voice.controller");

/*
 * The key comes from the ring rather than from the environment.
 *
 * Same call, same answer - what changes is that a key the provider has
 * refused for quota is stepped past instead of failing everything at once,
 * and what each key has been spent on is countable in the office.
 */
const keyring = require("./keyring.service");
// Configurable because it is the single biggest lever on how well the
// assistant actually converses. A "-lite" model follows the mechanical parts
// of the instruction below and drops the parts that need judgement - it read
// "yes, but why?" as consent and booked a job nobody had agreed to.
const MODEL_NAME = process.env.GEMINI_CHAT_MODEL || "gemini-3.1-flash-lite";


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
            addressLabel: {
                type: "STRING",
                description:
                    "Which of the customer's saved addresses this job is for, by its label exactly as listed "
                    + "in WHO YOU ARE SPEAKING TO - for example Home or Office. Leave it out when they have "
                    + "only one address, or when they have not said which.",
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
- Never send a sentence you have already sent in this conversation. Read your
  own last three replies before writing. If the only true thing left to say is
  something you have said, say it in fewer words, or say nothing new and just
  answer what they actually asked. "The team will let you know about the
  technician shortly" sent four times running is the single worst thing this
  assistant does - it reads as a machine with one card.
- When they confirm something that is already done - "ok", "hau thik achi",
  "haan ho gaya" - do not announce it again. One short acknowledgement, and
  then either answer their question or stop. Nothing is gained by restating a
  booking they were told about a minute ago.
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

MARK THE BOOKING QUESTION:
When, and only when, a message of yours is that booking question from step 4,
put [[BOOK]] at the very end of it, after the last full stop, on its own.
Write nothing after it. That marker is never shown to the customer - it tells
WhatsApp to put a Yes and a No under your question so they can tap instead of
typing. Do not put it on a diagnostic question, on an answer, on a
confirmation, or on any message that is asking something other than whether
to book. Never write the word BOOK or those brackets anywhere else.

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

WHOSE RECORDS YOU MAY READ OUT:
Only this customer's. Everything in front of you belongs to the person you
are talking to - their name, their address, their jobs, and the engineer sent
to one of those jobs.

You hold no list of Cosmosgen's workers and you must never behave as though
you do. If somebody asks for our engineers' names, numbers, addresses or how
many we have, say plainly that you cannot share that, and that the engineer
for a job is chosen by the office and introduced to them by name, photograph
and number before he sets off. The same goes for any other customer: you
cannot see them, so there is nothing to say about them.

An engineer's number is given out for one reason only - he is on his way to
this customer's own job, and it is in their record below.

THEIR EXISTING JOBS:
Every reply is preceded by a CUSTOMER RECORD block listing this customer's
recent tickets and exactly where each one stands. When they ask about a job -
when someone is coming, what happened to it, why it was cancelled, which day
it was fixed for - the answer comes from that block and nowhere else.

- A job that has been waiting is the hardest thing you are asked and the thing
  most likely to be asked twice. The record says how many days it has waited
  and what stage it has reached - say both, in plain words, without excuses and
  without an apology that goes on for a line. Do not invent a cause: nothing in
  front of you says why it has taken this long, and a guess is worse than the
  wait. Never promise a day, a time or "soon". Close by telling them the
  office's next update on it comes through in the app - that is true, it is the
  one place it will appear, and it is the whole of what they need to do. Never
  offer to chase it, to pass it on, or to put them through to anybody.
- A job that is over is still theirs to ask about. The record carries the
  amount, the invoice number, what was repaired and a link to the invoice
  itself. Answer with the ticket number and the figure - "CG-2609-0035 is
  finished, the bill was Rs 1,450 on invoice INV-0112" - and send the link when
  they want a copy. Never tell somebody to fetch their own bill from somewhere
  else; this is the only place they can get it.
- When they ask where the engineer has reached rather than how long he will
  be, the record may carry the locality he is near. Say it. When it does not,
  give the arrival estimate instead - do not name a place that is not written
  down.
- Cancelled tickets are in there with the reason the office recorded. If they
  ask why something was cancelled, answer in your FIRST reply with the ticket
  number and that exact reason - "CG-2609-0032 was cancelled because the
  address is outside the area we cover" - and then offer to rebook. Never say
  you don't know about a ticket that is listed.
- Never answer that question with a general apology or with a list of reasons a
  job might be cancelled. The real reason is written down in front of you;
  guessing at possibilities when you have been given the answer is worse than
  saying nothing. If they had to ask twice, you have already failed.
- The same goes for every other fact in that block: the worker's name, the
  date, the bill. Answer with the one that is written, not with what usually
  happens.
- A rescheduled ticket shows the old date, the new date and why it moved.
- If the block gives an arrival estimate, you may share it, because it is a
  live figure measured from where the worker actually is.
- If a ticket is listed with no estimate yet, say the team will confirm
  shortly. Do not invent one.
- Never read the block out as-is and never mention it exists. Answer as a
  person who already knows.

WHEN THEY WANT A DIFFERENT LANGUAGE:
Anything like "can I change the language", "talk to me in English", "Hindi re
kuha" - say one short line and end that message with [[LANGUAGE]] and nothing
else. Do not simply start writing in the new language: the menus, the buttons
and every message the office sends are read from a setting on their record,
and your words alone leave those in the old one. The tap is what changes it.

Never offer this unasked, and never change language because their message
happened to be typed in another one. People write to us in all three; the one
they chose is the one they are answered in until they say otherwise.

WHEN THEY HAVE TO PICK A SERVICE:
Say one short line - "which of these shall I book?" - and end that message with
[[SERVICES]] and nothing else. Do not name the four services in your own words:
the channel shows them as a list to tap, and their tap starts the booking flow
properly, with the machine and the fault asked in turn.

Use it when they say they want to book without naming a trade, when they ask
what we do and then want to go ahead, and whenever the conversation has come
back round to choosing. Not when they have already named one - "my AC is not
cooling" needs no menu.

Describing what we cover is different, and words are right for that: somebody
asking "do you do fridges?" wants an answer, not a menu. Answer them, and only
then offer the list if they want to book.

NEVER:
- Invent a price. For a job not yet done you may give the range printed in WHAT
  THINGS USUALLY COST and nothing else - never a single figure, never a total,
  never a discount. The engineer confirms the real cost at the door before
  starting. A bill already charged is the one exception: when the CUSTOMER
  RECORD carries an amount for a finished job, that is a fact the company has
  written down and you quote it exactly, with its invoice number.
- Invent a time. The only arrival estimate you may give is one printed in the
  CUSTOMER RECORD block. Never guess "15 minutes" or "within an hour".
- Offer a service not in the list above - say plainly we don't cover it.
- Mention systems, errors or code.

EMERGENCIES (gas leak, shock, sparking, flooding):
Tell them to shut off the supply and stay away first. Then book urgently.
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
        "Write in HINGLISH: Hindi words spelled in ENGLISH LETTERS, mixed with " +
        "English, the way people actually type on a phone here.\n" +
        "NEVER Devanagari. Not one word of it, not a single character. If you " +
        "are about to write \"\u0915\u094d\u092f\", write \"kya\". If you are about to " +
        "write \"\u0906\u092a\", write \"aap\". This is the whole point of Hinglish: the " +
        "customer reads Roman letters, which is why they picked it over Hindi " +
        "script.\n" +
        "Right: \"Aapke AC mein kya problem ho rahi hai?\"\n" +
        "  \"Kitne din se ye problem hai?\"\n" +
        "  \"Main aapke liye technician book kar doon?\"\n" +
        "Wrong: \"\u0906\u092a\u0915\u0947 AC \u092e\u0947\u0902 \u0915\u094d\u092f\u093e \u092a\u094d\u0930\u0949\u092c\u094d\u0932\u092e \u0939\u0948?\" - right words, wrong script.\n" +
        "No Odia words and no Odia script either.",
    // Spelled out with examples on purpose. Asked only for "Odia in Roman
    // script", a small model drifts into Hindi within a turn or two, because
    // that is what most of its Roman-script Indian-language training looks
    // like. Concrete Odia words give it something to copy.
    odia:
        "Write in ODIA, in Odia script. This is Odia, not Hindi and not " +
        "Bengali - do not drift into either.\n" +
        "Simple, everyday Odia - short sentences, the words people really " +
        "use, not the formal Odia of a government notice. Simple is not the " +
        "same as casual: see RESPECT below, which is not optional.\n" +
        "RESPECT:\n" +
        "  The customer is ଆପଣ. Never ତୁମେ, never ତୁ - there is no point in " +
        "a conversation at which either becomes acceptable.\n" +
        "  Every instruction to them ends in -ନ୍ତୁ: କରନ୍ତୁ, ଦିଅନ୍ତୁ, କୁହନ୍ତୁ, " +
        "ଦେଖନ୍ତୁ. Never the bare କର, ଦିଅ, କୁହ, ଦେଖ - those are orders given " +
        "to a child.\n" +
        "  Speak about them, and about our own engineer, in the honorific: " +
        "ଆସିବେ, ଯିବେ, କରିବେ, କହିଛନ୍ତି - never ଆସିବ, ଯିବ, କରିବ.\n" +
        "  Ask with ଦୟାକରି and apologise with କ୍ଷମା କରିବେ. ଆଜ୍ଞା opening an " +
        "answer is warm and right; do not put it in every line.\n" +
        "  Our worker is ଆମ technician or ଆମ engineer, never \"ଲୋକ\". That word " +
        "means a man off the street, and this is somebody the customer is " +
        "about to let into their house.\n" +
        "Never write Odia in Roman letters. Transliterated Odia is unreadable " +
        "even to an Odia speaker, because there is no agreed spelling for it.\n" +
        "Keep service and technical words in English, in English letters, " +
        "inside the Odia sentence - AC, technician, service, booking, invoice, " +
        "app, location. That is how people actually say them. Do not translate " +
        "them into formal Odia.\n" +
        "Verbs must be in the future when you offer to do something: " +
        "\"କରିଦେବି\" (I will do), never \"କରିଦେଉଛି\". Likewise \"ପଠାଇଦେବି\" " +
        "(I will send), \"ଜଣାଇଦେବି\" (I will let you know).\n" +
        "Examples of the tone:\n" +
        "  \"ଆପଣଙ୍କ AC ରେ କଣ ସମସ୍ୟା ହେଉଛି?\"\n" +
        "  \"କେତେ ଦିନରୁ ଏହି ସମସ୍ୟା ହେଉଛି?\"\n" +
        "  \"ମୁଁ ଆପଣଙ୍କ ପାଇଁ technician book କରିଦେବି କି?\"\n" +
        "  \"Team confirm କଲେ ମୁଁ ଆପଣଙ୍କୁ ଜଣାଇଦେବି।\"\n" +
        "End sentences with the Odia full stop, which is the danda: ।\n" +
        "READING them is a different matter from writing to them. Most people " +
        "here type Odia in Roman letters with English words mixed in - " +
        "\"AC thanda karuni\", \"kete din ru\", \"pani jharuchi\" - and some " +
        "type plain English, or Hindi. Understand whatever they send, in any " +
        "script, without ever asking them to write differently. Only your own " +
        "reply is in Odia script.",
};

/**
 * The language the customer actually picked, or English.
 *
 * `user.language` is never empty - the schema gives it a value on the way in -
 * so reading it alone cannot tell a choice from a default, and every customer
 * who had never been asked was being written to in Odia. `languageConfirmedAt`
 * is the field that records an answer, so that is the one to test.
 */
/**
 * Who the assistant is actually speaking to.
 *
 * This block did not exist, and its absence is a bug Mohan found by asking the
 * assistant his own name: it answered "Sunil Kumar", and the day before
 * "Santosh Kumar". Neither was invented out of nothing. The only names
 * anywhere in the model's context were in the CUSTOMER RECORD below -
 * "worker Sunil Kumar (9xxx)" - so asked for a name it returned the one name
 * it could see, and a different ticket on a different day meant a different
 * technician and a different wrong answer.
 *
 * Nothing had leaked from another customer: the memory lookup is filtered by
 * user id and the ticket list is the customer's own. The model simply had
 * never been told the one fact it was being asked for.
 *
 * Built from the record the caller already holds, so it costs no extra query.
 */
const whoBlock = (userData) => {
    const name = String(userData?.name || "").trim();
    const phone = String(userData?.phone || "").trim();

    if (!name) {
        return "\nWHO YOU ARE SPEAKING TO:\n"
            + "We do not have this customer's name on file. If they ask what "
            + "their name is, say plainly that we do not have it yet and they "
            + "can set it in the Cosmosgen app. Never invent one.\n";
    }

    /*
     * Their own details, so the assistant answers from the account rather than
     * from what it can guess.
     *
     * All of it is the customer's own - their name, their number, the address
     * they set themselves - which is the whole reason it is safe to put in
     * front of a model talking to them. Nobody else's record is here, and
     * none should be: see the note on the technician list in the instruction.
     */
    const lines = [
        "This customer's name is " + name + "."
        + (phone ? " Their number is " + phone + "." : "")
        + " That is the only name that belongs to them.",
    ];

    const where = [userData?.address, userData?.area, userData?.city, userData?.state, userData?.pincode]
        .map((part) => String(part || "").trim())
        .filter(Boolean)
        // The written address usually opens with the area, so a repeat would
        // have the assistant reading the same words twice.
        .filter((part, i, all) => !all.slice(0, i).some((earlier) => earlier.includes(part)));

    if (where.length) {
        lines.push("We send people to: " + where.join(", ") + ". This is already on file - never ask for it.");
    }

    /*
     * The other places they have saved, and the one question worth asking.
     *
     * A customer with only a home address is never asked anything - the job
     * goes there, as it always did. A customer who has saved an office has
     * told us they sometimes want somebody sent somewhere else, and the only
     * moment that matters is the booking. Asking once, by label, is cheaper
     * than a technician driving to an empty flat.
     */
    const saved = Array.isArray(userData?.addresses) ? userData.addresses : [];

    if (saved.length > 1) {
        const listed = saved
            .map((a) => {
                const label = String(a.label || "").trim() || "Unnamed";
                const line = [a.address, a.area, a.city].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
                return "- " + label + (line ? " (" + line + ")" : "") + (a.isDefault ? " [default]" : "");
            })
            .join("\n");

        lines.push(
            "They have more than one address saved:\n" + listed
            + "\nBefore booking, ask which one this job is for and pass its label as addressLabel."
            + "\nAsk it in one short line - 'which address shall I send them to?' - and end"
            + " that message with [[ADDRESS]] and nothing else. Do not name the addresses in"
            + " your own words and do not read them out: the channel shows them as a list to"
            + " tap, and their tap comes back as the label."
            + "\n[[ADDRESS]] is only for that question. Never put [[BOOK]] on it - that marker"
            + " belongs to 'shall I book this?' alone, and a Yes and a No under 'Home or"
            + " Office?' answers nothing."
            + "\nIf they answer something that is not one of the labels, use the default and"
            + " tell them which one you used."
        );
    }

    if (userData?.languageConfirmedAt && userData?.language) {
        lines.push("They chose to be spoken to in " + userData.language + ".");
    }

    if (userData?.createdAt) {
        lines.push("They have been a Cosmosgen customer since " + onDay(userData.createdAt) + ".");
    }

    lines.push(
        "Every other name you can see - in the CUSTOMER RECORD below, in the "
        + "history, anywhere - is a Cosmosgen worker sent to one of their jobs. "
        + "Never answer a question about the customer with a worker's name, and "
        + "never invent a name for anybody."
    );

    return "\nWHO YOU ARE SPEAKING TO:\n" + lines.join("\n") + "\n";
};

/**
 * What the company is and what it actually sells.
 *
 * Mohan asked for the WhatsApp assistant to be able to answer "what do you
 * do" properly rather than steering every message towards a booking. The
 * catalogue is the honest source for that - four services, their appliances
 * and the faults each one covers - and it is small enough to carry in full.
 *
 * Built from SERVICE_CATALOG rather than written out, so a service the office
 * adds or renames reaches the assistant the same day it reaches the menus.
 */
const companyBlock = () => {
    const lines = SERVICE_CATALOG.map((service) => {
        // "an electrician", not "a electrician". The model reads this aloud in
        // its own words, and a stumble here becomes a stumble there.
        const article = /^[aeiou]/i.test(service.worker || "") ? "an " : "a ";
        const bits = ["- " + service.label + " (we send " + article + service.worker + ")"];

        const appliances = (service.appliances || []).map((a) => a.label).filter(Boolean);
        if (appliances.length) bits.push("    machines: " + appliances.join(", "));

        /*
         * Deduplicated, because every appliance under a service carries the
         * same few entries - "Routine servicing" and "Not cooling properly"
         * appear on the AC, the fridge and the water heater alike. Listed raw
         * it reads as a stutter and spends tokens saying one thing five times.
         */
        const faults = [...new Set([
            ...(service.issues || []),
            ...(service.appliances || []).flatMap((a) => a.issues || []),
        ].map((i) => i.en).filter(Boolean))];

        if (faults.length) bits.push("    common faults: " + faults.join(", "));

        return bits.join("\n");
    });

    return "\nWHAT COSMOSGEN DOES:\n"
        + "Cosmosgen Engineers Pvt Ltd sends its own approved engineers to homes "
        + "to their door. Not a marketplace - every worker is on our own books, "
        + "and the customer gets their name, photograph and number before they "
        + "set off.\n"
        + "What we take on:\n"
        + lines.join("\n") + "\n"
        + "Anything outside this list is something we do not do. Say so plainly "
        + "rather than promising to try.\n";
};

const chosenLanguage = (userData) =>
    asLanguage(userData?.languageConfirmedAt ? userData.language : null) || "english";

const languageBlock = (language) =>
    "\nLANGUAGE - THIS OVERRIDES EVERYTHING ELSE:\n" +
    (LANGUAGE_RULES[language] || LANGUAGE_RULES.english) +
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
            .select("ticketNumber serviceLabel status technicianSnapshot scheduling ride cancelReason "
                + "billing.totalPaise billing.invoiceNumber billing.invoicePdfUrl billing.workDone "
                + "payment.status createdAt updatedAt")
            .sort({ createdAt: -1 })

            /*
             * Twelve rather than six.
             *
             * Mohan asked the assistant to remember a customer properly, and
             * six jobs is under a year for anybody who calls us twice a
             * season - "you fixed my geyser last winter" fell off the end and
             * the assistant answered as though it had never happened. Each
             * line is one short sentence, so a dozen costs a few hundred
             * tokens and buys the whole relationship.
             */
            .limit(12)
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

        /*
         * Where he is, in words, but only while that is still true.
         *
         * "Kaha tak pahucha hai" is asked as often as "kitni der", and a
         * minute count is a poor answer to it - the customer wants to hear a
         * place they know. The locality is already worked out for the tracking
         * map, so there is nothing to buy here.
         *
         * The guard matters, though. That name is refreshed only while
         * somebody has the tracking screen open - see the watched gate in
         * ride.service - so on a ride nobody is watching it stops moving and
         * stays wherever it last was. Quoted blind, the assistant would tell
         * somebody he was in Rasulgarh twenty minutes after he left it, which
         * is worse than not naming a place at all.
         *
         * `askedFrom` is where the route was last worked out from, and that
         * one is refreshed every five minutes whether or not anybody is
         * looking. So if the name was taken near there, it still holds. A
         * locality is wider than this figure, which is the point of it.
         */
        /*
         * Nobody is on their way to a job that is over.
         *
         * The ride record stays on the ticket after it is cancelled or closed,
         * because it is history worth keeping - but it reads as the present
         * tense, and it was being written out that way. A cancelled ticket
         * carried "due to arrive any moment" for as long as the customer could
         * see it, which is the assistant cheerfully promising somebody who is
         * never coming.
         *
         * So the two forward-looking lines are held to a live job. What
         * genuinely happened - that he did reach the door - stays on every
         * ticket, because that is a fact about the past and the customer may
         * well be asking about it.
         */
        const onTheWay = !["Cancelled", "Closed", "Payment-Pending"].includes(t.status);

        /*
         * How long an open job has been waiting, counted here rather than left
         * to the model.
         *
         * "Itne din se pending kyun hai" is asked with a number in it, and the
         * answer has to have the same number in it or it reads as a brush-off.
         * The booking date is already on the line above, but a model asked to
         * subtract two dates gets it wrong often enough to matter - and being
         * told "it has been two days" about a job booked last week is worse
         * than saying nothing.
         *
         * Only while the job is open, and only past a day. A job booked this
         * morning has not been waiting; saying it has waited nought days
         * invites the model to treat it as a complaint.
         */
        const openStill = !["Cancelled", "Closed"].includes(t.status);
        const daysWaiting = t.createdAt
            ? Math.floor((Date.now() - new Date(t.createdAt).getTime()) / 86400000)
            : 0;

        if (openStill && daysWaiting >= 1) {
            bits.push("waiting " + daysWaiting + (daysWaiting === 1 ? " day" : " days") + " so far");
        }

        const PLACE_STILL_TRUE_METRES = 700;
        const placeAt = ride.placeAt;
        const askedFrom = ride.askedFrom;

        const placeHolds = ride.nearPlace
            && Number.isFinite(placeAt?.lat)
            && (!Number.isFinite(askedFrom?.lat)
                || metresBetween(placeAt.lat, placeAt.lon, askedFrom.lat, askedFrom.lon)
                    <= PLACE_STILL_TRUE_METRES);

        if (onTheWay && !ride.arrivedAt && placeHolds) {
            bits.push("currently near " + ride.nearPlace);
        }

        if (ride.arrivedAt) {
            bits.push("worker reached at " + onDate(ride.arrivedAt));
        } else if (onTheWay && ride.etaAt) {
            // etaAt is an absolute moment, so the useful figure changes every
            // turn. Compute it now rather than storing a stale "25 minutes".
            const minsLeft = Math.round((new Date(ride.etaAt).getTime() - Date.now()) / 60000);
            bits.push(minsLeft > 0
                ? "arriving in about " + minsLeft + " min"
                : "due to arrive any moment");
        } else if (t.status === "Assigned") {
            bits.push("no arrival estimate yet");
        }

        /*
         * And what the job came to, once there is a bill to speak of.
         *
         * A closed job is still asked about - days later, when the customer
         * wants the amount, the invoice number or a copy to send on to
         * somebody. All of it is already on the ticket; it simply was not
         * being handed over, so the assistant could say what a job cost but
         * not which invoice said so, nor what had actually been repaired.
         *
         * The link is ImageKit's public URL for that invoice. It is given so
         * that the assistant can send it when it is asked for - a customer who
         * wants their bill should not be told to go and look somewhere else,
         * because there is nowhere else to look and nobody here to ask.
         */
        if (t.status === "Payment-Pending" || t.status === "Closed") {
            const bill = t.billing || {};
            const rupees = Math.round(Number(bill.totalPaise || 0) / 100);

            if (rupees > 0) bits.push("bill Rs " + rupees + ", payment " + (t.payment?.status || "pending"));
            if (bill.invoiceNumber) bits.push("invoice " + bill.invoiceNumber);
            if (bill.workDone) bits.push("work done: " + bill.workDone);
            if (bill.invoicePdfUrl) bits.push("invoice PDF: " + bill.invoicePdfUrl);
        }

        return "- " + bits.join(" | ");
    });

    return "\nCUSTOMER RECORD (live, as of right now):\n" + lines.join("\n") + "\n";
};

/**
 * The assistant's side of booking: ask the booking service, then say it.
 *
 * The rules themselves - how many open jobs are allowed, what counts as a
 * duplicate, whether the location is good enough - moved into
 * booking.service.js when the app needed to book too. Two copies of a rule is
 * one copy that is wrong, so this now only turns the answer into something the
 * model can read back to the customer.
 */
const handleCreateTicket = async (args, userData, userLocation) => {
    /*
     * A label, not an id.
     *
     * The model is given labels because it can read them back to the customer
     * and because an opaque id is something it would invent. Matching happens
     * here, where the account is - an unmatched label simply falls through to
     * the default, which is the same behaviour as not asking at all.
     */
    const wanted = String(args.addressLabel || "").trim().toLowerCase();
    const match = wanted
        ? (userData?.addresses || []).find((a) => String(a.label || "").trim().toLowerCase() === wanted)
        : null;

    const result = await booking.bookJob({
        customerId: userData?._id || userData?.id,
        serviceKey: args.serviceKey,
        selectedIssues: args.selectedIssues,
        problemDescription: args.problemDescription,
        channel: userData.channel || "whatsapp",
        location: userLocation,
        addressId: match?._id,
    });

    if (result.ok) {
        return {
            status: "success",
            ticketNumber: result.ticket.ticketNumber,
            workerRole: result.service.worker,
            message: "Request registered. The team is checking availability.",
        };
    }

    if (result.code === "unknown_service") {
        return { status: "failed", message: "Unknown service category." };
    }
    if (result.code === "no_profile") {
        return { status: "failed", message: "User profile not found." };
    }
    if (result.code === "no_location") {
        return { status: "failed", message: "Customer location is missing." };
    }

    if (result.code === "limit_reached") {
        return {
            status: "limit_reached",
            openCount: result.openCount,
            openServices: result.openServices.join(", "),
            message: "Customer already has " + booking.MAX_OPEN + " open requests. Ask them to wait until one is finished.",
        };
    }

    // already_booked - tell them where the existing one stands rather than
    // refusing flatly, which reads as the booking having failed
    const existing = result.ticket;
    const tech = existing.technicianSnapshot || {};
    const scheduledFor = existing.scheduling?.scheduledFor;

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
    }[existing.status] || "Your request is being handled.";

    return {
        status: "already_booked",
        ticketNumber: existing.ticketNumber,
        ticketStage: existing.status,
        service: existing.serviceLabel,
        workerRole: result.service.worker,
        technicianName: tech.name || null,
        technicianPhone: tech.phone || null,
        scheduledFor: scheduledFor
            ? new Date(scheduledFor).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
            : null,
        stageNote,
        message: "Customer already has an open request for this same service. Tell them where it stands. They can still book a different service.",
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
            systemInstruction: instruction
                + languageBlock(chosenLanguage(userData))
                + companyBlock()
                + await estimateBlock()
                + whoBlock(userData)
                + ticketRecord,
            tools: [{ functionDeclarations: [createTicketTool] }],
            temperature: 0.3,
        };

        const response = await keyring.generate({ model: MODEL_NAME, contents, config });
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

        const finalResponse = await keyring.generate({
            model: MODEL_NAME,
            contents: followUp,
            config: { ...config, temperature: 0.4 },
        });

        return finalResponse.text;
    } catch (error) {
        console.error("AI error:", error.name, "-", error.message);

        /*
         * The customer is apologised to and the fault is reported.
         *
         * Every key busy, a model that has stopped answering, a prompt that
         * has grown past the limit - the customer sees one polite line either
         * way, which is right for them and is why this needs saying out loud
         * somewhere else. A day of these is a day of lost bookings that looks,
         * from the outside, like nothing happening at all.
         */
        errors.report(error, "ai.reply", { customer: String(userData?._id || userData?.id || "") });

        // The apology has to arrive in the language they chose - a Hindi
        // sentence to a customer chatting in English or Odia is the drift
        // they complained about, and it came from here, not the model.
        return copyFor(chosenLanguage(userData)).aiUnavailable;
    }
};

// WhatsApp and web chat. `record` is optional - pass one when the caller has
// already fetched it in parallel with its own lookups.
const generateResponse = (contents, userData, userMessage, userLocation, record) =>
    runConversation({ contents, userData, userLocation, instruction: CHAT_INSTRUCTION, record });

/**
 * The marker the instruction asks for, and the only place it is understood.
 *
 * The model ends its booking question - and nothing else - with [[BOOK]], so a
 * channel that can offer a tap knows which message to offer it on. WhatsApp
 * turns that into a Yes and a No underneath the question; everywhere else it
 * is simply removed.
 *
 * Every caller must run its reply through this before showing it to anybody.
 * The marker is instruction scaffolding, not words for a customer, and a model
 * that puts it somewhere unexpected must not be able to leak it onto a screen.
 * A reply without it comes back unchanged and asksToBook false, which is the
 * old behaviour - so a turn where the model forgets simply falls back to the
 * customer typing yes, rather than breaking.
 */
const BOOK_MARK = "[[BOOK]]";

/**
 * And the other question worth a tap: which address.
 *
 * It was being asked in words - "Home or Office?" - underneath a Yes and a No,
 * because the booking marker was the only one there was and the model reached
 * for it. Two wrong answers on one screen: the buttons did not fit the
 * question, and the customer had to type a label back exactly as we spell it.
 *
 * With its own marker the channel can do the obvious thing instead and list
 * the addresses to choose from, the same way it lists services.
 */
const ADDRESS_MARK = "[[ADDRESS]]";

/**
 * And the first question of all: which service.
 *
 * The flow opens with that as a tappable list, and then the assistant would
 * type the same four names out in a sentence whenever the conversation came
 * back round to it - somebody asking what we do, or saying "I want to book"
 * without naming a trade. Four names in a paragraph, in Odia, is a spelling
 * test; the list beside it is one tap and cannot be got wrong.
 */
const MENU_MARK = "[[SERVICES]]";

/**
 * And the one thing the assistant cannot do by writing.
 *
 * A customer asked to be spoken to in English and was told "of course, English
 * from now on" - in English - while every menu under that message stayed in
 * Odia. The model had done the only thing it can do: change its own words. The
 * language is a field on their record, and the menus, the buttons and every
 * message the office sends are all read from it.
 *
 * So the request hands over to the picker that already exists. Their tap is
 * what changes it, everywhere, for good - which is also the honest way round:
 * a model guessing at "he seems to want Hindi" would be changing a setting
 * nobody asked it to touch.
 */
const LANGUAGE_MARK = "[[LANGUAGE]]";

const readBooking = (raw) => {
    const text = String(raw ?? "");
    const asksToBook = text.includes(BOOK_MARK);
    const asksAddress = text.includes(ADDRESS_MARK);
    const asksService = text.includes(MENU_MARK);
    const asksLanguage = text.includes(LANGUAGE_MARK);

    return {
        // Removed wherever they landed, not just off the end, and the blank
        // line they leave behind goes with them.
        text: text
            .split(BOOK_MARK).join("")
            .split(ADDRESS_MARK).join("")
            .split(MENU_MARK).join("")
            .split(LANGUAGE_MARK).join("")
            .replace(/\s+$/, "")
            .trim(),
        asksToBook,
        asksAddress,
        asksService,
        asksLanguage,
    };
};

async function generateVector(content) {
    if (!content || (typeof content === "string" && !content.trim())) return [];

    try {
        const response = await keyring.embed({
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

module.exports = { generateResponse, generateVector, buildCustomerRecord, readBooking };
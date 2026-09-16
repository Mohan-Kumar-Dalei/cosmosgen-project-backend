const crypto = require("crypto");
const Conversation = require("../models/conversation.model");
const userModel = require("../models/user.model");
const registration = require("../services/registration.service");
const messageModel = require("../models/message.model");
const Ticket = require("../models/ticket.model");
const whatsapp = require("../services/whatsapp.service");
const aiService = require("../services/ai.service");
const { createMemory, queryMemory } = require("../services/vector.service");
const { SERVICE_CATALOG, getServiceByKey, getAppliance, issueLabel, displayLabel } = require("../config/services");
const { copyFor } = require("../config/copy");

const OPEN_STATUSES = ["Pending", "Queued", "Assigned", "In-Progress", "Payment-Pending"];

// Booking conversations finish in four or five turns, so a short window
// carries the whole flow without paying for tokens nobody reads
const HISTORY_LIMIT = 8;
const RAG_TIMEOUT_MS = 400;
const MEMORY_CHAR_CAP = 300;

// Anything a customer types to get back to the start
const RESET_WORDS = ["hi", "hii", "hy", "hey", "hello", "menu", "start", "restart"];

/*
 * Where somebody who is not registered is sent.
 *
 * Left out of the message entirely when it is not configured, rather than
 * shipped as a placeholder: a dead link in the one message a new customer
 * reads is worse than no link at all, and they can find the app by name.
 */
const APP_LINK = (process.env.APP_DOWNLOAD_URL || "").trim();

/**
 * GET /api/whatsapp/webhook
 * Meta calls this once when the webhook URL is saved.
 */
const verifyWebhook = (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
        console.log("WhatsApp webhook verified");
        return res.status(200).send(challenge);
    }

    console.warn("WhatsApp webhook verification failed");
    return res.sendStatus(403);
};

/**
 * POST /api/whatsapp/webhook
 *
 * req.body is a raw Buffer - the signature covers the raw bytes, so this
 * route is mounted before express.json() in app.js.
 */
const receiveWebhook = async (req, res) => {
    const signature = req.headers["x-hub-signature-256"];
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    const rawBody = req.body;

    if (appSecret && signature) {
        const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
        if (expected !== signature) {
            console.error("WhatsApp signature mismatch");
            return res.sendStatus(401);
        }
    }

    // Meta retries anything slower than a few seconds, and repeated failures
    // disable the webhook - acknowledge first, process after
    res.sendStatus(200);

    let payload;
    try {
        payload = Buffer.isBuffer(rawBody) ? JSON.parse(rawBody.toString("utf8")) : rawBody;
    } catch (err) {
        console.error("WhatsApp payload parse failed:", err.message);
        return;
    }

    try {
        await handlePayload(payload);
    } catch (err) {
        console.error("WhatsApp processing error:", err.message);
    }
};

const handlePayload = async (payload) => {
    for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
            const value = change.value || {};
            const contacts = value.contacts || [];

            for (const message of value.messages || []) {
                const profileName = contacts.find((c) => c.wa_id === message.from)?.profile?.name;
                await handleMessage(message.from, message, profileName);
            }
        }
    }
};

const handleMessage = async (phone, message, profileName) => {
    let convo = await Conversation.findOne({ phone });
    if (!convo) {
        convo = await Conversation.create({ phone, profileName, step: "NEW" });
    }

    // Meta resends anything it thinks failed, so the same message can land twice
    if (convo.processedMessageIds.includes(message.id)) return;

    // Blue ticks and the typing bubble, fired and forgotten. Awaiting it would
    // put a Graph round trip in front of every reply for no benefit.
    whatsapp.markAsRead(message.id).catch(() => { });

    convo.processedMessageIds.push(message.id);
    convo.lastInboundAt = new Date();
    if (profileName) convo.profileName = profileName;

    console.log("WhatsApp [" + convo.step + "] from " + phone + ":", message.type);

    // A pin still arrives now and then - from somebody who used this number
    // before the app existed, or who is being helpful. It is answered rather
    // than stored: the address on the account is the one a job is dispatched
    // to, and quietly keeping a second one is how two different addresses end
    // up on two tickets for the same customer.
    if (message.type === "location") {
        await handleSharedLocation(convo);
        await convo.save();
        return;
    }

    // A customer whose ticket closed or was cancelled is still parked on
    // TICKET_CREATED. Reset only that case, and only for the service they
    // were on - a conversation still in diagnosis has no ticket by design.
    if (convo.step === "TICKET_CREATED" && convo.user && convo.selectedServiceKey) {
        const stillOpen = await Ticket.exists({
            customer: convo.user,
            serviceKey: convo.selectedServiceKey,
            status: { $in: OPEN_STATUSES },
        });
        if (!stillOpen) {
            convo.step = "AWAITING_SERVICE";
            convo.selectedServiceKey = undefined;
            convo.selectedApplianceKey = undefined;
            convo.selectedIssues = [];
            convo.activeTicket = null;

            /*
             * The job that brought them here is over, so this is a fresh
             * conversation and a natural place to offer the language choice
             * again - a household is not always the same person on WhatsApp.
             *
             * Caught here rather than at the five places a ticket can close,
             * and it fires exactly once, because the branch is only reachable
             * while the conversation is still parked on TICKET_CREATED. The
             * customer is known by definition here - the condition above
             * required it - so there is nothing to look up first.
             */
            await askForLanguage(convo);
            await convo.save();
            return;
        }
    }

    const interactiveId = message.interactive?.list_reply?.id || message.interactive?.button_reply?.id;
    const text = message.text?.body?.trim();

    /*
     * A tap on Yes or No under the booking question.
     *
     * Handled before the step switch rather than inside it, because the
     * question can be asked from more than one place - mid-diagnosis, or after
     * a "why" has been answered - and the answer means the same thing wherever
     * it was asked. Going through runAI rather than booking directly is
     * deliberate: the consent gate, the open-job limit and the reply the
     * customer reads all live on that path, and a second way in would be a
     * second set of rules to keep in step.
     *
     * The button's own title is what is fed back, because that is the message
     * WhatsApp itself would have delivered had they typed it - so the thread
     * reads as a conversation rather than as a machine talking to itself.
     */
    if (convo.user && (interactiveId === "book_yes" || interactiveId === "book_no")) {
        const t = copyFor(convo.language);
        const said = message.interactive?.button_reply?.title
            || (interactiveId === "book_yes" ? t.bookYes : t.bookNo);

        await runAI(convo, said);
        await convo.save();
        return;
    }

    // A customer stuck mid-flow needs a way back to the menu. But this must
    // not wipe a conversation with a live ticket attached - "hi, where is
    // your guy?" is a question about that ticket, not a fresh start.
    const normalised = (text || "").toLowerCase();
    if (RESET_WORDS.includes(normalised) && convo.step !== "TICKET_CREATED") {
        // Straight to the menu only once the account is attached and the
        // language is settled. Otherwise a "hi" typed at the language question
        // would skip it for good, since nothing downstream asks again.
        if (convo.user && convo.language && convo.customerName) {
            await sendServiceMenu(convo, { greet: true });
        } else {
            convo.step = "NEW";
            await startFlow(convo);
        }
        await convo.save();
        return;
    }

    switch (convo.step) {
        case "NEW":
        case "IDLE":
            await startFlow(convo);
            break;

        /*
         * Waiting for an account to appear on the app.
         *
         * Every message is a chance to look again rather than a chance to
         * repeat ourselves: somebody who has just finished registering says
         * "done" here and carries straight on, and somebody who has not is
         * told once more what is needed.
         *
         * The two old steps join it. Nobody is put into either any more, but
         * conversations were parked on them when the flow changed underneath
         * them, and both mean the same thing now - go and look at the account
         * - rather than waiting for a question that is never coming.
         */
        case "AWAITING_APP_SIGNUP":
        case "AWAITING_LOCATION":
        case "AWAITING_NAME":
            await startFlow(convo);
            break;

        case "AWAITING_LANGUAGE":
            if (interactiveId?.startsWith("lang_")) {
                await handleLanguagePick(convo, interactiveId);
            } else {
                await askForLanguage(convo);
            }
            break;

        case "AWAITING_SERVICE":
            if (interactiveId?.startsWith("svc_")) {
                await handleServicePick(convo, interactiveId.replace("svc_", ""));
            } else if (text && convo.user) {
                // A typed message here used to get the service menu back,
                // whatever it said. That is what happened when a customer
                // asked why their job was cancelled: the cancellation had
                // already bounced them out of TICKET_CREATED into this state,
                // so the question was answered with a menu. The assistant has
                // their ticket record, so let it read the question first.
                await runAI(convo, text);
            } else {
                // No text and no tap - re-send the menu, but with no greeting
                // this time or it starts sounding like a loop
                await sendServiceMenu(convo);
            }
            break;

        case "AWAITING_APPLIANCE":
            if (interactiveId?.startsWith("app_")) {
                await handleAppliancePick(convo, interactiveId.replace("app_", ""));
            } else {
                await sendApplianceMenu(convo);
            }
            break;

        case "AWAITING_ISSUE":
            if (interactiveId?.startsWith("iss_")) {
                await handleIssuePick(convo, interactiveId);
            } else if (text) {
                convo.selectedIssues = [text];
                convo.step = "IN_DIAGNOSIS";
                await runAI(convo, text);
            } else {
                await sendIssueMenu(convo);
            }
            break;

        case "IN_DIAGNOSIS":
        case "TICKET_CREATED":
            if (text) await runAI(convo, text);
            break;

        default:
            await startFlow(convo);
    }

    await convo.save();
};

/* ------------------------------------------------------------------ */
/* FLOW                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The name a person would write on a form.
 *
 * WhatsApp profile names are decorated - "☠️VICKY☠️" is what the API hands us -
 * and that string was going straight onto tickets and invoices. Strip
 * everything that isn't part of a name and keep the letters.
 */
const cleanName = (raw) =>
    String(raw || "")
        // Variation selectors and zero-width joiners have to go first. They
        // are combining marks, so the letters-and-marks filter below would
        // keep them, and a skull-wrapped nickname would come through with an
        // invisible character either side of the name. Marks stay allowed
        // after this line, because Devanagari matras are marks and dropping
        // those would mangle a name written in Hindi.
        .replace(/[\u{FE00}-\u{FE0F}\u{200B}-\u{200D}\u{2060}]/gu, "")
        .replace(/[^\p{L}\p{M}\s.'-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);

/**
 * "vicky kumar" and "VICKY KUMAR" both read badly on an invoice. Only touch
 * the casing when the whole thing is one case - a name the customer typed as
 * "McDonald" or "de Souza" is already how they want it.
 */
const tidyCase = (value) =>
    value === value.toLowerCase() || value === value.toUpperCase()
        ? value.replace(/\p{L}[\p{L}\p{M}'-]*/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
        : value;

const greetingName = (convo) => {
    // The profile name is only used until they type a real one, and it needs
    // the same scrub - the very first hello should not read "Hi (skull)VICKY".
    const source = convo.customerName || cleanName(convo.profileName) || "";
    const first = source.split(" ")[0];
    return first ? " " + tidyCase(first) : "";
};

/**
 * Odia first, because that is the language the office actually works in.
 *
 * It is offered as Odia, written in Odia script - it used to be called
 * Odenglish and written in Roman letters, which Mohan could not read back and
 * nor could anybody else. Hinglish stays a mix, because Roman-script Hindi is
 * genuinely what people read and type.
 *
 * Whatever they pick here is only what we write to them. What they send us can
 * be any of the three, in any script, and the assistant is told to read it
 * without ever asking them to write differently.
 */
const LANGUAGES = [
    { id: "lang_odia", key: "odia", title: "Odia", description: "ଓଡ଼ିଆ" },
    { id: "lang_hinglish", key: "hinglish", title: "Hinglish", description: "Hindi + English" },
    { id: "lang_english", key: "english", title: "English", description: "English only" },
];

const askForLanguage = async (convo) => {
    await whatsapp.sendList(convo.phone, {
        body: "Which language would you like to chat in?",
        buttonText: "Choose language",
        sectionTitle: "Languages",
        rows: LANGUAGES,
    });
    convo.step = "AWAITING_LANGUAGE";
};

const handleLanguagePick = async (convo, id) => {
    /*
     * The old id is still accepted.
     *
     * A language list sent before the rename is sitting in somebody's chat
     * right now, and tapping a row on it posts the id it was sent with. Left
     * unmatched, that tap would be answered by sending the list again - the
     * customer taps, nothing happens, they tap again.
     */
    const picked = LANGUAGES.find((l) => l.id === id || l.id === id.replace("odenglish", "odia"));
    if (!picked) {
        await askForLanguage(convo);
        return;
    }

    convo.language = picked.key;
    if (convo.user) {
        await userModel.updateOne(
            { _id: convo.user },
            { $set: { language: picked.key, languageConfirmedAt: new Date() } }
        );
    }

    await whatsapp.sendText(convo.phone, copyFor(picked.key).languageDone(picked.title));
    await resumeOnboarding(convo);
};

/**
 * Language, then name, then the menu.
 *
 * Both questions are asked once and remembered on the user record, so a
 * customer who came in before either existed gets caught here on their next
 * message rather than carrying a WhatsApp nickname onto every future invoice.
 */
/**
 * The door, and the only thing this number does for somebody it does not know.
 *
 * WhatsApp used to be a registration desk of its own: it asked for a dropped
 * pin, made an account out of it, then asked for a name. Mohan closed that
 * door - "agar hai toh aage ka normal process, agar nahi hai toh pehle AI
 * khud bolega ki Cosmosgen app main register karein" - because asking every
 * customer for their live location over WhatsApp, every time, is a privacy
 * problem waiting to become a real one.
 *
 * So there is one registration desk now and it is the app. Here we only look
 * the number up. The number is the identity: WhatsApp has already verified it
 * and it is the same number the app signs in with, so no code of our own is
 * needed to join the two.
 */
const startFlow = async (convo) => {
    // WhatsApp hands the number back with the country code on the front; the
    // account is keyed on the ten digits typed into the app.
    const plainPhone = convo.phone.replace(/^91/, "");

    const onFile = await userModel
        .findOne({ phone: plainPhone })
        .select("name phone language nameConfirmedAt languageConfirmedAt address area city pincode lat lon")
        .lean();

    /*
     * Two different problems, and telling somebody the wrong one is worse
     * than saying nothing. "Register on the app" to a customer who registered
     * last week reads as the product having lost them.
     */
    if (!registration.hasAppAccount(onFile)) {
        await sendAppSignup(convo);
        return;
    }

    if (!registration.hasPin(onFile)) {
        await sendNeedsLocation(convo, onFile);
        return;
    }

    convo.user = onFile._id;
    convo.customerName = onFile.name;

    // Only a language they actually chose. The account always carries one -
    // the schema sets it on the way in - so taking it at face value is what
    // had a first-time customer answered in Odia.
    if (onFile.languageConfirmedAt) convo.language = onFile.language;

    /*
     * The address is deliberately not copied onto the conversation.
     *
     * It used to be, because the pin arrived in the chat and the chat was the
     * only place it existed. Now it lives on the account, and a copy here
     * would be a second address that goes stale the moment somebody changes
     * theirs in the app - and a booking made from a conversation started
     * yesterday would quietly go to where they used to live.
     *
     * So there is one address, on the account, read at the moment a job is
     * raised. See runAI below.
     */
    convo.location = undefined;

    await resumeOnboarding(convo, onFile);
};

/**
 * What an unknown number is told, and the only thing it is told.
 *
 * Parked on a step of its own so the next message is read as "have they done
 * it yet" rather than as the answer to a question we never asked.
 */
const sendAppSignup = async (convo) => {
    const t = copyFor(convo.language);
    await whatsapp.sendText(convo.phone, t.appOnly + (APP_LINK ? "\n\n" + APP_LINK : ""));
    convo.step = "AWAITING_APP_SIGNUP";
};

/**
 * An account with nowhere to send anybody.
 *
 * Parked on the same step as a missing account, because the next message is
 * the same question either way: have they gone and done it yet. Their own
 * language is used here - unlike the signup message, we know who they are.
 */
const sendNeedsLocation = async (convo, onFile) => {
    if (onFile?.languageConfirmedAt) convo.language = onFile.language;

    await whatsapp.sendText(convo.phone, copyFor(convo.language).appNeedsLocation);
    convo.step = "AWAITING_APP_SIGNUP";
};

/**
 * Somebody has shared a pin we did not ask for.
 *
 * They are told plainly that we already hold their address and where to change
 * it, and then put back on whatever they were doing. The pin is not written
 * anywhere: two addresses for one customer is how an engineer ends up at the
 * wrong gate.
 */
const handleSharedLocation = async (convo) => {
    if (!convo.user) {
        await startFlow(convo);
        return;
    }

    await whatsapp.sendText(convo.phone, copyFor(convo.language).alreadyHaveLocation);

    if (convo.step === "NEW" || convo.step === "IDLE") await sendServiceMenu(convo);
};

/**
 * Language, the verification, and then the list.
 *
 * The language question is the one thing still asked here, and it is asked
 * once. It is not a privacy question and the app deliberately never puts it to
 * anybody - it is which of three ways of speaking this conversation runs in,
 * which only this channel needs to know.
 *
 * Then the details are read back before anything is booked. That is the
 * "verify" step: the customer sees the name and the place a job would be
 * raised against, taken off their own account, and corrects it in the app
 * rather than being asked to type it again here.
 */
const resumeOnboarding = async (convo, known) => {
    const onFile = known || (convo.user
        ? await userModel
            .findById(convo.user)
            .select("name phone language nameConfirmedAt languageConfirmedAt address area city pincode lat lon")
            .lean()
        : null);

    if (!onFile) {
        await startFlow(convo);
        return;
    }

    if (onFile.languageConfirmedAt) convo.language = onFile.language;

    /*
     * The language is settled for the life of a job, and asked again after it.
     *
     * Mohan's rule: whichever language a customer books in, everything about
     * that job stays in it until the job ends - and the next booking is a
     * fresh choice, on WhatsApp and in the app alike. So the test is not "have
     * they ever chosen", which locks the answer forever after the first time,
     * but "is there a job running right now that has already settled it".
     *
     * With work in hand, the choice they made for it stands and nobody is
     * asked to pick again mid-job. With nothing open, they are asked - the
     * house has no memory of last month's preference, and somebody who wanted
     * Odia once should not be stuck with it.
     */
    const running = await Ticket.exists({
        customer: onFile._id,
        status: { $in: OPEN_STATUSES },
    });

    if (!running || !onFile.languageConfirmedAt) {
        await askForLanguage(convo);
        return;
    }

    convo.customerName = onFile.name;

    await whatsapp.sendText(
        convo.phone,
        copyFor(convo.language).welcomeVerified(onFile.name, registration.whereWeSend(onFile))
    );

    await sendServiceMenu(convo);
};

const sendServiceMenu = async (convo, opts = {}) => {
    const t = copyFor(convo.language);

    // A greeting only reads well when they've just said hi. Sending one after
    // every menu bounce would feel robotic, so callers opt in.
    if (opts.greet) {
        await whatsapp.sendText(convo.phone, t.welcomeBack(greetingName(convo)));
    }

    // Service names stay in English on purpose - "AC", "geyser", "inverter"
    // are the words people here use whichever language they are speaking.
    await whatsapp.sendList(convo.phone, {
        body: t.serviceBody,
        buttonText: t.serviceButton,
        sectionTitle: t.serviceSection,
        rows: SERVICE_CATALOG.map((s) => ({
            id: "svc_" + s.key,
            title: displayLabel(s, convo.language),
        })),
    });

    convo.selectedServiceKey = undefined;
    convo.selectedApplianceKey = undefined;
    convo.selectedIssues = [];
    convo.activeTicket = null;
    convo.step = "AWAITING_SERVICE";
};

const handleServicePick = async (convo, serviceKey) => {
    const service = getServiceByKey(serviceKey);
    if (!service) {
        await sendServiceMenu(convo);
        return;
    }

    convo.selectedServiceKey = serviceKey;
    convo.selectedApplianceKey = undefined;
    convo.selectedIssues = [];

    // Services covering several machines need one more question before we
    // can ask what's wrong - "cooling nahi kar raha" means nothing until we
    // know whether it's the AC or the fridge
    if (service.appliances?.length) {
        await sendApplianceMenu(convo);
    } else {
        await sendIssueMenu(convo);
    }
};

const sendApplianceMenu = async (convo) => {
    const service = getServiceByKey(convo.selectedServiceKey);
    if (!service?.appliances?.length) {
        await sendIssueMenu(convo);
        return;
    }

    const t = copyFor(convo.language);

    // No sub-heading. It used to show the appliance's first issue, so every
    // row read "Air Conditioner / Cooling nahi kar raha" - a hardcoded
    // symptom sitting under a machine that might have a different one.
    await whatsapp.sendList(convo.phone, {
        body: t.applianceBody,
        buttonText: t.applianceButton,
        sectionTitle: displayLabel(service, convo.language).slice(0, 24),
        rows: service.appliances.slice(0, 10).map((a) => ({
            id: "app_" + a.key,
            title: displayLabel(a, convo.language).slice(0, 24),
        })),
    });

    convo.step = "AWAITING_APPLIANCE";
};

const handleAppliancePick = async (convo, applianceKey) => {
    const appliance = getAppliance(convo.selectedServiceKey, applianceKey);
    if (!appliance) {
        await sendApplianceMenu(convo);
        return;
    }

    convo.selectedApplianceKey = applianceKey;
    await sendIssueMenu(convo);
};

const sendIssueMenu = async (convo) => {
    const service = getServiceByKey(convo.selectedServiceKey);
    if (!service) {
        await sendServiceMenu(convo);
        return;
    }

    const appliance = convo.selectedApplianceKey
        ? getAppliance(convo.selectedServiceKey, convo.selectedApplianceKey)
        : null;

    const t = copyFor(convo.language);
    const issues = appliance?.issues || service.issues;
    const heading = displayLabel(appliance || service, convo.language);

    // WhatsApp lists cap at 10 rows, so nine issues plus an escape hatch is
    // the most we can offer. No sub-heading: the catalog guarantees every
    // label fits in a title, so there is nothing left over to spill into one.
    const rows = issues.slice(0, 9).map((item, i) => ({
        id: "iss_" + i,
        title: issueLabel(item, convo.language),
    }));
    rows.push({ id: "iss_other", title: t.somethingElse });

    await whatsapp.sendList(convo.phone, {
        body: t.issueBody(heading),
        buttonText: t.issueButton,
        sectionTitle: t.issueSection,
        rows,
    });

    convo.step = "AWAITING_ISSUE";
};

const handleIssuePick = async (convo, interactiveId) => {
    const service = getServiceByKey(convo.selectedServiceKey);
    const appliance = convo.selectedApplianceKey
        ? getAppliance(convo.selectedServiceKey, convo.selectedApplianceKey)
        : null;

    if (interactiveId === "iss_other") {
        await whatsapp.sendText(convo.phone, copyFor(convo.language).ownWords);
        convo.step = "IN_DIAGNOSIS";
        return;
    }

    const issues = appliance?.issues || service?.issues || [];
    const picked = issues[Number(interactiveId.replace("iss_", ""))];

    if (!picked) {
        await sendIssueMenu(convo);
        return;
    }

    // Keep the appliance in the issue text so the AI and the ticket both read
    // "Refrigerator: Not cooling properly", not just the symptom.
    const withAppliance = (text) => (appliance ? appliance.label + ": " + text : text);

    // The ticket stores English whatever the customer chose, so the office and
    // the technician read one language. The assistant is handed the customer's
    // own wording, because that is what they actually tapped.
    const forTicket = withAppliance(issueLabel(picked, "english"));
    const forCustomer = withAppliance(issueLabel(picked, convo.language));

    convo.selectedIssues = [forTicket];
    convo.step = "IN_DIAGNOSIS";

    // Picking from a menu is not permission. Spell that out, or the model
    // treats one line of context as enough and fires the tool immediately.
    await runAI(convo, forCustomer, {
        note: 'Customer picked this from a menu. They have NOT asked to book. Ask one short follow-up about this specific problem, then ask permission using the word "' + service.worker + '".',
    });
};

/* ------------------------------------------------------------------ */
/* AI                                                                   */
/* ------------------------------------------------------------------ */

const withTimeout = (promise, ms, fallback) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

const runAI = async (convo, userMessage, opts = {}) => {
    const user = await userModel.findById(convo.user);
    if (!user) {
        await whatsapp.sendText(convo.phone, "Something went wrong. Please send 'hi' to start again.");
        convo.step = "NEW";
        return;
    }

    const service = getServiceByKey(convo.selectedServiceKey);
    const chatId = "wa_" + convo.phone;
    const userId = String(user._id);

    // Past visits only matter when a customer opens a new request. Mid-flow
    // the recent turns already carry everything, so skipping the lookup
    // saves an embedding call and a Pinecone query on every turn.
    const isOpeningTurn = !convo.selectedServiceKey || convo.step === "AWAITING_SERVICE";

    // All three run together. The ticket record used to be fetched inside the
    // AI service, which put its round trip in front of the model call instead
    // of alongside the lookups already in flight.
    const [history, memory, record] = await Promise.all([
        messageModel
            .find({ chat: chatId, user: user._id })
            .sort({ createdAt: -1 })
            .limit(HISTORY_LIMIT)
            .select("role content")
            .lean(),

        isOpeningTurn
            ? withTimeout(
                aiService
                    .generateVector(userMessage)
                    .then((vectors) =>
                        vectors.length
                            ? queryMemory({ queryVector: vectors, limit: 2, metadata: { user: userId } })
                            : []
                    )
                    .catch(() => []),
                RAG_TIMEOUT_MS,
                []
            )
            : Promise.resolve([]),

        aiService.buildCustomerRecord(user._id),
    ]);

    const priorTurns = history.reverse().map((m) => ({
        role: m.role === "model" ? "model" : "user",
        parts: [{ text: m.content }],
    }));

    const memoryText = (memory || [])
        .map((m) => m?.metadata?.text)
        .filter(Boolean)
        .join(" | ")
        .slice(0, MEMORY_CHAR_CAP);

    let currentText = userMessage;
    if (priorTurns.length === 0 && service) {
        currentText = "[Service: " + service.label + "] " + userMessage;
    }
    if (memoryText) {
        currentText = "[Earlier visits: " + memoryText + "]\n" + currentText;
    }
    if (opts.note) {
        currentText = currentText + "\n[System: " + opts.note + "]";
    }

    const contents = [...priorTurns, { role: "user", parts: [{ text: currentText }] }];

    /*
     * No location passed with the booking, on purpose.
     *
     * booking.bookJob treats one as "this job is somewhere other than home"
     * and writes it over the account - which is right for the app, where a
     * customer can book for their office, and wrong here, where there is no
     * way to say that and anything we sent would just be a stale copy of the
     * account overwriting the account. Left out, it dispatches to the address
     * the customer set on the app, as it stands right now.
     */
    const raw = await aiService.generateResponse(contents, user, userMessage, null, record);

    /*
     * The booking question goes out with a Yes and a No under it.
     *
     * Every other choice in this flow is a tap - the language, the service,
     * the appliance, the fault - and then the one question that actually
     * commits somebody to a visit asked them to type. That is the step where
     * typing does the most damage too: "hnn j hele kn pain" is a yes with a
     * question inside it, and the whole consent gate in ai.service exists
     * because a typed yes cannot be trusted. A tapped one can.
     *
     * The model marks that message and nothing else - see readBooking. When
     * it forgets, the reply simply goes out as text and the customer types,
     * exactly as before.
     */
    const { text: reply, asksToBook } = aiService.readBooking(raw);

    /*
     * Buttons only where WhatsApp will actually take them.
     *
     * An interactive body is capped at 1024 characters and cannot be empty,
     * and a message that breaks either rule is rejected outright - which would
     * mean the customer gets nothing at all rather than a question without
     * buttons. A plain text message has neither limit, so it is what anything
     * out of range falls back to.
     */
    const canTap = asksToBook && reply.length > 0 && reply.length <= 1024;

    // Reply goes out first. Everything below is bookkeeping the customer
    // has no reason to wait for.
    let sent = null;

    if (canTap) {
        const t = copyFor(convo.language);
        sent = await whatsapp.sendButtons(convo.phone, {
            body: reply,
            buttons: [
                { id: "book_yes", title: t.bookYes },
                { id: "book_no", title: t.bookNo },
            ],
        });
    }

    // Said in words when the buttons could not be sent, whatever the reason -
    // the question still has to reach them, and a customer who never sees it
    // is a booking that never happens.
    if (!sent) await whatsapp.sendText(convo.phone, reply);

    convo.lastOutboundAt = new Date();

    // Store the customer's own words, not the wrapped version - system notes
    // and memory blocks would otherwise stack up in history every turn
    saveTurnInBackground({ chatId, user, userId, userMessage, reply });

    // Look for an open ticket in THIS service. A customer with a cleaning job
    // running should still be able to talk through a separate AC problem.
    const openTicket = convo.selectedServiceKey
        ? await Ticket.findOne({
            customer: user._id,
            serviceKey: convo.selectedServiceKey,
            status: { $in: OPEN_STATUSES },
        }).select("_id").lean()
        : null;

    if (openTicket) {
        convo.activeTicket = openTicket._id;
        convo.step = "TICKET_CREATED";
    } else {
        // Still talking - stay in diagnosis so the next message doesn't get
        // bounced back to the service menu
        convo.step = "IN_DIAGNOSIS";
    }
};

const saveTurnInBackground = ({ chatId, user, userId, userMessage, reply }) => {
    (async () => {
        try {
            const [userMsg, modelMsg] = await Promise.all([
                messageModel.create({ chat: chatId, user: user._id, content: userMessage, role: "user" }),
                messageModel.create({ chat: chatId, user: user._id, content: reply, role: "model" }),
            ]);

            const [userVec, modelVec] = await Promise.all([
                aiService.generateVector(userMessage).catch(() => []),
                aiService.generateVector(reply).catch(() => []),
            ]);

            await Promise.all([
                userVec.length
                    ? createMemory({
                        vectors: userVec,
                        messageId: userMsg._id,
                        metadata: { chat: chatId, user: userId, text: userMessage },
                    }).catch((e) => console.error("Pinecone user upsert failed:", e.message))
                    : null,

                modelVec.length
                    ? createMemory({
                        vectors: modelVec,
                        messageId: modelMsg._id,
                        metadata: { chat: chatId, user: userId, text: reply },
                    }).catch((e) => console.error("Pinecone model upsert failed:", e.message))
                    : null,
            ]);
        } catch (err) {
            console.error("Background save failed:", err.message);
        }
    })();
};

module.exports = { verifyWebhook, receiveWebhook };
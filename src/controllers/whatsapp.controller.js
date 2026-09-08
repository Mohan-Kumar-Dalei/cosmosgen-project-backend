const crypto = require("crypto");
const Conversation = require("../models/conversation.model");
const userModel = require("../models/user.model");
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

    if (message.type === "location") {
        await saveLocation(convo, message.location);
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
            convo.step = convo.location?.lat ? "AWAITING_SERVICE" : "NEW";
            convo.selectedServiceKey = undefined;
            convo.selectedApplianceKey = undefined;
            convo.selectedIssues = [];
            convo.activeTicket = null;

            // The job that brought them here is over, so this is a fresh
            // conversation and a natural place to offer the language choice
            // again - a household is not always the same person on WhatsApp.
            //
            // Caught here rather than at the five places a ticket can close,
            // and it fires exactly once, because the branch is only reachable
            // while the conversation is still parked on TICKET_CREATED.
            if (convo.location?.lat) {
                await askForLanguage(convo);
                await convo.save();
                return;
            }
        }
    }

    const interactiveId = message.interactive?.list_reply?.id || message.interactive?.button_reply?.id;
    const text = message.text?.body?.trim();

    // A customer stuck mid-flow needs a way back to the menu. But this must
    // not wipe a conversation with a live ticket attached - "hi, where is
    // your guy?" is a question about that ticket, not a fresh start.
    const normalised = (text || "").toLowerCase();
    if (RESET_WORDS.includes(normalised) && convo.step !== "TICKET_CREATED") {
        // Straight to the menu only once we know their language and name.
        // Otherwise a "hi" typed at either question would skip it for good,
        // since nothing downstream asks again.
        if (convo.location?.lat && convo.language && convo.customerName) {
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

        case "AWAITING_LOCATION":
            await whatsapp.sendLocationRequest(
                phone,
                "I still need your location to find someone near you. Tap the button below."
            );
            break;

        case "AWAITING_LANGUAGE":
            if (interactiveId?.startsWith("lang_")) {
                await handleLanguagePick(convo, interactiveId);
            } else {
                await askForLanguage(convo);
            }
            break;

        case "AWAITING_NAME":
            if (text) {
                await handleNameReply(convo, text);
            } else {
                await whatsapp.sendText(convo.phone, copyFor(convo.language).namePlease);
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

const looksLikeName = (value) => (value.match(/\p{L}/gu) || []).length >= 2;

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
 * Neither of the mixed options is pure - people here type Odia and Hindi in
 * Roman script with English words dropped in, and asking them to pick "Odia"
 * would suggest a script most of them do not type.
 */
const LANGUAGES = [
    { id: "lang_odenglish", key: "odenglish", title: "Odenglish", description: "Odia + English" },
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
    const picked = LANGUAGES.find((l) => l.id === id);
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
const resumeOnboarding = async (convo) => {
    if (!convo.user) {
        await sendServiceMenu(convo, { greet: true });
        return;
    }

    const onFile = await userModel
        .findById(convo.user)
        .select("name language nameConfirmedAt languageConfirmedAt")
        .lean();

    if (!onFile?.languageConfirmedAt) {
        await askForLanguage(convo);
        return;
    }
    convo.language = onFile.language;

    if (!onFile.nameConfirmedAt) {
        await askForName(convo);
        return;
    }
    convo.customerName = onFile.name;

    await sendServiceMenu(convo, { greet: true });
};

const askForName = async (convo) => {
    await whatsapp.sendText(
        convo.phone,
        copyFor(convo.language).askName
    );
    convo.step = "AWAITING_NAME";
};

/**
 * Their reply to the name question. Anything with two letters in it is
 * accepted: pushing back on a name over WhatsApp loses more bookings than a
 * slightly odd spelling costs us, and the office can correct it.
 */
const handleNameReply = async (convo, text) => {
    const name = tidyCase(cleanName(text));

    if (!looksLikeName(name)) {
        await whatsapp.sendText(
            convo.phone,
            copyFor(convo.language).nameRetry
        );
        return;
    }

    // No user row yet means they reached this without sending a location,
    // which the flow does not allow - send them back rather than writing to
    // an undefined id.
    if (!convo.user) {
        await startFlow(convo);
        return;
    }

    await userModel.updateOne(
        { _id: convo.user },
        { $set: { name, nameConfirmedAt: new Date() } }
    );

    convo.customerName = name;
    await whatsapp.sendText(convo.phone, copyFor(convo.language).thanksName(name.split(" ")[0]));
    await sendServiceMenu(convo);
};

const startFlow = async (convo) => {
    const name = greetingName(convo);

    // Location first - without coordinates the office can't run a nearby
    // search, so there's no point collecting anything else yet
    if (!convo.location?.lat) {
        // Built from the catalog, not typed out - adding a service to
        // config/services.js should never mean editing this message too
        const serviceLine = SERVICE_CATALOG.map((s) => s.label).join(", ");

        await whatsapp.sendText(
            convo.phone,
            "Hi" + name + "! Welcome to Cosmosgen.\n\n" +
            "We handle " + serviceLine + ".\n\n" +
            "To get you someone nearby, I need your location first."
        );
        await whatsapp.sendLocationRequest(
            convo.phone,
            "Tap below and choose *Send current location*."
        );
        convo.step = "AWAITING_LOCATION";
        return;
    }

    await resumeOnboarding(convo);
};

const saveLocation = async (convo, location) => {
    convo.location = {
        lat: location.latitude,
        lon: location.longitude,
        address: location.address || location.name,
        capturedAt: new Date(),
    };

    // WhatsApp has already verified this number, so it works as identity
    // without an OTP step of our own
    const plainPhone = convo.phone.replace(/^91/, "");

    const user = await userModel.findOneAndUpdate(
        { phone: plainPhone },
        {
            $set: {
                lat: location.latitude,
                lon: location.longitude,
                address: location.address || location.name,
                location: { type: "Point", coordinates: [location.longitude, location.latitude] },
            },
            // The WhatsApp nickname is a placeholder until they type a real
            // name. Setting it on every location update would overwrite the
            // one they gave us the first time round.
            $setOnInsert: { phone: plainPhone, name: convo.profileName || "WhatsApp customer" },
        },
        { returnDocument: "after", upsert: true }
    ).lean();

    convo.user = user._id;

    await whatsapp.sendText(convo.phone, "Got your location, thanks.");
    await resumeOnboarding(convo);
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

    const reply = await aiService.generateResponse(contents, user, userMessage, convo.location, record);

    // Reply goes out first. Everything below is bookkeeping the customer
    // has no reason to wait for.
    await whatsapp.sendText(convo.phone, reply);
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
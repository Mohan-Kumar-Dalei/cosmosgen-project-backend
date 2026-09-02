const crypto = require("crypto");
const Conversation = require("../models/conversation.model");
const userModel = require("../models/user.model");
const messageModel = require("../models/message.model");
const Ticket = require("../models/ticket.model");
const whatsapp = require("../services/whatsapp.service");
const aiService = require("../services/ai.service");
const { createMemory, queryMemory } = require("../services/vector.service");
const { SERVICE_CATALOG, getServiceByKey, getAppliance } = require("../config/services");

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
        }
    }

    const interactiveId = message.interactive?.list_reply?.id || message.interactive?.button_reply?.id;
    const text = message.text?.body?.trim();

    // A customer stuck mid-flow needs a way back to the menu. But this must
    // not wipe a conversation with a live ticket attached - "hi, where is
    // your guy?" is a question about that ticket, not a fresh start.
    const normalised = (text || "").toLowerCase();
    if (RESET_WORDS.includes(normalised) && convo.step !== "TICKET_CREATED") {
        if (convo.location?.lat) {
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

        case "AWAITING_SERVICE":
            if (interactiveId?.startsWith("svc_")) {
                await handleServicePick(convo, interactiveId.replace("svc_", ""));
            } else {
                // They typed instead of tapping - re-send the menu, but no
                // greeting this time or it starts sounding like a loop
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

const startFlow = async (convo) => {
    const name = convo.profileName ? " " + convo.profileName.split(" ")[0] : "";

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

    await sendServiceMenu(convo, { greet: true });
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
                name: convo.profileName || "WhatsApp customer",
                lat: location.latitude,
                lon: location.longitude,
                address: location.address || location.name,
                location: { type: "Point", coordinates: [location.longitude, location.latitude] },
            },
            $setOnInsert: { phone: plainPhone },
        },
        { returnDocument: "after", upsert: true }
    ).lean();

    convo.user = user._id;

    await whatsapp.sendText(convo.phone, "Got your location, thanks.");
    await sendServiceMenu(convo);
};

const sendServiceMenu = async (convo, opts = {}) => {
    const firstName = convo.profileName ? convo.profileName.split(" ")[0] : "";

    // A greeting only reads well when they've just said hi. Sending one after
    // every menu bounce would feel robotic, so callers opt in.
    if (opts.greet) {
        await whatsapp.sendText(
            convo.phone,
            "Hi" + (firstName ? " " + firstName : "") + "! Welcome back to Cosmosgen."
        );
    }

    await whatsapp.sendList(convo.phone, {
        body: "What do you need help with today?",
        buttonText: "Choose service",
        sectionTitle: "Our services",
        rows: SERVICE_CATALOG.map((s) => ({
            id: "svc_" + s.key,
            title: s.label,
            description: s.appliances ? s.appliances.map((a) => a.label).join(", ") : s.issues[0],
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

    await whatsapp.sendList(convo.phone, {
        body: "Which appliance needs attention?",
        buttonText: "Choose appliance",
        sectionTitle: service.label,
        rows: service.appliances.slice(0, 10).map((a) => ({
            id: "app_" + a.key,
            title: a.label.slice(0, 24),
            description: a.issues[0],
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

    const issues = appliance?.issues || service.issues;
    const heading = appliance ? appliance.label : service.label;

    // WhatsApp lists cap at 10 rows and 24-char titles, so nine issues plus
    // an escape hatch is the most we can offer
    const rows = issues.slice(0, 9).map((issue, i) => ({
        id: "iss_" + i,
        title: issue.slice(0, 24),
        description: issue.length > 24 ? issue : undefined,
    }));
    rows.push({ id: "iss_other", title: "Something else" });

    await whatsapp.sendList(convo.phone, {
        body: heading + " - what's the problem?",
        buttonText: "Choose issue",
        sectionTitle: "Common issues",
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
        await whatsapp.sendText(convo.phone, "No problem - tell me what's happening in your own words.");
        convo.step = "IN_DIAGNOSIS";
        return;
    }

    const issues = appliance?.issues || service?.issues || [];
    const issue = issues[Number(interactiveId.replace("iss_", ""))];

    if (!issue) {
        await sendIssueMenu(convo);
        return;
    }

    // Keep the appliance in the issue text so the AI and the ticket both
    // read "Refrigerator: cooling nahi kar raha", not just the symptom
    const fullIssue = appliance ? appliance.label + ": " + issue : issue;

    convo.selectedIssues = [fullIssue];
    convo.step = "IN_DIAGNOSIS";

    // Picking from a menu is not permission. Spell that out, or the model
    // treats one line of context as enough and fires the tool immediately.
    await runAI(convo, fullIssue, {
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

    const [history, memory] = await Promise.all([
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

    const reply = await aiService.generateResponse(contents, user, userMessage, convo.location);

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
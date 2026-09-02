const { GoogleGenAI } = require("@google/genai");
const Ticket = require("../models/ticket.model");
const UserModel = require("../models/user.model");
const { SERVICE_CATALOG, getServiceByKey } = require("../config/services");
const notification = require("./notification.service");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = "gemini-3.1-flash-lite";

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
- 2-3 short lines per reply. Friendly Hinglish, like a person on chat.
- Greet once at the start, never again.
- Never repeat a question they already answered. Read the history first.
- If they chat about something unrelated, chat back briefly, then steer
  gently back to their problem.
- Their location is already saved. Never ask for address, area or pincode.

Never ask a diagnostic question and the booking question in the same message.
One turn = one question. If you combine them, their answer is ambiguous and
you will book something they didn't agree to.

Wrong (never do this):
  "AC se awaaz aa rahi hai? Main technician book kar doon?"
  -> "haan thoda awaaz hai" answers the first question, not the second

Right:
  Turn 1 (you):  "AC se koi awaaz aa rahi hai? Aur last service kab hui thi?"
  Turn 2 (them): "haan thodi awaaz hai, kaafi time se service nahi hui"
  Turn 3 (you):  "Samajh gaya. Kya main aapke liye technician book kar doon?"
  Turn 4 (them): "haan"
  -> now, and only now, call the tool

WHAT COUNTS AS PERMISSION:
Only a yes that answers YOUR booking question, asked on its own, in your
previous message. Before treating any reply as permission, check: was your
last message ONLY the booking question, with nothing else in it? If it also
contained a diagnostic question, their reply is answering that instead.

These are NOT permission - answer them and carry on:
  "kya aap electrician book kar sakte hain?"  -> asking what you can do
  "plumber bhej sakte ho?"                    -> a capability question
  "kitna time lagega?"                        -> a timing question
  "haan awaaz aa rahi hai"                    -> answering a symptom question
  "haan kaafi din se hai"                     -> answering a duration question

If you are unsure whether their yes meant booking, ask again plainly:
"Toh main technician book kar doon?"  Asking twice is fine. Booking something
they didn't ask for is not.

Sequence:
  1. They pick a service, the appliance if asked, and an issue from menus.
  2. You ask ONE short diagnostic question. Nothing else in that message.
  3. They answer.
  4. You ask ONLY: "Kya main aapke liye [worker] book kar doon?"
  5. Only after they say yes to THAT, call 'create_service_request'.

Never call the tool in the same turn the issue was picked.
Never call it if step 4 wasn't its own separate message.
If they say No, accept it and say they can message anytime.

For any of these, say yes you can arrange it, then keep understanding
the problem.

Sequence:
  1. They pick a service, the appliance if asked, and an issue from menus.
  2. You ask ONE short follow-up - how long, what they tried, anything unusual.
     Make it specific to what they picked, not generic.
  3. When you understand it, YOU ask: "Kya main aapke liye [worker] book kar doon?"
  4. Only after they answer Yes / Haan / Sure / Kar do, call the tool.

Never call the tool in the same turn the issue was picked.
Never call it without asking step 3 first.
If they say No, accept it and say they can message anytime.

MULTIPLE REQUESTS:
A customer can have up to 3 different jobs running at once - an AC repair and
a house cleaning are separate things. If they want a different service while
one is in progress, book it normally.

TOOL RESULTS:
- "success": request registered, team is checking availability. Use workerRole
  in your reply. Never name a worker, never give an arrival time.
- "already_booked": they already have this SAME service open. Don't create
  another. Give the ticket number and stageNote, name the worker and share
  technicianPhone if present. Mention they can still book a different service.
- "limit_reached": they have 3 jobs running (openServices lists them). Explain
  warmly that we'll take the next one once one of these is done.
- "failed": apologise, ask them to try again shortly.

NEVER:
- Quote a price. The worker confirms cost on site.
- Promise a time. No "15 minutes", no "within an hour".
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

    return {
        status: "success",
        ticketNumber: ticket.ticketNumber,
        workerRole: service.worker,
        message: "Request registered. The team is checking availability.",
    };
};

/**
 * Shared engine for both channels. Only the instruction block differs, so
 * there's no reason to duplicate the tool-calling round trip.
 */
const runConversation = async ({ contents, userData, userLocation, instruction }) => {
    try {
        const config = {
            systemInstruction: instruction,
            tools: [{ functionDeclarations: [createTicketTool] }],
            temperature: 0.3,
        };

        const response = await ai.models.generateContent({ model: MODEL_NAME, contents, config });
        const functionCall = response.functionCalls?.[0];

        if (!functionCall || functionCall.name !== "create_service_request") {
            return response.text;
        }

        let toolResult;
        try {
            toolResult = await handleCreateTicket(functionCall.args || {}, userData, userLocation);
        } catch (err) {
            console.error("Ticket creation failed:", err.message);
            toolResult = { status: "failed", message: "Could not register the request." };
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
        return "Maaf kijiyega, kuch server problem ke karan main process nahi kar paya. Kripya thodi der baad try karein.";
    }
};

// WhatsApp and web chat
const generateResponse = (contents, userData, userMessage, userLocation) =>
    runConversation({ contents, userData, userLocation, instruction: CHAT_INSTRUCTION });

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

module.exports = { generateResponse, generateVoiceResponse, generateVector };
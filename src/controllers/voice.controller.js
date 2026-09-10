const crypto = require("crypto");
const axios = require("axios");

const Call = require("../models/call.model");
const ticketModel = require("../models/ticket.model");
const userModel = require("../models/user.model");
const voice = require("../services/voice.service");
const { emitToRoom, adminRoom } = require("../sockets/socket.instance");

/**
 * The phone line.
 *
 * Twilio carries the call and this file is the only place that knows it. The
 * turn taking is deliberately simple: we say a line, record their answer, and
 * Twilio posts the recording back. No media streams, no websocket - a
 * thirty-second availability check does not need them, and every extra moving
 * part on a phone call is another way for the customer to hear silence.
 *
 * Everything the call decides comes from voice.service, which knows nothing
 * about Twilio. This file is plumbing.
 */

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_FROM_NUMBER;
const PUBLIC_URL = (process.env.PUBLIC_API_URL || "").replace(/\/+$/, "");

/**
 * Exotel, when it is configured, otherwise Twilio.
 *
 * Exotel is the one that matters for this business: its numbers are Indian, so
 * a customer sees a local caller id rather than a foreign one they will not
 * answer, and outbound voice to Indian mobiles is theirs to be compliant
 * about. Twilio stays as the fallback because the trial is easier to stand up
 * abroad and the two are one function apart.
 */
const EXO = {
    sid: process.env.EXOTEL_SID,
    key: process.env.EXOTEL_API_KEY,
    token: process.env.EXOTEL_API_TOKEN,
    subdomain: process.env.EXOTEL_SUBDOMAIN || "api.exotel.com",
    callerId: process.env.EXOTEL_CALLER_ID,
    appId: process.env.EXOTEL_APP_ID,
};

const exotelConfigured = () => Boolean(EXO.sid && EXO.key && EXO.token && EXO.callerId && EXO.appId);
const twilioConfigured = () => Boolean(SID && TOKEN && FROM);

const provider = () => (exotelConfigured() ? "exotel" : twilioConfigured() ? "twilio" : null);

const isTelephonyReady = () => Boolean(provider() && PUBLIC_URL && voice.isVoiceReady());

/**
 * Lines we have already turned into speech, waiting to be fetched by Twilio.
 *
 * In memory on purpose. A clip is wanted once, seconds after it is made, and
 * writing a few hundred kilobytes of wav into Mongo for every sentence of
 * every call would cost more than it saves. A restart mid-call loses the clip
 * and the call falls back to Twilio's own voice, which is a fair trade.
 */
const clips = new Map();
const CLIP_TTL_MS = 5 * 60 * 1000;

const stashClip = (base64) => {
    const id = crypto.randomBytes(8).toString("hex");
    clips.set(id, { base64, at: Date.now() });

    // Swept on write rather than on a timer - the map only grows when calls
    // are happening, so that is the only time it needs clearing
    for (const [key, value] of clips) {
        if (Date.now() - value.at > CLIP_TTL_MS) clips.delete(key);
    }

    return id;
};

/* ================= TWIML ================= */

const escapeXml = (s) =>
    String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

/** Twilio's own voice, used only when Sarvam could not produce a clip. */
const TWILIO_VOICE_LANG = {
    english: "en-IN",
    hinglish: "hi-IN",
    odenglish: "hi-IN",
};

/**
 * Say a line, then listen.
 *
 * The recording stops on three seconds of silence rather than after a fixed
 * spell, because "haan" and "kal sakaal e asantu" are not the same length and
 * cutting somebody off mid-sentence is how a call turns into a complaint.
 */
const sayAndListen = ({ text, clipId, callId, language, hangup = false }) => {
    const play = clipId
        ? `<Play>${PUBLIC_URL}/api/voice/clip/${clipId}</Play>`
        : `<Say language="${TWILIO_VOICE_LANG[language] || "hi-IN"}">${escapeXml(text)}</Say>`;

    const after = hangup
        ? "<Hangup/>"
        : `<Record action="${PUBLIC_URL}/api/voice/turn/${callId}" method="POST" ` +
          `maxLength="20" timeout="3" playBeep="false" trim="trim-silence" />`;

    return `<?xml version="1.0" encoding="UTF-8"?><Response>${play}${after}</Response>`;
};

const sendTwiml = (res, xml) => {
    res.set("Content-Type", "text/xml");
    return res.send(xml);
};

/* ================= SECURITY ================= */

/**
 * Twilio signs every webhook. Without checking it, anybody who learns a call
 * id could post fake answers and change what a customer supposedly said - and
 * one of those answers reschedules a real visit.
 */
const signatureValid = (req) => {
    if (!TOKEN) return false;

    const signature = req.get("X-Twilio-Signature");
    if (!signature) return false;

    const url = PUBLIC_URL + req.originalUrl;
    const body = req.body || {};
    const payload = Object.keys(body)
        .sort()
        .reduce((acc, key) => acc + key + body[key], url);

    const expected = crypto.createHmac("sha1", TOKEN).update(Buffer.from(payload, "utf-8")).digest("base64");

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/* ================= PLACING A CALL ================= */

/**
 * Exotel, on their v1 API - v2 is not enabled on this account.
 *
 * Their model is not Twilio's. Twilio asks our server what to say at every
 * turn; Exotel runs a Flow built in their console and our server supplies the
 * pieces it asks for. So `Url` here points at the Flow, not at us, and the
 * conversation is driven from inside that Flow.
 *
 * "From" is the person who gets rung first, which on a one-legged call to a
 * flow is the customer. CallerId is the Exophone they see.
 */
const dialExotel = async (call, phone, callerId) => {
    const to = phone.replace(/^\+?91/, "");
    const from = callerId || EXO.callerId;

    console.log("[VOICE] exotel: ringing " + to + " from " + from);

    const res = await axios.post(
        "https://" + EXO.subdomain + "/v1/Accounts/" + EXO.sid + "/Calls/connect.json",
        new URLSearchParams({
            From: to,
            CallerId: from,
            Url: "http://my.exotel.com/" + EXO.sid + "/exoml/start_voice/" + EXO.appId,
            // Exotel posts the result here when the call ends, which is how a
            // call nobody answered stops being "ringing" in our records
            StatusCallback: PUBLIC_URL + "/api/voice/status/" + call._id,
            // Exotel hands this back to every applet in the flow, and it is
            // the only thread tying their call to our record of it. Without
            // it an applet calling us has no way to say which call it is.
            CustomField: String(call._id),
            CallType: "trans",
            TimeLimit: "300",
            TimeOut: "30",
        }),
        {
            auth: { username: EXO.key, password: EXO.token },
            timeout: 12000,
        }
    );

    return { sid: res.data?.Call?.Sid || res.data?.Call?.sid };
};

const dialTwilio = async (call, phone) => {
    const res = await axios.post(
        "https://api.twilio.com/2010-04-01/Accounts/" + SID + "/Calls.json",
        new URLSearchParams({
            To: phone.startsWith("+") ? phone : "+91" + phone.replace(/^91/, ""),
            From: FROM,
            Url: PUBLIC_URL + "/api/voice/answer/" + call._id,
            Method: "POST",
            StatusCallback: PUBLIC_URL + "/api/voice/status/" + call._id,
            StatusCallbackMethod: "POST",
            Timeout: "20",
        }),
        { auth: { username: SID, password: TOKEN }, timeout: 10000 }
    );

    return { sid: res.data?.sid };
};

/**
 * Works out the first line and says it into a buffer, while the phone rings.
 *
 * This is the difference between a call that greets you the moment you answer
 * and one that leaves two seconds of silence for you to say "hello?" into.
 */
const prepareOpening = async (call, ticket) => {
    const { text } = await voice.nextTurn({
        purpose: call.purpose,
        turns: [{ role: "user", parts: [{ text: "(the customer has just answered the phone)" }] }],
        context: contextFor(ticket, call.purpose),
        language: call.language,
    });

    if (!text) return;

    const audio = await voice.speak(text, call.language);
    if (!audio) return;

    await Call.updateOne({ _id: call._id }, { $set: { opening: { text, audio } } });
    console.log("[VOICE] greeting ready for " + ticket.ticketNumber + ": " + text);
};

/**
 * Rings a customer about one ticket.
 *
 * Never throws. A call is an extra - if Twilio is not configured, or the
 * number is unreachable, the booking still has to go through, so this reports
 * and returns null rather than taking the caller down with it.
 */
const placeCall = async ({ ticket, purpose, to, callerId }) => {
    if (!isTelephonyReady()) {
        console.log("[VOICE] telephony is not configured, skipping the " + purpose + " call");
        return null;
    }

    // Both overrides exist for testing and nothing else. In the ordinary
    // flow the number to ring is the one on the ticket and the number they
    // see is the company's - anything else would be a bug, not a feature.
    const phone = to || ticket.customerSnapshot?.phone;
    if (!phone) return null;

    const user = ticket.customer
        ? await userModel.findById(ticket.customer).select("language").lean()
        : null;

    const call = await Call.create({
        ticket: ticket._id,
        customer: ticket.customer,
        phone,
        purpose,
        language: user?.language || "odenglish",
        status: "queued",
        attempts: 1,
    });

    try {
        const res = provider() === "exotel"
            ? await dialExotel(call, phone, callerId)
            : await dialTwilio(call, phone);

        call.providerCallSid = res.sid;
        call.status = "ringing";
        await call.save();

        // Not awaited. The phone is ringing either way, and this only has to
        // finish before somebody picks up - which takes several seconds.
        prepareOpening(call, ticket).catch((err) =>
            console.error("[VOICE] could not prepare the greeting:", err.message));

        return call;
    } catch (err) {
        // Each provider buries the useful sentence somewhere different, and
        // without it a failure reads as a bare status code that says nothing
        // about what to go and fix.
        const body = err.response?.data;
        const detail = body?.RestException?.Message || body?.message || err.message;
        console.error("[VOICE] could not place the call:", detail);

        if (/kyc/i.test(detail)) {
            console.error(
                "[VOICE] Exotel will only ring the number the account was " +
                "registered with until KYC is approved. Upload the documents " +
                "in the Exotel dashboard to call anyone else.");
        }

        // Twilio answers a trial account with one generic line whatever the
        // real cause, so the two that actually bite are named here rather
        // than left to be rediscovered.
        if (/trial account/i.test(detail)) {
            console.error(
                "[VOICE] on a Twilio trial this usually means one of two things: " +
                "TWILIO_FROM_NUMBER is not a number this account owns, or the " +
                "destination has not been added under Verified Caller IDs."
            );
        }
        call.status = "failed";
        call.lastError = detail;
        await call.save();
        return null;
    }
};

/* ================= THE CONVERSATION ================= */

/**
 * The facts the assistant is allowed to use on this call. Deliberately short:
 * everything here is read aloud eventually, and a long block is what makes a
 * model start narrating the file to the customer.
 */
const contextFor = (ticket, purpose) => {
    const customer = ticket.customerSnapshot || {};
    const tech = ticket.technicianSnapshot || {};

    const lines = [
        "Customer: " + (customer.name || "the customer"),
        "Service: " + (ticket.serviceLabel || "a home service"),
        "Ticket: " + ticket.ticketNumber,
    ];

    if (purpose === "feedback" && tech.name) lines.push("Technician who came: " + tech.name);
    if (purpose === "availability" && customer.area) lines.push("Address area: " + customer.area);

    return lines.join("\n");
};

/**
 * The conversation so far, in the shape Gemini wants.
 *
 * On the very first turn there is nothing yet - the customer has said hello
 * and that is all. An empty contents array is rejected outright, so the fact
 * that they picked up is stated as the opening turn. Without this the first
 * thing every caller heard was the apology the failure path plays.
 */
const turnsFor = (call) => {
    const said = (call.turns || []).map((t) => ({
        role: t.role === "assistant" ? "model" : "user",
        parts: [{ text: t.text }],
    }));

    return said.length
        ? said
        : [{ role: "user", parts: [{ text: "(the customer has just answered the phone)" }] }];
};

/**
 * Works out the next line, speaks it, and returns the TwiML for it.
 *
 * One place for both the opening line and every reply after it, so a change to
 * how the call sounds only has to be made once.
 */
const respond = async (call, res) => {
    const ticket = await ticketModel
        .findById(call.ticket)
        .select("ticketNumber serviceLabel customerSnapshot technicianSnapshot")
        .lean();

    if (!ticket) {
        return sendTwiml(res, sayAndListen({
            text: "Sorry, we cannot find your booking. The office will call you back.",
            callId: call._id,
            language: call.language,
            hangup: true,
        }));
    }

    const { text, outcome, failed } = await voice.nextTurn({
        purpose: call.purpose,
        turns: turnsFor(call),
        context: contextFor(ticket, call.purpose),
        language: call.language,
    });

    // The brain is down. Ending politely beats a line that goes quiet.
    if (failed || (!text && !outcome)) {
        call.status = "failed";
        call.lastError = "assistant did not answer";
        call.endedAt = new Date();
        await call.save();

        return sendTwiml(res, sayAndListen({
            text: "Sorry, we are having trouble. The office will call you back shortly.",
            callId: call._id,
            language: call.language,
            hangup: true,
        }));
    }

    if (text) call.turns.push({ role: "assistant", text });

    if (outcome) {
        call.outcome = outcome;
        call.status = "completed";
        call.endedAt = new Date();
        await call.save();
        await applyOutcome(call, ticket);
    } else {
        await call.save();
    }

    const clip = await voice.speak(text, call.language);

    return sendTwiml(res, sayAndListen({
        text,
        clipId: clip ? stashClip(clip) : null,
        callId: call._id,
        language: call.language,
        hangup: Boolean(outcome),
    }));
};

/**
 * What the call actually changes.
 *
 * The office is told either way, because both answers are things somebody has
 * to act on: a customer who is not in needs their visit moved, and a bad
 * rating needs reading before that vendor is sent out again.
 */
const applyOutcome = async (call, ticket) => {
    const o = call.outcome || {};

    if (call.purpose === "availability") {
        await ticketModel.updateOne({ _id: ticket._id }, {
            $set: {
                "availabilityCheck.calledAt": call.endedAt || new Date(),
                "availabilityCheck.available": Boolean(o.available),
                "availabilityCheck.preferredDay": o.preferredDay || "",
                "availabilityCheck.preferredTime": o.preferredTime || "",
                "availabilityCheck.wantsCancel": Boolean(o.wantsCancel),
                "availabilityCheck.note": o.note || "",
            },
        });

        emitToRoom(adminRoom(), "call:availability", {
            ticketId: String(ticket._id),
            ticketNumber: ticket.ticketNumber,
            customerName: ticket.customerSnapshot?.name,
            available: Boolean(o.available),
            preferredDay: o.preferredDay || "",
            preferredTime: o.preferredTime || "",
            wantsCancel: Boolean(o.wantsCancel),
        });
        return;
    }

    await ticketModel.updateOne({ _id: ticket._id }, {
        $set: {
            "feedback.calledAt": call.endedAt || new Date(),
            "feedback.rating": Number(o.rating) || 0,
            "feedback.workOk": o.workOk !== false,
            "feedback.behaviourOk": o.behaviourOk !== false,
            "feedback.complaint": o.complaint || "",
            "feedback.note": o.note || "",
        },
    });

    emitToRoom(adminRoom(), "call:feedback", {
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        technicianName: ticket.technicianSnapshot?.name,
        rating: Number(o.rating) || 0,
        workOk: o.workOk !== false,
        behaviourOk: o.behaviourOk !== false,
        complaint: o.complaint || "",
    });
};

/* ================= EXOTEL FLOW ================= */

/**
 * Exotel does not hand us the call the way Twilio does.
 *
 * Twilio asks our server what to say at every turn. Exotel runs a Flow built
 * in their console and the applets in it call out to us: a Greeting applet
 * fetches audio from `/exotel/say`, and whatever records the customer posts
 * the recording to `/exotel/heard`. The loop lives in their builder; these two
 * endpoints are what it pulls on.
 *
 * Every request is logged in full on purpose. Their applet contract is not
 * something to take on faith - the field names are what they are, and the
 * fastest way to learn them is to read one real request rather than three
 * pages of documentation.
 */

const logExotel = (label, req) => {
    console.log("[VOICE][exotel] " + label + " " + req.method + " " + req.originalUrl);
    console.log("  query:", JSON.stringify(req.query || {}));
    if (req.body && Object.keys(req.body).length) console.log("  body :", JSON.stringify(req.body));
};

/** Their applets pass our id back under CustomField, in query or body. */
const callIdFrom = (req) =>
    req.query?.CustomField || req.body?.CustomField ||
    req.query?.custom_field || req.body?.custom_field || null;

const findCall = async (req) => {
    const id = callIdFrom(req);
    if (!id || !/^[a-f0-9]{24}$/i.test(String(id))) return null;
    return Call.findById(id);
};

/**
 * GET|POST /api/voice/exotel/say
 *
 * The next thing to say, as audio. A Greeting applet pointed here plays
 * whatever comes back, so this is where the assistant actually speaks.
 *
 * Returns wav at 8kHz because that is what a phone line carries; Sarvam is
 * asked for that rate directly rather than resampled here.
 */
const exotelSay = async (req, res) => {
    logExotel("say", req);

    const call = await findCall(req);

    // A flow we cannot place still gets a sentence rather than silence
    if (!call) {
        const clip = await voice.speak("Sorry, we could not find your booking. The office will call you back.", "odenglish");
        if (!clip) return res.sendStatus(404);
        res.set("Content-Type", "audio/wav");
        return res.send(Buffer.from(clip, "base64"));
    }

    if (call.status === "queued" || call.status === "ringing") {
        call.status = "talking";
        call.startedAt = call.startedAt || new Date();
    }

    const ticket = await ticketModel
        .findById(call.ticket)
        .select("ticketNumber serviceLabel customerSnapshot technicianSnapshot")
        .lean();

    const { text, outcome, failed } = await voice.nextTurn({
        purpose: call.purpose,
        turns: turnsFor(call),
        context: ticket ? contextFor(ticket, call.purpose) : "",
        language: call.language,
    });

    const line = text
        ? text
        : outcome
            ? voice.signOff(call.purpose, call.language)
            : "Sorry, we are having trouble. The office will call you back shortly.";

    call.turns.push({ role: "assistant", text: line });

    if (outcome) {
        call.outcome = outcome;
        call.status = "completed";
        call.endedAt = new Date();
    }

    await call.save();
    if (outcome && ticket) await applyOutcome(call, ticket);

    const clip = await voice.speak(line, call.language);

    if (!clip) {
        // No audio to give them. Say so in text; a flow that expects audio
        // will fail loudly here rather than play nothing.
        console.error("[VOICE][exotel] no audio for: " + line);
        return res.status(503).send("tts unavailable");
    }

    res.set("Content-Type", "audio/wav");
    return res.send(Buffer.from(clip, "base64"));
};

/**
 * POST|GET /api/voice/exotel/heard
 *
 * What the customer said. Exotel posts the recording of their turn; we fetch
 * it, put it through Sarvam and add it to the conversation. The next Greeting
 * applet in the loop then picks up the reply.
 *
 * Answers 200 with an empty body whatever happens - an applet waiting on us
 * must not be left hanging because a transcription failed.
 */
const exotelHeard = async (req, res) => {
    logExotel("heard", req);

    const call = await findCall(req);
    if (!call) return res.sendStatus(200);

    const url =
        req.body?.RecordingUrl || req.query?.RecordingUrl ||
        req.body?.recording_url || req.query?.recording_url;

    if (!url) {
        console.warn("[VOICE][exotel] no recording url on this turn");
        return res.sendStatus(200);
    }

    try {
        const audio = await axios.get(url, { responseType: "arraybuffer", timeout: 15000 });
        const heard = await voice.transcribe(Buffer.from(audio.data), call.language);

        if (heard) {
            call.turns.push({ role: "customer", text: heard });
            await call.save();
            console.log("[VOICE][exotel] heard: " + heard);
        } else {
            console.warn("[VOICE][exotel] recording produced no text");
        }
    } catch (err) {
        console.error("[VOICE][exotel] could not fetch the recording:", err.message);
    }

    return res.sendStatus(200);
};

/* ================= WEBHOOKS ================= */

// POST /api/voice/answer/:callId - they picked up
const onAnswer = async (req, res) => {
    if (!signatureValid(req)) return res.status(403).send("Forbidden");

    const call = await Call.findById(req.params.callId);
    if (!call) return res.status(404).send("Not found");

    call.status = "talking";
    call.startedAt = call.startedAt || new Date();
    await call.save();

    return respond(call, res);
};

// POST /api/voice/turn/:callId - they said something
const onTurn = async (req, res) => {
    if (!signatureValid(req)) return res.status(403).send("Forbidden");

    const call = await Call.findById(req.params.callId);
    if (!call) return res.status(404).send("Not found");

    const recordingUrl = req.body?.RecordingUrl;
    let heard = "";

    if (recordingUrl) {
        try {
            // Twilio serves the wav a moment after posting the URL, and the
            // file is behind the same account credentials
            const audio = await axios.get(recordingUrl + ".wav", {
                responseType: "arraybuffer",
                auth: { username: SID, password: TOKEN },
                timeout: 15000,
            });
            heard = await voice.transcribe(Buffer.from(audio.data), call.language);
        } catch (err) {
            console.error("[VOICE] could not fetch the recording:", err.message);
        }
    }

    if (!heard) {
        // Not treated as a turn. Adding an empty line to the history teaches
        // the model that silence is an answer, and it starts filling it in.
        const clip = await voice.speak("Sorry, I did not catch that. Could you say it again?", call.language);
        return sendTwiml(res, sayAndListen({
            text: "Sorry, I did not catch that. Could you say it again?",
            clipId: clip ? stashClip(clip) : null,
            callId: call._id,
            language: call.language,
        }));
    }

    call.turns.push({ role: "customer", text: heard });
    await call.save();

    return respond(call, res);
};

// POST /api/voice/status/:callId - Twilio reporting how it ended
const onStatus = async (req, res) => {
    if (!signatureValid(req)) return res.status(403).send("Forbidden");

    const state = req.body?.CallStatus;
    const call = await Call.findById(req.params.callId);

    if (call && call.status !== "completed") {
        if (["no-answer", "busy"].includes(state)) call.status = "no_answer";
        else if (state === "failed" || state === "canceled") call.status = "failed";
        else if (state === "completed") call.status = call.outcome ? "completed" : "no_answer";

        call.endedAt = call.endedAt || new Date();
        await call.save();
    }

    return res.sendStatus(204);
};

// GET /api/voice/clip/:id - Twilio fetching a line to play
const getClip = (req, res) => {
    const clip = clips.get(req.params.id);
    if (!clip) return res.sendStatus(404);

    res.set("Content-Type", "audio/wav");
    return res.send(Buffer.from(clip.base64, "base64"));
};

module.exports = {
    placeCall,
    isTelephonyReady,
    // Shared with the voicebot socket, which runs the same conversation over
    // a live stream instead of over webhooks
    contextFor,
    applyOutcome,
    exotelSay,
    exotelHeard,
    onAnswer,
    onTurn,
    onStatus,
    getClip,
};

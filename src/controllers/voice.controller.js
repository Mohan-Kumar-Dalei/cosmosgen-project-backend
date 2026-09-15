const crypto = require("crypto");
const axios = require("axios");

const Call = require("../models/call.model");
const ticketModel = require("../models/ticket.model");
const userModel = require("../models/user.model");
const voice = require("../services/voice.service");
const keyring = require("../services/keyring.service");
const { emitToRoom, adminRoom } = require("../sockets/socket.instance");

/**
 * The phone line.
 *
 * Exotel carries the call and this file is the only place that knows it: it
 * dials, it hands the flow the pieces it asks for, and it writes down how the
 * call ended. The conversation itself happens over the voicebot socket.
 *
 * Everything the call decides comes from voice.service, which knows nothing
 * about any carrier. This file is plumbing.
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

/*
 * One carrier now.
 *
 * Twilio was here as the fallback, on the grounds that its trial is easier to
 * stand up abroad. That reason never applied to this company: the customers
 * are in Odisha, they do not answer foreign numbers, and the second provider
 * bought nothing but a whole parallel call flow to keep working - TwiML, a
 * signature check, a webhook per turn and a place to park audio for it to
 * fetch back. All of it is gone; Exotel drives the call over the voicebot
 * socket instead.
 */
const provider = () => (exotelConfigured() ? "exotel" : null);

const isTelephonyReady = () => Boolean(provider() && PUBLIC_URL && voice.isVoiceReady());

/**
 * Exotel, on their v1 API - v2 is not enabled on this account.
 *
 * Exotel runs a Flow built in their console and our server supplies the
 * pieces it asks for, rather than being asked what to say at every turn. So
 * `Url` here points at the Flow, not at us, and the conversation is driven
 * from inside that Flow.
 *
 * "From" is the person who gets rung first, which on a one-legged call to a
 * flow is the customer. CallerId is the Exophone they see.
 */
const dialExotel = async (call, phone, callerId) => {
    const to = phone.replace(/^\+?91/, "");
    const from = callerId || EXO.callerId;

    console.log("[VOICE] exotel: ringing " + to + " from " + from);

    // One placed call, on the developer platform's meter for this provider
    keyring.count("exotel");

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
 * Never throws. A call is an extra - if the carrier is not configured, or the
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

    /*
     * languageConfirmedAt as well as the language itself.
     *
     * The account always carries a language - the schema writes one on the way
     * in - so the field alone cannot tell a choice from a default, and a
     * customer who had never been asked was rung up and spoken to in Odia.
     */
    const user = ticket.customer
        ? await userModel.findById(ticket.customer).select("language languageConfirmedAt").lean()
        : null;

    const call = await Call.create({
        ticket: ticket._id,
        customer: ticket.customer,
        phone,
        purpose,
        language: (user?.languageConfirmedAt ? user.language : null) || "english",
        status: "queued",
        attempts: 1,
    });

    try {
        const res = await dialExotel(call, phone, callerId);

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

    /*
     * Where we are already sending somebody, said plainly, on the call that
     * decides whether anybody sets off.
     *
     * The snapshot is taken off the customer's account when the job is booked,
     * and the account is the one place an address is set now - so the call has
     * it and must never ask for it. It used to get the area alone, which was
     * not enough to confirm anything with, and the old voice prompt told the
     * model outright that it had no location and should ask for an area and a
     * landmark. That is exactly the repeated asking Mohan wanted gone, and on
     * a line where speech recognition mangles addresses it was also the least
     * reliable way to learn one.
     */
    if (purpose === "availability") {
        const where = [customer.address, customer.area, customer.state]
            .map((part) => String(part || "").trim())
            .filter(Boolean);

        // The written address usually opens with the area anyway, so a repeat
        // would have the assistant reading the same words twice out loud.
        const said = where.filter((part, i) => !where.slice(0, i).some((earlier) => earlier.includes(part)));

        if (said.length) lines.push("Address on file: " + said.join(", "));
        if (customer.landmark) lines.push("Landmark: " + customer.landmark);
    }

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
 * Exotel does not hand us the call the way a webhook-driven carrier would.
 *
 * A webhook carrier asks our server what to say at every turn. Exotel runs a Flow built
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
        const clip = await voice.speak("Sorry, we could not find your booking. The office will call you back.", "english");
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

/*
 * One webhook left.
 *
 * There were four: two Twilio called at every turn of the conversation, one
 * it used to fetch the audio back, and this. Exotel does not work that way -
 * the conversation runs over the voicebot socket - so this is the only thing
 * the carrier still posts to us, and it is how a call nobody answered stops
 * being "ringing" in our records.
 */

/**
 * POST /api/voice/status/:callId - the carrier reporting how it ended.
 *
 * This used to demand an X-Twilio-Signature, and returned false whenever
 * there was no Twilio token to check one against - so with Exotel carrying
 * the calls, every one of these was answered with 403 and the call stayed
 * "ringing" in our records for ever. Twenty of forty-two were sitting like
 * that. Removing Twilio is the moment that shows up, because the check no
 * longer has anything it could be checking.
 *
 * What replaces it needs no shared secret: the carrier hands back the call id
 * it was given when we dialled, and we already stored that against this
 * record. A stranger would have to know both the record's id and the
 * carrier's - and if they did, the worst they could do is mark a finished
 * call as finished.
 */
const onStatus = async (req, res) => {
    const state = req.body?.CallStatus || req.body?.Status;
    const sid = req.body?.CallSid || req.body?.Sid;

    const call = await Call.findById(req.params.callId);

    if (call?.providerCallSid && sid && call.providerCallSid !== sid) {
        return res.status(403).send("Forbidden");
    }

    if (call && call.status !== "completed") {
        if (["no-answer", "busy"].includes(state)) call.status = "no_answer";
        else if (state === "failed" || state === "canceled") call.status = "failed";
        else if (state === "completed") call.status = call.outcome ? "completed" : "no_answer";

        call.endedAt = call.endedAt || new Date();
        await call.save();
    }

    return res.sendStatus(204);
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
    onStatus,
};

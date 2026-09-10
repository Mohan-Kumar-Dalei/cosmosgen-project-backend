const { WebSocketServer } = require("ws");

const Call = require("../models/call.model");
const ticketModel = require("../models/ticket.model");
const voice = require("../services/voice.service");

/**
 * The live end of a phone call.
 *
 * Exotel's Voicebot applet does not ask our server what to say and wait for an
 * answer, the way a webhook does. It opens a socket and pours the caller's
 * audio down it, frame by frame, and expects our audio back the same way. That
 * is what makes the conversation feel like one - nobody waits for a page to
 * load between sentences.
 *
 * So this file does the one thing HTTP could not: it listens continuously,
 * decides when the customer has finished speaking, and answers. What to say is
 * still voice.service's business; this only knows about ears and mouths.
 *
 * The protocol is logged in full on the first frames of every call on purpose.
 * Exotel's field names are theirs, not ours, and one real call tells us more
 * than any amount of guessing - which is exactly how the Sarvam model names
 * were sorted out.
 */

const PATH = "/voice-stream";

/* ================= AUDIO ================= */

/**
 * A phone line is 8kHz, 16-bit, mono. Everything below counts in those units:
 * one sample is two bytes, so a fifth of a second is 3200 bytes.
 */
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;

/** Below this, a frame is room noise rather than somebody talking. */
const SILENCE_RMS = 500;

/** How long a pause has to run before we take it as "your turn". */
const END_OF_TURN_MS = Number(process.env.VOICE_END_OF_TURN_MS) || 900;

/** Never let one turn run away - a phone left on a table would never end. */
const MAX_TURN_MS = 15000;

/**
 * Tried at six hundred, and put back.
 *
 * Faster, but it cut people off between two sentences - a customer saying "yes,
 * I am home, you can send the technician" lost the second half. The streaming
 * recogniser already saved about a second on this leg, so the shorter pause was
 * buying speed the call did not need at a cost it could not afford. Tunable
 * from the environment if a particular line needs it.
 */

/** How long a silence runs after we speak before we ask if they are there. */
const QUIET_MS = 5000;

/** Loudness of one frame, 0 to 32768. */
const rms = (buf) => {
    if (buf.length < BYTES_PER_SAMPLE) return 0;

    let sum = 0;
    const samples = Math.floor(buf.length / BYTES_PER_SAMPLE);
    for (let i = 0; i < samples; i++) {
        const s = buf.readInt16LE(i * BYTES_PER_SAMPLE);
        sum += s * s;
    }
    return Math.sqrt(sum / samples);
};

/* ================= ONE CALL ================= */

class Session {
    constructor(ws) {
        this.ws = ws;
        this.streamSid = null;
        this.call = null;
        this.ticket = null;

        this.heard = [];          // frames of the turn in progress
        this.speaking = false;    // has the customer said anything this turn
        this.silenceMs = 0;
        this.turnMs = 0;

        // While we are talking, their audio is our own voice coming back down
        // the line. Listening to it would have the bot answer itself.
        this.busy = false;
        this.frameCount = 0;
        this.done = false;

        // A line that has gone quiet after we spoke. Two prompts, then we let
        // them go rather than keep an empty call open.
        this.quietTimer = null;
        this.nudges = 0;

        // The recogniser, open before they speak. See ensureListener.
        this.stt = null;
    }

    /**
     * Keeps a recogniser connected and waiting.
     *
     * Opening one costs about four hundred milliseconds of handshake, and
     * doing that after the customer has already started talking means the
     * first half of their sentence is queued rather than heard. So one is
     * opened when the call connects and a fresh one the moment a turn ends,
     * while nobody is waiting on it.
     */
    ensureListener() {
        if (this.done) return;
        if (this.stt?.alive) return;
        this.stt = voice.listenStream(this.call?.language || "odenglish");
    }

    /**
     * Ask if they are still there, once the line has been quiet a while.
     *
     * Started after every line we say and cleared the moment they speak, so a
     * customer who is thinking for two seconds is never interrupted, and one
     * who has put the phone down is not left listening to nothing.
     */
    armQuietTimer() {
        this.clearQuietTimer();
        if (this.done) return;

        this.quietTimer = setTimeout(async () => {
            if (this.done || this.busy || this.speaking) return;

            if (this.nudges >= 2) {
                console.log("[VOICEBOT] nobody is speaking, ending the call");
                const bye = voice.signOff(this.call.purpose, this.call.language);
                await this.record(bye);
                await this.say(bye, true);
                return;
            }

            const line = voice.nudge(this.call.language, this.nudges);
            this.nudges++;
            console.log("[VOICEBOT] nudging: " + line);
            await this.record(line);
            await this.say(line);
        }, QUIET_MS);
    }

    /**
     * Puts a line we spoke into the transcript.
     *
     * Lines the model wrote are recorded where they are generated; these are
     * ours, and without this the office would read a call that looks like one
     * greeting and thirty seconds of nothing.
     */
    async record(text) {
        if (!this.call) return;
        this.call.turns.push({ role: "assistant", text });
        await this.call.save();
    }

    clearQuietTimer() {
        if (this.quietTimer) clearTimeout(this.quietTimer);
        this.quietTimer = null;
    }

    send(payload) {
        if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(payload));
    }

    /**
     * Finds our call id in whatever shape Exotel chose to send it.
     *
     * We pass CustomField=<id> on the connect API and Exotel hands it back as
     * the KEY of custom_parameters with an empty value - {"6aa246...": ""} -
     * not as {"CustomField": "6aa246..."}. Rather than encode that quirk and
     * be broken by the next one, this looks for the shape of the thing: a
     * Mongo id is twenty-four hex characters and nothing else on the frame
     * looks like one.
     */
    static callIdFrom(msg, url) {
        const start = msg.start || msg;
        const params = start.custom_parameters || start.customParameters || start.custom_params || {};

        const looksLikeId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v.trim());

        for (const [key, value] of Object.entries(params)) {
            if (looksLikeId(key)) return key.trim();
            if (looksLikeId(value)) return String(value).trim();
        }

        const named = start.CustomField || start.custom_field || url?.searchParams?.get("CustomField");
        return looksLikeId(named) ? String(named).trim() : null;
    }

    async attach(msg, url) {
        const start = msg.start || msg;
        this.streamSid = msg.stream_sid || start.stream_sid || msg.streamSid || null;

        const id = Session.callIdFrom(msg, url);

        // The provider's own call id is the sturdier of the two: we wrote it
        // down when the call was placed, and it does not depend on how Exotel
        // decides to pass custom parameters through this year.
        const providerSid = start.call_sid || start.callSid || msg.call_sid || null;

        this.call =
            (id ? await Call.findById(id) : null) ||
            (providerSid ? await Call.findOne({ providerCallSid: providerSid }) : null);

        if (!this.call) {
            console.warn(
                "[VOICEBOT] this stream matches no call record " +
                "(custom id: " + (id || "none") + ", call_sid: " + (providerSid || "none") + ")"
            );
            return;
        }

        this.ticket = await ticketModel
            .findById(this.call.ticket)
            .select("ticketNumber serviceLabel customerSnapshot technicianSnapshot")
            .lean();

        if (this.call.status === "queued" || this.call.status === "ringing") {
            this.call.status = "talking";
            this.call.startedAt = this.call.startedAt || new Date();
            await this.call.save();
        }

        console.log("[VOICEBOT] attached to " + (this.ticket?.ticketNumber || "?") +
            " (" + this.call.purpose + ", " + this.call.language + ")");

        // We speak first. They answered the phone; somebody has to say why -
        // and it has to be immediate, so the line made while the phone was
        // ringing is played straight out rather than generated now.
        // Connected now, while the greeting is still playing, so the very
        // first thing they say is heard rather than queued behind a handshake.
        this.ensureListener();

        // Copied out as plain strings first: clearing the field below empties
        // the subdocument itself, so a reference held on to would go blank
        // before it could be played.
        const openingText = this.call.opening?.text;
        const openingAudio = this.call.opening?.audio;

        if (openingAudio) {
            console.log("[VOICEBOT] assistant (prepared): " + openingText);
            this.call.turns.push({ role: "assistant", text: openingText });

            // Cleared as it is played. It is worth nothing now, and a call
            // record carrying a hundred kilobytes of base64 for ever is not
            // something to leave lying in the database.
            this.call.opening = undefined;
            await this.call.save();

            await this.playClip(openingAudio);
            return;
        }

        await this.think();
    }

    /** Feed one frame of the caller's audio. */
    onAudio(pcm) {
        if (!this.call || this.busy || this.done) return;

        const frameMs = (pcm.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
        this.turnMs += frameMs;

        if (rms(pcm) > SILENCE_RMS) {
            // They are talking, so they are plainly still there
            if (!this.speaking) this.clearQuietTimer();
            this.speaking = true;
            this.nudges = 0;
            this.silenceMs = 0;
            this.heard.push(pcm);
            this.stt?.send(pcm);
            return;
        }

        // Silence before they have said anything is just the line being quiet
        if (!this.speaking) return;

        this.silenceMs += frameMs;
        this.heard.push(pcm);
        this.stt?.send(pcm);

        if (this.silenceMs >= END_OF_TURN_MS || this.turnMs >= MAX_TURN_MS) {
            const audio = Buffer.concat(this.heard);
            const listener = this.stt;

            this.heard = [];
            this.stt = null;
            this.speaking = false;
            this.silenceMs = 0;
            this.turnMs = 0;

            this.transcribeAndThink(audio, listener);
        }
    }

    async transcribeAndThink(pcm, listener) {
        this.busy = true;
        try {
            // The socket already has the audio, so this is just the last
            // fragment. If it never connected, or heard nothing, the whole
            // utterance still goes up the old way rather than being lost.
            let text = listener ? await listener.finish() : "";

            if (!text) {
                if (listener) console.log("[VOICEBOT] the live recogniser gave nothing, uploading the turn");
                text = await voice.transcribe(voice.wavFromPcm(pcm), this.call.language);
            }

            if (!text) {
                console.log("[VOICEBOT] that turn produced no text");
                await this.say("Sorry, I did not catch that. Could you say it again?");
                return;
            }

            console.log("[VOICEBOT] customer: " + text);
            this.call.turns.push({ role: "customer", text });
            await this.call.save();

            await this.think();
        } finally {
            this.busy = false;
            // Ready for whatever they say next, before they say it
            this.ensureListener();
        }
    }

    /** Work out the next line, say it, and close the call once it has an answer. */
    async think() {
        const { text, outcome, failed } = await voice.nextTurn({
            purpose: this.call.purpose,
            turns: this.call.turns.length
                ? this.call.turns.map((t) => ({
                    role: t.role === "assistant" ? "model" : "user",
                    parts: [{ text: t.text }],
                }))
                : [{ role: "user", parts: [{ text: "(the customer has just answered the phone)" }] }],
            context: this.ticket ? contextFor(this.ticket, this.call.purpose) : "",
            language: this.call.language,
        });

        // An outcome with no text is the model saying the call is done, not a
        // failure. Only a genuinely empty answer is a failure.
        const line = text
            ? text
            : outcome
                ? voice.signOff(this.call.purpose, this.call.language)
                : "Sorry, we are having trouble. The office will call you back shortly.";

        console.log("[VOICEBOT] assistant: " + line);
        this.call.turns.push({ role: "assistant", text: line });

        /**
         * A lite model will report the outcome while still asking something.
         *
         * It did exactly that on a real call: it recorded "not available",
         * asked which time suited them instead, and we hung up on the question
         * because any outcome meant the call was over. So the question is what
         * decides, not the tool call - if the line we are about to speak ends
         * in a question mark, the customer still has something to answer.
         */
        const stillAsking = /[?؟？]\s*$/.test(line.trim());
        const finished = Boolean(outcome) && !stillAsking;

        if (outcome) {
            // Kept either way, so an answer is not lost if they hang up on us
            this.call.outcome = outcome;
        }

        if (finished) {
            this.call.status = "completed";
            this.call.endedAt = new Date();
        }

        await this.call.save();
        if (outcome && this.ticket) await applyOutcome(this.call, this.ticket);

        if (stillAsking && outcome) {
            console.log("[VOICEBOT] outcome noted, but the question stands - staying on the line");
        }

        await this.say(line, finished || failed);
    }

    /**
     * Say a line down the line.
     *
     * Sent in small frames rather than one lump because Exotel plays what it
     * receives as it receives it - a single large frame is buffered somewhere
     * and arrives as a jolt.
     */
    async say(line, thenHangUp = false) {
        this.busy = true;
        this.clearQuietTimer();

        const language = this.call?.language || "odenglish";
        let bytes = 0;

        // Streamed rather than fetched whole: the customer hears the first
        // word about a second sooner, and on a phone call that second is the
        // whole difference between a conversation and a machine.
        const sent = await voice.speakStream(line, language, (pcm) => {
            bytes += pcm.length;
            this.pushAudio(pcm);
        });

        if (!sent) {
            // The socket failed. The finished clip still works, and a late
            // sentence beats a silent line.
            console.error("[VOICEBOT] streaming failed, falling back to the whole clip");
            const clip = await voice.speak(line, language);

            if (!clip) {
                console.error("[VOICEBOT] no audio for that line, the caller hears nothing");
                this.busy = false;
                return;
            }

            return this.playClip(clip, thenHangUp);
        }

        this.afterSpeaking(bytes, thenHangUp);
    }

    /** Breaks samples into the small frames Exotel plays as they arrive. */
    pushAudio(pcm) {
        const frame = 3200; // a fifth of a second

        for (let at = 0; at < pcm.length; at += frame) {
            this.send({
                event: "media",
                stream_sid: this.streamSid,
                media: { payload: pcm.subarray(at, at + frame).toString("base64") },
            });
        }
    }

    /**
     * Holds the turn until the line we just sent has actually finished
     * playing. Without it their next words arrive while we are still talking
     * and get transcribed as ours.
     */
    afterSpeaking(bytes, thenHangUp) {
        const playMs = (bytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;

        setTimeout(() => {
            this.busy = false;
            if (thenHangUp) this.finish();
            else this.armQuietTimer();
        }, playMs + 300);
    }

    /**
     * Pushes a clip down the line in small frames.
     *
     * Sent in pieces because Exotel plays what it receives as it receives it -
     * one large frame is buffered somewhere and arrives as a jolt.
     */
    async playClip(clip, thenHangUp = false) {
        this.busy = true;
        this.clearQuietTimer();

        const pcm = voice.pcmFromWav(Buffer.from(clip, "base64"));
        this.pushAudio(pcm);
        this.afterSpeaking(pcm.length, thenHangUp);
    }

    finish() {
        this.done = true;
        this.clearQuietTimer();
        this.stt?.drop();
        this.stt = null;
        this.send({ event: "stop", stream_sid: this.streamSid });
        try { this.ws.close(); } catch { /* already gone */ }
    }

    async onClose() {
        this.clearQuietTimer();
        this.stt?.drop();
        this.stt = null;
        if (!this.call || this.call.status === "completed") return;

        // The line dropped before an answer. Not a failure worth an alert -
        // people hang up - but the record should not say "talking" for ever.
        this.call.status = this.call.turns.length > 1 ? "no_answer" : "no_answer";
        this.call.endedAt = new Date();
        await this.call.save().catch(() => {});
    }
}

/* ================= WIRING ================= */

// Pulled in lazily: voice.controller requires the socket instance, and
// requiring it at the top of this file would close the loop.
let helpers = null;
const controller = () => {
    if (!helpers) helpers = require("../controllers/voice.controller");
    return helpers;
};

const contextFor = (ticket, purpose) => controller().contextFor(ticket, purpose);
const applyOutcome = (call, ticket) => controller().applyOutcome(call, ticket);

const initVoicebotServer = (httpServer) => {
    const wss = new WebSocketServer({ noServer: true });

    /**
     * socket.io owns its own upgrade path on this same server, so this only
     * claims the one path it needs and leaves every other upgrade alone.
     * Destroying anything else here would take the panels offline.
     */
    httpServer.on("upgrade", (req, socket, head) => {
        let url;
        try {
            url = new URL(req.url, "http://localhost");
        } catch {
            return;
        }
        if (url.pathname !== PATH) return;

        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, url));
    });

    wss.on("connection", (ws, req, url) => {
        console.log("[VOICEBOT] stream opened from " + (req.socket.remoteAddress || "?") + " " + req.url);
        const session = new Session(ws);

        ws.on("message", async (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                console.warn("[VOICEBOT] a frame arrived that was not json, " + raw.length + " bytes");
                return;
            }

            const event = msg.event || msg.type;

            // The first few frames of every call, printed whole. This is how
            // the protocol gets confirmed rather than assumed.
            if (session.frameCount < 3 && event !== "media") {
                console.log("[VOICEBOT] frame " + session.frameCount + ": " + JSON.stringify(msg).slice(0, 600));
            }
            session.frameCount++;

            if (event === "connected") return;

            if (event === "start") {
                console.log("[VOICEBOT] start: " + JSON.stringify(msg).slice(0, 800));
                await session.attach(msg, url).catch((err) =>
                    console.error("[VOICEBOT] attach failed:", err.message));
                return;
            }

            if (event === "media") {
                const payload = msg.media?.payload || msg.payload;
                if (payload) session.onAudio(Buffer.from(payload, "base64"));
                return;
            }

            if (event === "stop" || event === "dtmf") {
                if (event === "stop") session.done = true;
                return;
            }
        });

        ws.on("close", () => {
            console.log("[VOICEBOT] stream closed");
            session.onClose().catch(() => {});
        });

        ws.on("error", (err) => console.error("[VOICEBOT] socket error:", err.message));
    });

    console.log("[VOICEBOT] listening on " + PATH);
    return wss;
};

module.exports = initVoicebotServer;

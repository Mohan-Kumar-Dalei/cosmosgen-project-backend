const axios = require("axios");
const WebSocket = require("ws");
const { GoogleGenAI } = require("@google/genai");

/**
 * The voice stack, kept apart from everything else.
 *
 * Three different vendors do three different jobs on a phone call and none of
 * them belongs in the WhatsApp assistant: Sarvam turns speech into text and
 * text back into speech, because it handles Odia and Indian-accented Hindi far
 * better than the general-purpose engines; Gemini decides what to say; and
 * Twilio carries the line, which lives in the controller because it is HTTP,
 * not intelligence.
 *
 * Nothing here knows about Twilio, tickets or webhooks. It takes audio and a
 * conversation and gives back words and audio, so the same file serves an
 * outbound call today and an inbound one later without being rewritten.
 */

const SARVAM_KEY = process.env.SARVAM_API_KEY;
const SARVAM_BASE = process.env.SARVAM_BASE_URL || "https://api.sarvam.ai";

/**
 * A fast model, deliberately not the one WhatsApp uses.
 *
 * On chat a second of thinking is invisible; on a call it is dead air, and the
 * customer starts talking over it. The lighter model is worth the small drop
 * in polish here, which is why this is its own setting rather than sharing
 * GEMINI_CHAT_MODEL.
 */
const MODEL = process.env.GEMINI_VOICE_MODEL || "gemini-3.1-flash-lite";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/** Sarvam speaks these; the app's three languages map onto them. */
const SARVAM_LANG = {
    odenglish: "od-IN",
    hinglish: "hi-IN",
    english: "en-IN",
};

const langCode = (language) => SARVAM_LANG[language] || SARVAM_LANG.odenglish;

const isVoiceReady = () => Boolean(SARVAM_KEY && process.env.GEMINI_API_KEY);

/* ================= SPEECH IN ================= */

/**
 * What the customer just said.
 *
 * Returns "" rather than throwing on any failure. A call cannot stop and show
 * an error page - the flow above needs to be able to say "sorry, I did not
 * catch that" and carry on, and an empty string is what lets it.
 */
const transcribe = async (audio, language) => {
    if (!SARVAM_KEY || !audio?.length) return "";

    try {
        const form = new FormData();
        form.append("file", new Blob([audio], { type: "audio/wav" }), "turn.wav");
        form.append("language_code", langCode(language));
        form.append("model", process.env.SARVAM_STT_MODEL || "saaras:v3");

        const res = await axios.post(SARVAM_BASE + "/speech-to-text", form, {
            headers: { "api-subscription-key": SARVAM_KEY },
            timeout: 15000,
        });

        return String(res.data?.transcript || "").trim();
    } catch (err) {
        console.error("[VOICE] transcribe failed:", err.response?.data || err.message);
        return "";
    }
};

/* ================= AUDIO ================= */

/** A phone line is 8kHz, 16-bit, mono. Sarvam is asked for better than that. */
const LINE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;

/**
 * Synthesised at 16kHz on purpose, then brought down.
 *
 * Asking Sarvam for 8kHz directly does not merely resample the result - it
 * synthesises at that rate, and the Odia comes out mispronounced, "bhala"
 * turning into "bhalo". Sixteen gives the model room to say the word properly
 * and the line only ever hears the version we reduce.
 */
const SYNTH_RATE = Number(process.env.SARVAM_TTS_RATE) || 22050;

/** How fast the voice reads. One is Sarvam's own conversational speed. */
const TTS_PACE = Number(process.env.SARVAM_TTS_PACE) || 1;

/**
 * The assistant's name, said out loud on every call.
 *
 * A caller who is told they are speaking to an assistant, by name, asks it
 * things - and forgives it for being one. A voice that opens with nothing but
 * business sounds like a recording, which is what Mohan heard. Settable
 * because he chose this name for now rather than for ever.
 */
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || "Sara";

/** Finds the samples in a wav rather than assuming a 44 byte header. */
const pcmFromWav = (wav) => {
    if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") return wav;

    let at = 12;
    while (at + 8 <= wav.length) {
        const id = wav.toString("ascii", at, at + 4);
        const size = wav.readUInt32LE(at + 4);
        if (id === "data") return wav.subarray(at + 8, Math.min(at + 8 + size, wav.length));
        at += 8 + size + (size % 2);
    }
    return wav;
};

/** Wraps bare samples back into a wav, which is what Sarvam's STT accepts. */
const wavFromPcm = (pcm, rate = LINE_RATE) => {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * BYTES_PER_SAMPLE, 28);
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
};

/**
 * Whatever Sarvam synthesised at, down to the 8kHz a phone line carries.
 *
 * Two bugs lived here, and both were audible.
 *
 * The first was a fixed halving. It is right only when synthesis happens at
 * 16kHz, and SARVAM_TTS_RATE was set to 22050 - so 22050 was halved to 11025
 * and then labelled 8000 in the wav header. Exotel believes the header, so
 * every line played back a third too slow and a third too low. That is what
 * Mohan heard on the call and called bass heavy: the pitch really was down.
 * The rate is read rather than assumed now, so changing that setting cannot
 * break the audio again.
 *
 * The second was the filtering. Averaging each pair of samples is a two tap
 * filter that is three decibels down by 2.6kHz, taking the consonants with it.
 * What replaces it is a windowed sinc band pass over the telephone band, 200Hz
 * to 3600Hz, applied before the rate is reduced - flat where intelligibility
 * lives, and steep enough by 4kHz to stop anything above folding back in as a
 * rasp.
 */

/**
 * Enough taps to be flat to 3.6kHz and gone by 4kHz.
 *
 * That is a narrow transition, and a Hamming window needs roughly four over
 * the normalised width to manage it. Sixty three taps measured eleven decibels
 * down across the top speech band - worse than the crude averaging.
 */
const TAP_COUNT = 127;
const BAND_LOW = 200;
const BAND_HIGH = 3600;

/** One coefficient of a windowed sinc band pass, as a difference of low passes. */
const bandPassTaps = (taps, low, high, rate) => {
    const out = new Float64Array(taps);
    const mid = (taps - 1) / 2;
    const fh = high / rate;
    const fl = low / rate;

    for (let i = 0; i < taps; i++) {
        const n = i - mid;

        // sinc(2*fh*n) - sinc(2*fl*n) is the band, and the Hamming window is
        // what stops the truncated sinc ringing.
        const hi = n === 0 ? 2 * fh : Math.sin(2 * Math.PI * fh * n) / (Math.PI * n);
        const lo = n === 0 ? 2 * fl : Math.sin(2 * Math.PI * fl * n) / (Math.PI * n);
        const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));

        out[i] = (hi - lo) * window;
    }

    // Normalised on the response at 1kHz, in the middle of the voice.
    //
    // Dividing by the sum of the taps is what a low pass wants; a band pass
    // blocks DC, so its taps sum to nearly nothing and dividing by that
    // multiplies the whole line by an arbitrary number. Measured, it came out
    // six decibels hot.
    let re = 0;
    let im = 0;
    for (let i = 0; i < taps; i++) {
        const w = (2 * Math.PI * 1000 * (i - mid)) / rate;
        re += out[i] * Math.cos(w);
        im += out[i] * Math.sin(w);
    }

    const gain = Math.hypot(re, im);
    if (gain > 0) for (let i = 0; i < taps; i++) out[i] /= gain;

    return out;
};

const LINE_TAPS = bandPassTaps(TAP_COUNT, BAND_LOW, BAND_HIGH, SYNTH_RATE);

/**
 * A resampler that survives being fed in pieces.
 *
 * Streaming hands us a chunk at a time, and a filter needs the samples either
 * side of the one it is working on. Carrying the unconsumed tail and the
 * fractional position between calls is what stops a click at every chunk
 * boundary and keeps the output rate exact over a long line - a per chunk
 * rounding error of half a sample is a drifting pitch by the end of a sentence.
 */
const makeLineResampler = () => {
    const step = SYNTH_RATE / LINE_RATE; // input samples per output sample
    let history = new Float64Array(TAP_COUNT - 1); // silence to begin with
    let phase = 0;

    return (chunk) => {
        const incoming = Math.floor(chunk.length / BYTES_PER_SAMPLE);
        if (!incoming) return Buffer.alloc(0);

        // Everything the filter can see: what was left over, then the new
        const buf = new Float64Array(history.length + incoming);
        buf.set(history, 0);
        for (let i = 0; i < incoming; i++) {
            buf[history.length + i] = chunk.readInt16LE(i * BYTES_PER_SAMPLE);
        }

        // A filtered sample exists wherever the whole window fits
        const valid = buf.length - TAP_COUNT + 1;
        if (valid < 2) {
            history = buf.slice(0);
            return Buffer.alloc(0);
        }

        const filtered = new Float64Array(valid);
        for (let i = 0; i < valid; i++) {
            let acc = 0;
            for (let j = 0; j < TAP_COUNT; j++) acc += LINE_TAPS[j] * buf[i + j];
            filtered[i] = acc;
        }

        // Output samples land between filtered ones, so they are interpolated
        const room = Math.max(0, Math.ceil((valid - 1 - phase) / step));
        const out = Buffer.alloc(room * BYTES_PER_SAMPLE);
        let at = phase;
        let written = 0;

        while (at + 1 < valid && written < room) {
            const i = Math.floor(at);
            const frac = at - i;
            const value = filtered[i] * (1 - frac) + filtered[i + 1] * frac;

            out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))),
                written * BYTES_PER_SAMPLE);
            written++;
            at += step;
        }

        // Keep from the first sample the next output still needs, and the
        // fraction of a sample we are into it
        const base = Math.floor(at);
        history = buf.slice(base);
        phase = at - base;

        return out.subarray(0, written * BYTES_PER_SAMPLE);
    };
};

/** The same thing for a clip that arrived whole. */
const toLineRate = (pcm) => makeLineResampler()(pcm);

/* ================= LISTENING AS THEY SPEAK ================= */

/**
 * 8kHz up to 16kHz.
 *
 * The streaming recogniser refuses anything but 16kHz, while a phone line only
 * ever carries 8. Nothing is recovered by stretching it - the detail was never
 * on the line - but the format is what the socket asks for, and interpolating
 * between each pair beats repeating samples, which adds a buzz of its own.
 */
const doubleRate = (pcm) => {
    const out = Buffer.alloc(pcm.length * 2);

    for (let i = 0, o = 0; i + 1 < pcm.length; i += 2, o += 4) {
        const a = pcm.readInt16LE(i);
        const b = i + 3 < pcm.length ? pcm.readInt16LE(i + 2) : a;
        out.writeInt16LE(a, o);
        out.writeInt16LE(Math.round((a + b) / 2), o + 2);
    }

    return out;
};

/**
 * A recogniser that listens while the customer is still talking.
 *
 * The one-shot version above waits for the turn to end, then uploads the whole
 * utterance and waits again - two waits the customer sits through in silence.
 * This one has already sent the audio by the time they stop, so ending the
 * turn costs about a third of a second instead of a round trip.
 *
 * Returns a handle, or null if the socket could not be opened, in which case
 * the caller is expected to fall back to `transcribe`. Never throws.
 */
const listenStream = (language) => {
    if (!SARVAM_KEY) return null;

    const model = process.env.SARVAM_STT_STREAM_MODEL || "saarika:v2.5";
    const url = SARVAM_BASE.replace(/^http/, "ws") +
        "/speech-to-text/ws?language-code=" + langCode(language) + "&model=" + model;

    let ws;
    try {
        ws = new WebSocket(url, { headers: { "api-subscription-key": SARVAM_KEY } });
    } catch (err) {
        console.error("[VOICE] could not open the listening socket:", err.message);
        return null;
    }

    let open = false;
    let dead = false;
    let heard = "";
    const queued = [];
    let resolveText = null;

    const settle = () => {
        if (!resolveText) return;
        const done = resolveText;
        resolveText = null;
        done(heard.trim());
    };

    ws.on("open", () => {
        open = true;
        // Anything that arrived during the handshake goes now, in order
        while (queued.length) ws.send(queued.shift());
    });

    ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === "error") {
            console.error("[VOICE] listening socket said:", msg.data?.message);
            dead = true;
            return settle();
        }

        if (msg.type !== "data") return;

        const part = String(msg.data?.transcript || "").trim();
        // Sent in pieces on a long turn, so they are joined rather than
        // replaced - taking only the last one loses the first half of a
        // sentence.
        if (part) heard = heard ? heard + " " + part : part;
        settle();
    });

    ws.on("error", (err) => {
        console.error("[VOICE] listening socket failed:", err.message);
        dead = true;
        settle();
    });

    ws.on("close", () => { dead = true; settle(); });

    return {
        get alive() { return !dead; },

        /** Hands over one frame of line audio, 8kHz, as it arrives. */
        send(pcm) {
            if (dead || !pcm?.length) return;

            const frame = JSON.stringify({
                audio: {
                    data: doubleRate(pcm).toString("base64"),
                    encoding: "audio/wav",
                    sample_rate: 16000,
                },
            });

            if (open) {
                try { ws.send(frame); } catch { dead = true; }
            } else {
                queued.push(frame);
            }
        },

        /**
         * Ends the utterance and gives back what was heard.
         *
         * Sarvam answers a flush with the transcript, so this waits for that
         * rather than for the socket to close. Two seconds is the ceiling: on
         * a call an answer that late is worse than admitting we missed it.
         */
        finish() {
            return new Promise((resolve) => {
                if (dead) return resolve(heard.trim());

                resolveText = resolve;
                try { ws.send(JSON.stringify({ type: "flush" })); } catch { /* closing anyway */ }

                setTimeout(() => {
                    if (resolveText) settle();
                }, 2000);
            }).then((text) => {
                try { ws.close(); } catch { /* already gone */ }
                return text;
            });
        },

        /** Abandons the turn without waiting, when the call is over. */
        drop() {
            dead = true;
            try { ws.close(); } catch { /* already gone */ }
        },
    };
};

/* ================= SPEECH OUT ================= */

/**
 * The line to play down the phone, as a base64 wav.
 *
 * Null on failure, and the caller is expected to fall back to Twilio's own
 * <Say>. A robotic voice reading the right sentence beats a silent line.
 */
const speak = async (text, language) => {
    if (!SARVAM_KEY || !String(text || "").trim()) return null;

    try {
        const res = await axios.post(
            SARVAM_BASE + "/text-to-speech",
            {
                inputs: [String(text).slice(0, 1500)],
                target_language_code: langCode(language),
                speaker: process.env.SARVAM_TTS_SPEAKER || "rupali",
                model: process.env.SARVAM_TTS_MODEL || "bulbul:v3",
                speech_sample_rate: SYNTH_RATE,

                // The streaming path sets this too. Left off here, the greeting
                // prepared while the phone rings would be read at a different
                // speed from every line that follows it.
                pace: TTS_PACE,

                // Our lines are Odia script with English words dropped in, and
                // this is what makes those words read as English rather than
                // as Odia letters sounded out one by one.
                enable_preprocessing: true,
            },
            {
                headers: { "api-subscription-key": SARVAM_KEY, "Content-Type": "application/json" },
                timeout: 15000,
            }
        );

        const clip = res.data?.audios?.[0];
        if (!clip) return null;

        // Everything downstream - the phone line, and the wav the HTTP applet
        // fetches - wants 8kHz, so the reduction happens once, here, rather
        // than in each of them.
        if (SYNTH_RATE === LINE_RATE) return clip;

        const pcm = toLineRate(pcmFromWav(Buffer.from(clip, "base64")));
        return wavFromPcm(pcm, LINE_RATE).toString("base64");
    } catch (err) {
        console.error("[VOICE] speak failed:", err.response?.data || err.message);
        return null;
    }
};

/**
 * The same line, but pushed out as it is made.
 *
 * Sarvam streams: the first audio of a sentence arrives about six hundred
 * milliseconds in, where waiting for the finished clip takes closer to
 * sixteen hundred. On a phone call that difference is the pause the customer
 * hears before every reply, so live turns use this and only the greeting -
 * which is made while the phone is still ringing, when nobody is waiting -
 * uses the one-shot call above.
 *
 * `onPcm` is handed 8kHz mono samples, already reduced, in the order they
 * arrive. Resolves with the total number of bytes sent, or 0 if nothing could
 * be synthesised, which is the caller's signal to fall back.
 */
const speakStream = (text, language, onPcm) => new Promise((resolve) => {
    const line = String(text || "").trim();
    if (!SARVAM_KEY || !line) return resolve(0);

    const model = process.env.SARVAM_TTS_MODEL || "bulbul:v3";
    // send_completion_event is what makes Sarvam say when a sentence is
    // finished. Without it nothing arrives at the end at all, and the only way
    // to know was to treat a gap in the audio as the end - which threw away
    // whole lines whenever the synthesiser paused mid sentence.
    const url = SARVAM_BASE.replace(/^http/, "ws") +
        "/text-to-speech/ws?model=" + model + "&send_completion_event=true";

    let ws;
    try {
        ws = new WebSocket(url, { headers: { "api-subscription-key": SARVAM_KEY } });
    } catch (err) {
        console.error("[VOICE] could not open the speech socket:", err.message);
        return resolve(0);
    }

    let sent = 0;
    let started = false;
    let idle = null;
    let settled = false;

    // Holds the filter's history across chunks, so the seams are inaudible
    const toLine = makeLineResampler();

    const done = () => {
        if (settled) return;
        settled = true;
        if (idle) clearTimeout(idle);
        try { ws.close(); } catch { /* already gone */ }
        resolve(sent);
    };

    /**
     * A safety net, not the end signal.
     *
     * The completion event above is what ends a line. This only catches a
     * socket that goes quiet without ever sending one, and is deliberately
     * long: a short version of this was the end signal once, and it cut lines
     * off wherever the synthesiser paused for breath.
     */
    const touch = () => {
        if (!started) return;
        if (idle) clearTimeout(idle);
        idle = setTimeout(done, 3000);
    };

    // Nothing at all within fifteen seconds means the socket is not coming
    const guard = setTimeout(done, 15000);

    ws.on("open", () => {
        ws.send(JSON.stringify({
            type: "config",
            data: {
                model,
                target_language_code: langCode(language),
                speaker: process.env.SARVAM_TTS_SPEAKER || "rupali",
                pace: TTS_PACE,
                speech_sample_rate: String(SYNTH_RATE),
                output_audio_codec: "wav",
                enable_preprocessing: true,
            },
        }));
        ws.send(JSON.stringify({ type: "text", data: { text: line.slice(0, 1500) } }));
        ws.send(JSON.stringify({ type: "flush" }));
        touch();
    });

    ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === "error") {
            console.error("[VOICE] speech socket said:", msg.data?.message);
            return done();
        }

        // The line is finished, and said so
        if (msg.type === "event" && msg.data?.event_type === "final") return done();

        if (msg.type !== "audio" || !msg.data?.audio) return;

        let chunk = Buffer.from(msg.data.audio, "base64");

        // The first chunk is the wav header on its own, and carries no samples
        if (!started) {
            started = true;
            chunk = pcmFromWav(chunk);
            touch();
            if (!chunk.length) return;
        }

        touch();

        const pcm = SYNTH_RATE === LINE_RATE ? chunk : toLine(chunk);
        if (!pcm.length) return;
        sent += pcm.length;
        try { onPcm(pcm); } catch (err) { console.error("[VOICE] could not play a chunk:", err.message); }
    });

    ws.on("error", (err) => {
        console.error("[VOICE] speech socket failed:", err.message);
        done();
    });

    ws.on("close", (code, reason) => {
        clearTimeout(guard);
        // Sarvam can close without sending an error frame, and then the only
        // evidence of why is the close code.
        if (!sent) console.error("[VOICE] speech socket closed with nothing: " +
            code + " " + (reason?.toString() || "") + " (opened: " + started + ")");
        clearTimeout(guard);
        done();
    });
});

/* ================= WHAT TO SAY ================= */

/**
 * How a call is written, as opposed to a chat.
 *
 * Everything here follows from one fact: the caller cannot re-read anything.
 * No lists, no links, one question at a time, and the answer confirmed back
 * before moving on, because speech recognition mishears Indian names and
 * addresses often enough that assuming it heard right is how a visit ends up
 * at the wrong house.
 */
/**
 * Everything about a call that changes with the language.
 *
 * This used to be Odia written straight into the prompt - the mixing rule, the
 * script note, the little acknowledgements, and a worked example of the
 * opening line. It worked, and it was a trap: a customer who picks Hindi or
 * English would still have been shown an Odia example and would have been
 * answered in Odia. So the language is a parameter, and adding a fourth means
 * adding an entry here rather than editing the prompt.
 */
const STYLE = {
    odenglish: {
        speak: "Odia mixed with English the way it is spoken in Bhubaneswar. " +
            "Odia in Odia script, English words in English letters, in the same sentence. " +
            "Do not translate English words into pure Odia.",
        mix: "Odia sentences with the English words left in English. " +
            '"ଆପଣ booking କରିଥିବା ticket number", not a translated word for booking.',
        script: "Write the Odia in Odia script and the English words in English letters, in\n" +
            "  the same sentence. That is how it is read aloud correctly.",
        nods: '"ହଉ", "ଆଚ୍ଛା", "ଠିକ ଅଛି"',
        intro: "ନମସ୍କାର, ମୁଁ Cosmosgen ର AI assistant " + ASSISTANT_NAME + " କହୁଛି।",
    },

    hinglish: {
        speak: "Hindi mixed with English the way it is spoken in cities - Hinglish, not translated Hindi.",
        mix: "Hindi sentences with the English words left in English. " +
            '"आपने जो booking की थी, ticket number", not a translated word for booking.',
        script: "Write the Hindi in Devanagari and the English words in English letters, in\n" +
            "  the same sentence. That is how it is read aloud correctly.",
        nods: '"हाँ", "अच्छा", "ठीक है"',
        intro: "नमस्ते, मैं Cosmosgen की AI assistant " + ASSISTANT_NAME + " बोल रही हूँ।",
    },

    english: {
        speak: "English, as spoken in India - plain and direct, not formal.",
        mix: "plain English. Do not mix in Odia or Hindi words.",
        script: "Write in ordinary English.",
        nods: '"Right", "Okay", "Sure"',
        intro: "Hello, this is " + ASSISTANT_NAME + ", Cosmosgen's AI assistant.",
    },
};

const styleFor = (language) => STYLE[language] || STYLE.odenglish;

/**
 * How a call is written, as opposed to a chat.
 *
 * Everything here follows from one fact: the caller cannot re-read anything.
 * One question at a time, and the answer confirmed back before moving on,
 * because speech recognition mishears Indian names and addresses often enough
 * that assuming it heard right is how a visit ends up at the wrong house.
 */
const callRules = (language) => {
    const style = styleFor(language);

    return `
You are calling on behalf of Cosmosgen Engineers, a home services company.

HOW TO SPEAK
- This is a phone call. Say your piece, then stop and listen. Two sentences at
  most per turn, and only the opening may be that long.
- Speak the way people actually speak: ` + style.mix + `
  Service names, ticket number, available, reschedule, cancel, assign,
  technician, location - all stay English.
- ` + style.script + `
- Ask ONE thing at a time and wait for the answer.
- Repeat back anything that matters - a day, a time - before moving on.
- If you cannot understand them twice in a row, say the office will call back
  and end the call politely.
- Never quote a price. Never promise an exact arrival time of your own.
- Warm and unhurried, but do not ramble. You are taking a minute of their day.

SOUND LIKE A PERSON ON THE PHONE, NOT A NOTICE BEING READ
- Open a turn the way people do, with a small acknowledgement before the
  substance: ` + style.nods + ` - then the sentence.
- Short sentences. Break a long one in two. Commas stacked into one long
  clause are what makes a line sound written rather than spoken.
- Use the plain spoken word, not the careful one. Say it as you would to a
  neighbour who has picked up the phone.
- No formal openings, no "we would like to inform you", no reading the ticket
  back like a receipt.
- Never say the same sentence twice. If you have to ask again, ask it a
  different way.

YOU ARE AN ASSISTANT, NOT A RECORDING
- You are ` + ASSISTANT_NAME + `, Cosmosgen's AI assistant, and you say so when
  you introduce yourself. People are willing to talk to an assistant; they hang
  up on a recording.
- Whatever they ask, ANSWER IT FIRST, then come back to your own question. If
  they ask who you are, what the charge is, when somebody will come, what the
  problem might be, or why you are calling - answer, briefly, and continue.
  Ignoring their question and repeating yours is the single worst thing you can
  do on this call.
- Answer from what you actually know, which is THIS CALL below and nothing
  more. For a price, an exact arrival time, or anything about the technician
  you have not been told, say plainly that the office will confirm it. Never
  invent a number, a name or a time.
- If they change the subject, follow them, deal with it, and then return to
  what you rang about. If they ask you to call later, agree and end politely.
- If they say something you did not expect, respond to what they said - not to
  what you were planning to say next.
`;
};

const purposeRules = (purpose, language) => {
    const style = styleFor(language);

    /**
     * Placed before anyone is sent out, which is the whole point: a technician
     * who arrives at an empty house has cost the company a trip and the
     * customer their slot.
     */
    if (purpose === "availability") {
        return `
WHY YOU ARE CALLING
Their booking is ready to be assigned to a technician, and you are confirming
it with them before anybody is sent out.

YOUR FIRST TURN has three parts and nothing else. Introduce yourself, say
which booking you are calling about, then ask the question:

  1. Introduce yourself with this exact line: ` + style.intro + `
  2. Then the booking - the real ticket number and the real service from THIS
     CALL below. Saying them is what tells the customer the call is genuine,
     so never skip either one.
  3. Then ask whether they are available for the service today.

Write it in your own words in your language, mixed as described above. It is
three parts of one greeting, not a form to fill in - and after this first turn
you are simply having a conversation.

THEN:
- If they are available today, confirm it warmly and tell them what happens
  next: the office will assign a technician who will reach their location
  soon, and thank them. Do NOT say anyone has been assigned already - nobody
  has, which is why you are ringing.
- If they are not available today, ask which day and roughly what time suits
  them instead. Repeat the day back to them, and say the office will confirm
  the reschedule.
- If they want to cancel, accept it without arguing or persuading, and say the
  office will ring them about it.

When the call is done, and only then, call 'record_availability'. If you are
still asking them anything at all - which day, which time, anything - the call
is NOT done and you must not call it yet.

SPEAK to them in their language, but REPORT to us in English. What you put in
that tool call is read by office staff on an English screen, so a day of
"tomorrow" belongs there, never the customer's own word for it.
`;
    }

    /**
     * Placed after the job closes. Two separate things are being asked here -
     * whether the work was done properly, and how the person behaved - because
     * a vendor can fix an air conditioner perfectly and still be someone the
     * company should not send back.
     */
    return `
WHY YOU ARE CALLING
The job is finished. Introduce yourself first with this exact line:
  ` + style.intro + `
Then say the work on their ticket is complete and you wanted to ask how it
went, in three short steps:

1. Was the problem actually fixed, and is anything still not right?
2. How was the technician himself - on time, polite, tidy?
3. Out of five, what would they give the visit?

Ask them one at a time. Do not read all three out at once. If they only want
to give a number, take the number and thank them.

When the call is done, and only then, call 'record_feedback'.

SPEAK to them in their language, but REPORT to us in English. What you put in
that tool call is read by office staff on an English screen.
`;
};

const AVAILABILITY_TOOL = {
    name: "record_availability",
    description: "Call once, at the end, with what the customer said about today's visit.",
    parameters: {
        type: "OBJECT",
        properties: {
            available: {
                type: "BOOLEAN",
                description: "True if somebody will be at the address today for the visit",
            },
            preferredDay: {
                type: "STRING",
                description: "The day they asked for instead, IN ENGLISH: tomorrow, Saturday, " +
                    "next Monday. Not the customer's own words - the office panel is English. " +
                    "Empty if they are available today.",
            },
            preferredTime: {
                type: "STRING",
                description: "The time of day they asked for, IN ENGLISH: morning, 10 am, " +
                    "after 6 pm. Empty if they did not give one.",
            },
            wantsCancel: { type: "BOOLEAN", description: "True if they asked to cancel the job" },
            note: {
                type: "STRING",
                description: "Anything else the office should know, one line, in English",
            },
        },
        required: ["available"],
    },
};

const FEEDBACK_TOOL = {
    name: "record_feedback",
    description: "Call once, at the end, with what the customer said about the finished job.",
    parameters: {
        type: "OBJECT",
        properties: {
            rating: { type: "NUMBER", description: "Out of five. Use 0 if they would not give one." },
            workOk: { type: "BOOLEAN", description: "True if they said the problem is fixed" },
            behaviourOk: { type: "BOOLEAN", description: "True if they were happy with how the technician behaved" },
            complaint: {
                type: "STRING",
                description: "What went wrong, translated into English for the office, " +
                    "empty if nothing",
            },
            note: {
                type: "STRING",
                description: "Anything else worth passing to the office, one line, in English",
            },
        },
        required: ["rating"],
    },
};

const TOOLS = { availability: AVAILABILITY_TOOL, feedback: FEEDBACK_TOOL };

/**
 * The last thing said before hanging up.
 *
 * When the model decides the call is finished it answers with the tool call
 * and nothing else - there is no sentence to speak. Treating that as a failure
 * is what made every successful call end on the apology line and cut off.
 *
 * Written out rather than asked for, because this is the one moment on a call
 * where another round trip to the model is felt: the customer has answered the
 * question and is waiting to hang up.
 */
const SIGN_OFF = {
    availability: {
        odenglish: "Dhanyabad. Office apananku confirm kari janai deba. Namaskar.",
        hinglish: "Dhanyavad. Office aapko confirm kar dega. Namaste.",
        english: "Thank you. The office will confirm with you shortly. Goodbye.",
    },
    feedback: {
        odenglish: "Apananka samaya pain dhanyabad. Namaskar.",
        hinglish: "Aapke time ke liye dhanyavad. Namaste.",
        english: "Thank you for your time. Goodbye.",
    },
};

/**
 * What to say when the line has gone quiet.
 *
 * A real person says "hello? hello?" into a silent phone, and a bot that
 * simply waits is one the customer assumes has dropped. Two of these, then we
 * stop bothering them.
 */
const NUDGE = {
    odenglish: ["Hello, apana shunuchhanti ki?", "Hello? Mun apananka awaaj shunipariuni."],
    hinglish: ["Hello, aap sun rahe hain?", "Hello? Mujhe aapki awaaz nahi aa rahi."],
    english: ["Hello, are you there?", "Hello? I cannot hear you."],
};

const nudge = (language, attempt = 0) => {
    const lines = NUDGE[language] || NUDGE.odenglish;
    return lines[Math.min(attempt, lines.length - 1)];
};

const signOff = (purpose, language) =>
    (SIGN_OFF[purpose] || SIGN_OFF.availability)[language] ||
    (SIGN_OFF[purpose] || SIGN_OFF.availability).odenglish;



/**
 * The next thing to say, and the outcome once the call has one.
 *
 * `turns` is the conversation so far in Gemini's shape. Returns
 * { text, outcome } - outcome is null until the model decides the call is
 * finished, which is the signal for the caller to hang up.
 */
const nextTurn = async ({ purpose, turns, context, language }) => {
    const tool = TOOLS[purpose];

    try {
        const res = await ai.models.generateContent({
            model: MODEL,
            contents: turns,
            config: {
                systemInstruction:
                    callRules(language) +
                    purposeRules(purpose, language) +
                    "\nSPEAK IN: " + styleFor(language).speak +
                    "\n\nTHIS CALL\n" + (context || ""),
                tools: tool ? [{ functionDeclarations: [tool] }] : undefined,
                temperature: 0.3,
            },
        });

        const call = res.functionCalls?.[0];

        return {
            text: res.text || "",
            outcome: call?.name === tool?.name ? call.args || {} : null,
        };
    } catch (err) {
        console.error("[VOICE] nextTurn failed:", err.message);
        return { text: "", outcome: null, failed: true };
    }
};

module.exports = {
    isVoiceReady,
    signOff,
    nudge,
    pcmFromWav,
    wavFromPcm,
    toLineRate,
    LINE_RATE,
    transcribe,
    listenStream,
    speak,
    speakStream,
    BYTES_PER_SAMPLE,
    nextTurn,
    langCode,
    MODEL,
};

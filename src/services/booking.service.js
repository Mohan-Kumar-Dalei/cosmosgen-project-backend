const Ticket = require("../models/ticket.model");
const UserModel = require("../models/user.model");
const notification = require("./notification.service");
const voiceController = require("../controllers/voice.controller");
const { getServiceByKey } = require("../config/services");
const addressService = require("./address.service");
const { issueToken } = require("./track.service");

/**
 * Registering a job, wherever the customer asked from.
 *
 * This used to live inside the assistant's tool handler, shaped around what a
 * language model needs to read back - sentences, not statuses. The app cannot
 * book through that, and writing a second booking path for it would put the
 * rules in two places: how many open jobs a customer may have, what counts as
 * a duplicate, whether a location is good enough, who gets told afterwards.
 * Two copies of a rule is one copy that is wrong, so the rules live here and
 * both channels call in.
 *
 * Every answer is a code with the facts attached. The assistant turns those
 * into a sentence for the model; the API turns them into a status and a
 * message for a screen. Neither decides anything on its own.
 */

/** A job the customer can still be waiting on. */
const OPEN_STATUSES = ["Pending", "Queued", "Assigned", "In-Progress", "Payment-Pending"];

/**
 * Three at once.
 *
 * Not a technical limit - an honest one. Somebody with four open requests is
 * either testing us or has misunderstood what they are doing, and in both
 * cases another ticket helps nobody.
 */
const MAX_OPEN = 3;

/*
 * When somebody wants the engineer, in the only shapes the office can act on.
 *
 * Booking used to capture what was wrong and nothing about when, so every job
 * arrived as "now" whether or not anybody would be home - and the office found
 * out by ringing. A customer booking at eleven at night for a flat they reach
 * tomorrow evening is the ordinary case, not the exception.
 *
 * Windows rather than times, because an engineer crossing Bhubaneswar cannot
 * promise four o'clock and the office should not print a number it will have
 * to apologise for. Four of them covers a working day.
 */
const SLOT_WINDOWS = ["9 AM - 12 PM", "12 PM - 3 PM", "3 PM - 6 PM", "6 PM - 9 PM"];

/** How far ahead a job may be booked. Beyond this nobody knows their week. */
const BOOK_AHEAD_DAYS = 14;

/**
 * The day and window, checked before they reach the ticket.
 *
 * Absent means "as soon as you can", which is what every caller sent before
 * this existed and is still what WhatsApp sends - so no slot is a valid answer
 * and not a missing one. A day in the past is not: it is a clock that has
 * drifted or a payload somebody typed, and either way the office would be
 * shown a job for last Tuesday.
 */
const readSlot = (scheduledFor, slotWindow) => {
    if (!scheduledFor) return { ok: true, slot: null };

    const day = new Date(scheduledFor);
    if (Number.isNaN(day.getTime())) return { ok: false, code: "bad_slot_date" };

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    if (day < midnight) return { ok: false, code: "slot_in_the_past" };

    const furthest = new Date(midnight);
    furthest.setDate(furthest.getDate() + BOOK_AHEAD_DAYS);
    if (day > furthest) return { ok: false, code: "slot_too_far" };

    const window = String(slotWindow || "").trim();
    if (window && !SLOT_WINDOWS.includes(window)) return { ok: false, code: "bad_slot_window" };

    return { ok: true, slot: { scheduledFor: day, slotWindow: window || "" } };
};

const openTicketsFor = (customerId) =>
    Ticket.find({ customer: customerId, status: { $in: OPEN_STATUSES } })
        .select("ticketNumber status serviceKey serviceLabel technicianSnapshot scheduling")
        .lean();

/**
 * Books the job, or says exactly why it did not.
 *
 * Returns `{ ok: true, ticket }`, or `{ ok: false, code, ... }` where code is
 * one of: unknown_service, no_profile, no_location, already_booked,
 * limit_reached.
 */
const bookJob = async ({
    customerId,
    serviceKey,
    selectedIssues,
    problemDescription,
    channel = "app",
    location,

    /*
     * Which of the customer's saved addresses this job is for.
     *
     * Absent means the account's own, which is what every caller sent before
     * the list existed and is still what the WhatsApp flow sends. Present
     * means somebody picked - the office rather than the house - and it
     * changes only this ticket, never where the customer lives.
     */
    addressId,

    /*
     * When they want somebody, if they said.
     *
     * The office reads this on the assign screen and decides between sending
     * a vendor now and holding the job for the day asked for - which is the
     * whole point of collecting it.
     */
    scheduledFor,
    slotWindow,
}) => {
    const service = getServiceByKey(serviceKey);
    if (!service) return { ok: false, code: "unknown_service" };

    const asked = readSlot(scheduledFor, slotWindow);
    if (!asked.ok) return { ok: false, code: asked.code };

    const user = await UserModel.findById(customerId);
    if (!user) return { ok: false, code: "no_profile" };

    // A pin sent with the booking wins over the one on file: somebody booking
    // from their office wants the job at the office.
    if (location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lon))) {
        user.lat = Number(location.lat);
        user.lon = Number(location.lon);
        user.location = { type: "Point", coordinates: [user.lon, user.lat] };
        if (location.area) user.area = location.area;
        if (location.state) user.state = location.state;
        if (location.address) user.address = location.address;
        await user.save();
    }

    // Dispatch finds the nearest vendor by distance, so a booking with no
    // coordinates has nowhere to send anybody. Letting it through only moves
    // the dead end further down the line.
    if (!Number.isFinite(user.lat) || !Number.isFinite(user.lon)) {
        return { ok: false, code: "no_location" };
    }

    const open = await openTicketsFor(user._id);

    /*
     * A second AC repair is a duplicate. A house cleaning while the AC is
     * being fixed is not - they are unrelated jobs and blocking the second
     * one would be nonsense. So only the same service counts.
     */
    const duplicate = open.find((t) => t.serviceKey === service.key);
    if (duplicate) {
        return {
            ok: false,
            code: "already_booked",
            ticket: duplicate,
            service,
        };
    }

    if (open.length >= MAX_OPEN) {
        return {
            ok: false,
            code: "limit_reached",
            openCount: open.length,
            openServices: open.map((t) => t.serviceLabel),
        };
    }

    /*
     * The pin the technician will drive to, and the address the office reads.
     *
     * Taken once, here, so the snapshot and the point can never disagree -
     * the arrival test measures against the point and the office rings the
     * number on the snapshot, and a job where those two describe different
     * places is a job somebody has to sort out by phone.
     */
    const where = await addressService.resolve(user, addressId);

    const ticket = await Ticket.create({
        channel,
        customer: user._id,
        customerSnapshot: {
            name: user.name,
            phone: user.phone,
            address: where.address,
            area: where.area,
            state: where.state,
            lat: where.lat,
            lon: where.lon,
        },
        location: { type: "Point", coordinates: [where.lon, where.lat] },
        serviceKey: service.key,
        serviceLabel: service.label,
        selectedIssues: Array.isArray(selectedIssues) ? selectedIssues : [],
        problemDescription,
        status: "Pending",

        /*
         * The tracking token exists from the moment the job does.
         *
         * It used to be minted when the customer was first messaged about a
         * technician, which is late - and became later still once that message
         * waited for the technician to accept. The app's map is built on this
         * token, so until it existed the customer had a job with no map at all
         * and nothing to explain why. A job always has a door to draw, even
         * before anybody is coming to it.
         */
        // Absent unless they picked a day - see readSlot.
        ...(asked.slot ? { scheduling: asked.slot } : {}),

        tracking: { token: issueToken(), issuedAt: new Date() },
        statusHistory: [{ to: "Pending", actorRole: channel === "whatsapp" ? "ai" : "customer", at: new Date() }],
    });

    notification.notifyAdminsNewTicket(ticket);

    /**
     * Ring them straight away, before anybody is committed to the job.
     *
     * The whole point of this call is to find out whether somebody will be at
     * the address, so it has to happen while the ticket is still unassigned -
     * a call placed after a vendor is on it has missed its purpose.
     *
     * Not awaited: somebody is waiting on this reply, and a phone call takes a
     * minute. The answer lands on the ticket by the time the office looks at
     * it, and the phone button there does the same thing by hand.
     */
    voiceController.placeCall({ ticket, purpose: "availability" })
        .catch((err) => console.error("[VOICE] availability call failed:", err.message));

    return { ok: true, ticket, service };
};

module.exports = { bookJob, openTicketsFor, OPEN_STATUSES, MAX_OPEN, SLOT_WINDOWS, BOOK_AHEAD_DAYS };

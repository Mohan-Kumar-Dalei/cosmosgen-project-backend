const userModel = require("../models/user.model");
const { lookupPlace } = require("../controllers/map.controller");

/**
 * What it means to be a registered customer, in one place.
 *
 * There are three doors into this product - WhatsApp, the web chat, and the
 * phone apps that follow - and the rule is the same at all of them: nobody
 * talks to the assistant until we know who they are and where they are. Each
 * door used to decide that for itself, which is how a customer could arrive
 * on WhatsApp fully registered from the web and still be asked for their name
 * again.
 */

/**
 * The details a job cannot be dispatched without.
 *
 * Coordinates find the nearest vendor; the pincode and state are what a human
 * reads out when the pin is a few streets off and they have to ring back.
 */
const isRegistered = (user) =>
    Boolean(
        user
        && user.nameConfirmedAt
        && user.languageConfirmedAt
        && Number.isFinite(user.lat)
        && Number.isFinite(user.lon)
        && user.pincode
    );

/**
 * Whether this number has an account somebody typed their own name into.
 *
 * The first half of the gate WhatsApp now stands behind. Deliberately not
 * `isRegistered` above: that one is the full dispatch record, language
 * included, and language is a preference the app never asks for - a customer
 * who registered properly on the app would have failed it and been sent back
 * to register all over again.
 */
const hasAppAccount = (user) => Boolean(user && user.nameConfirmedAt);

/**
 * Whether we know where to send somebody.
 *
 * A dropped pin and nothing else will do. It is tempting to accept a written
 * address instead - it reads like an address, after all - but dispatch finds
 * the nearest vendor by distance and refuses a booking with no coordinates
 * (booking.service.js). Accepting one here would let a customer through the
 * gate, through the whole conversation, and into a booking that cannot be
 * made, on a channel that no longer has any way to ask them for a pin.
 */
const hasPin = (user) => Boolean(user && Number.isFinite(user.lat) && Number.isFinite(user.lon));

/** Both halves: an account, and somewhere to send an engineer. */
const isAppRegistered = (user) => hasAppAccount(user) && hasPin(user);

/**
 * Where we would send somebody, in the few words a person would use.
 *
 * Read back to the customer on WhatsApp so they can see what we hold before a
 * job is raised against it. The pincode is left off on purpose - it confirms
 * nothing to the person who lives there and only makes the line longer.
 */
const whereWeSend = (user) => {
    const parts = [user?.area, user?.city].filter(Boolean);
    if (parts.length) return parts.join(", ");

    const written = String(user?.address || "").trim();
    return written.length > 60 ? written.slice(0, 57).trimEnd() + "..." : written;
};

/** Named so a caller can ask for exactly the one thing still missing. */
const missingFrom = (user) => {
    if (!user) return "everything";
    if (!Number.isFinite(user.lat) || !Number.isFinite(user.lon)) return "location";
    if (!user.languageConfirmedAt) return "language";
    if (!user.nameConfirmedAt) return "name";
    if (!user.pincode) return "address";
    return null;
};

/**
 * Turns a dropped pin into an address a person could read out.
 *
 * WhatsApp sends a latitude and a longitude and, if you are lucky, a place
 * name someone typed. It never sends a pincode or a state, and those are the
 * two things the office asks for first when a pin lands in the wrong lane. So
 * the coordinates are resolved once, here, at the moment they arrive.
 *
 * Never throws. A missing Maps key or a rate limit must not cost us the
 * customer's location - the coordinates alone are still enough to dispatch on,
 * and the rest can be filled in later.
 */
const describeLocation = async (lat, lon) => {
    try {
        const place = await lookupPlace(Number(lat), Number(lon));
        const best = place?.results?.[0];
        if (!best) return null;

        return {
            address: best.formatted_address || "",
            state: best.state || "",
            city: best.city || "",
            area: best.locality || best.city || "",
            pincode: best.pincode || "",
        };
    } catch (err) {
        console.error("[REGISTRATION] reverse geocode failed:", err.message);
        return null;
    }
};

/**
 * Writes a pin and everything we can work out from it onto the customer.
 *
 * `fallbackAddress` is whatever the channel already had - the place name
 * WhatsApp attaches to a pin, or what somebody typed into the web form. It is
 * only used when Google gives us nothing better, so a real street address is
 * never overwritten by "Shared location".
 */
const applyLocation = async (phone, { lat, lon, fallbackAddress = "", name } = {}) => {
    const numLat = Number(lat);
    const numLon = Number(lon);
    const hasCoords = Number.isFinite(numLat) && Number.isFinite(numLon);

    const set = {};

    if (hasCoords) {
        set.lat = numLat;
        set.lon = numLon;
        set.location = { type: "Point", coordinates: [numLon, numLat] };

        const place = await describeLocation(numLat, numLon);
        if (place) {
            set.address = place.address || fallbackAddress || "";
            if (place.state) set.state = place.state;
            if (place.city) set.city = place.city;
            if (place.area) set.area = place.area;
            if (place.pincode) set.pincode = place.pincode;
        } else if (fallbackAddress) {
            set.address = fallbackAddress;
        }
    } else if (fallbackAddress) {
        set.address = fallbackAddress;
    }

    return userModel
        .findOneAndUpdate(
            { phone },
            {
                $set: set,
                // The channel's nickname is a placeholder until they type a
                // real name, so it is only ever written on the way in.
                $setOnInsert: { phone, name: name || "WhatsApp customer" },
            },
            { returnDocument: "after", upsert: true }
        )
        .lean();
};

module.exports = { isRegistered, isAppRegistered, hasAppAccount, hasPin, whereWeSend, missingFrom, describeLocation, applyLocation };

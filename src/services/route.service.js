const axios = require("axios");

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const keyring = require("./keyring.service");
const mapUsage = require("./mapUsage.service");
const redis = require("../config/redis");

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

/** Never ask for more than this many at once - see computeRouteMatrix. */
const MATRIX_MAX = 5;

/**
 * One route call, reused everywhere.
 *
 * The technician's map, the ETA in the customer's WhatsApp message and the
 * answer the AI gives when the customer asks "kitni der" all come from this
 * single response. Calling Google separately for each of those would bill us
 * three times for the same road.
 *
 * Returns null on any failure instead of throwing - a missing ETA should
 * never be the reason a technician can't start a ride.
 */
/**
 * He is on a motorcycle, and the road network he can use is not a car's.
 *
 * This asked for DRIVE from the first day, which is the wrong question. Mohan
 * rode a test down the lanes he actually takes and the line never followed
 * him: the answer kept coming back as a kilometre and a quarter of main road
 * for three hundred metres of lanes, with a U-turn at the start, because a car
 * cannot use the cut-throughs and Google was being asked about a car. The
 * customer watched the distance grow while the bike got closer.
 *
 * TWO_WHEELER is the mode Google built for exactly this - it is offered in
 * India and it routes through the narrow roads a bike can take. It is the same
 * billing as DRIVE and it is a truer answer besides: a motorcycle's ETA
 * through city traffic is not a car's.
 *
 * Not every country has it, so a refusal falls back to DRIVE rather than
 * leaving the ride with no route at all.
 */
const RIDE_MODE = "TWO_WHEELER";

const computeRoute = async (origin, destination, { heading } = {}) => {
    if (!API_KEY) {
        console.warn("[ROUTE] GOOGLE_MAPS_API_KEY missing - route skipped");
        return null;
    }

    const oLat = Number(origin?.lat);
    const oLon = Number(origin?.lon);
    const dLat = Number(destination?.lat);
    const dLon = Number(destination?.lon);

    if (![oLat, oLon, dLat, dLon].every(Number.isFinite)) {
        console.warn("[ROUTE] Invalid coordinates - route skipped");
        return null;
    }

    /*
     * Which way he is already pointing.
     *
     * Without it Google answers from a standing start and is free to send him
     * back the way he came - so a route redrawn mid-ride began with a U-turn,
     * and the customer's line doubled back on itself before setting off. A
     * heading says "he is moving, this way", and the route it returns is one a
     * rider can actually take from where he is.
     */
    const facing = Number.isFinite(Number(heading))
        ? Math.round((((Number(heading) % 360) + 360) % 360))
        : null;

    const ask = (travelMode, pointing) => axios.post(
        ROUTES_URL,
        {
            origin: {
                // The heading belongs to the location, not to the waypoint
                // around it. Sent a level up it is not an unknown field that
                // Google ignores - it refuses the whole request, and a refused
                // request means no route at all.
                location: {
                    latLng: { latitude: oLat, longitude: oLon },
                    ...(pointing === null ? {} : { heading: pointing }),
                },
            },
            destination: { location: { latLng: { latitude: dLat, longitude: dLon } } },
            travelMode,
            // TRAFFIC_AWARE puts this on the Pro SKU. Worth it: an ETA that
            // ignores traffic is worse than no ETA, because we send it to
            // the customer as a promise.
            routingPreference: "TRAFFIC_AWARE",
            languageCode: "en-IN",
            units: "METRIC",
        },
        {
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": API_KEY,
                // Anything beyond these three fields would push the request
                // into a higher SKU for data we don't draw or display.
                "X-Goog-FieldMask":
                    "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
            },
            timeout: 8000,
        }
    );

    try {
        keyring.count("google");
        mapUsage.record("routes");

        /*
         * Ask the best question first, and keep asking simpler ones.
         *
         * A route that comes back null is not a missing ETA - it leaves the
         * ticket carrying the line it already had, so the customer's map holds
         * a road the rider has left and stops moving until something else
         * rescues it. That is precisely what one rejected field did: the
         * heading was sent a level too high, Google refused every request, and
         * the bike sat still for a whole journey.
         *
         * So the fall back goes all the way down to the plainest request there
         * is. Anything that still fails after that is Google being down, and
         * there is nothing to ask for.
         */
        const attempts = [
            [RIDE_MODE, facing],
            ["DRIVE", facing],
            [RIDE_MODE, null],
            ["DRIVE", null],
        ];

        let route = null;

        for (const [mode, pointing] of attempts) {
            const response = await ask(mode, pointing).catch((error) => {
                console.warn(
                    "[ROUTE] " + mode + (pointing === null ? "" : " with a heading")
                    + " refused: " + (error.response?.data?.error?.message || error.message)
                );
                return null;
            });

            route = response?.data?.routes?.[0] || null;
            if (route) break;
        }
        if (!route) {
            console.warn("[ROUTE] No route found between the two points");
            return null;
        }

        // Google returns duration as a protobuf string like "1830s".
        const durationSeconds = Number(String(route.duration || "").replace("s", "")) || null;

        return {
            durationSeconds,
            distanceMeters: route.distanceMeters ?? null,
            encodedPolyline: route.polyline?.encodedPolyline || null,
        };
    } catch (error) {
        console.error("[ROUTE] compute failed:", error.response?.data || error.message);
        return null;
    }
};

/**
 * Turns raw seconds into something a person would actually say. Customers read
 * "about 25 minutes", not "1523 seconds", and rounding to 5-minute buckets
 * stops us from promising a precision traffic data cannot support.
 */
const formatEta = (seconds) => {
    if (!Number.isFinite(Number(seconds))) return null;

    const mins = Math.round(Number(seconds) / 60);
    if (mins < 5) return "under 5 minutes";

    const rounded = Math.round(mins / 5) * 5;
    if (rounded < 60) return "about " + rounded + " minutes";

    const hours = Math.floor(rounded / 60);
    const rem = rounded % 60;
    if (rem === 0) return "about " + hours + (hours === 1 ? " hour" : " hours");
    return "about " + hours + "h " + rem + "m";
};


/**
 * Real road distance from one point to a handful of others, in one request.
 *
 * The assignment screen ranks technicians by straight line, which is free,
 * instant and almost always the same order a road would give. What it cannot
 * do is tell the office how far somebody really is: a technician eight
 * hundred metres away across a river is not the nearest one. So the ranking
 * stays as it is and the top few get a real road figure to show.
 *
 * One request, not one per technician - Route Matrix bills per pair, so five
 * technicians in one call costs what five separate calls would, minus four
 * round trips. The cap is the whole point of the design: without it, an
 * office opening a screen that lists twenty people would bill twenty pairs
 * every time, for rows nobody was going to pick.
 *
 * Returns an array the same length and order as `destinations`, each entry
 * either a figure or null. Never throws: a screen without road distances is
 * the screen we had yesterday, and that is a fine thing to fall back to.
 */
/**
 * One pair, as Redis files it.
 *
 * Four decimals is about eleven metres, which is the same grain the reverse
 * geocode cache uses and for the same reason: a vendor waiting at his shop
 * between jobs reports the same square over and over, and the customer's door
 * does not move at all. So the second booking into that neighbourhood, and the
 * third, and the office opening the assign screen twice, all find the answer
 * already here.
 */
const pairKey = (o, d) =>
    "mx:" + o.lat.toFixed(4) + "," + o.lon.toFixed(4)
    + ">" + d.lat.toFixed(4) + "," + d.lon.toFixed(4);

/**
 * How long a measured pair is worth keeping.
 *
 * The distance between two points does not change; the time does, because it
 * is traffic-aware. Ten minutes is short enough that the office is never shown
 * a stale ETA and long enough to cover a run of bookings in one area and the
 * same screen being opened again.
 */
const PAIR_KEEP_SECONDS = 10 * 60;

const computeRouteMatrix = async (origin, destinations = []) => {
    if (!API_KEY || !destinations.length) return [];

    const oLat = Number(origin?.lat);
    const oLon = Number(origin?.lon);
    if (![oLat, oLon].every(Number.isFinite)) return destinations.map(() => null);

    const wanted = destinations.slice(0, MATRIX_MAX);
    const out = destinations.map(() => null);

    const points = wanted.map((d) => ({
        lat: Number(d?.lat),
        lon: Number(d?.lon),
    }));

    if (points.some((p) => ![p.lat, p.lon].every(Number.isFinite))) {
        return out;
    }

    /*
     * Whatever is already known, and then only the rest.
     *
     * This is billed per pair rather than per request, so a half-remembered
     * screen is a half-price screen - there is no reason to ask for five when
     * three of them are already in hand. The misses keep their places, so what
     * comes back is in the order the caller asked for.
     */
    const from = { lat: oLat, lon: oLon };

    const known = await Promise.all(
        points.map((p) => redis.remembered(pairKey(from, p)).catch(() => null))
    );

    const missing = [];
    points.forEach((p, i) => {
        if (known[i]) out[i] = known[i];
        else missing.push({ at: i, p });
    });

    if (!missing.length) return out;

    try {
        keyring.count("google");
        mapUsage.record("matrix");

        const response = await axios.post(
            MATRIX_URL,
            {
                origins: [{
                    waypoint: { location: { latLng: { latitude: oLat, longitude: oLon } } },
                }],
                destinations: missing.map(({ p }) => ({
                    waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lon } } },
                })),
                travelMode: "DRIVE",
                // The same trade the single route call makes: an ETA that
                // ignores traffic is worse than none, because the office
                // dispatches on it.
                routingPreference: "TRAFFIC_AWARE",
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": API_KEY,
                    // Nothing beyond this, or the request climbs a SKU for
                    // data the screen does not draw
                    "X-Goog-FieldMask":
                        "originIndex,destinationIndex,duration,distanceMeters,condition",
                },
                timeout: 8000,
            }
        );

        for (const cell of response.data || []) {
            if (cell?.condition !== "ROUTE_EXISTS") continue;

            const slot = cell.destinationIndex;
            if (!Number.isInteger(slot) || slot >= missing.length) continue;

            const at = missing[slot].at;

            /*
             * Zero is a real answer here, and it arrives as nothing.
             *
             * Protobuf JSON leaves a field out when it holds its default, so
             * a technician standing at the customer's door comes back with no
             * distanceMeters at all. Read as "missing" that turned into a
             * null and the row fell back to straight line - the one case
             * where the road figure was certainly right. The condition above
             * already said the route exists, so absent means nought.
             */
            const seconds = Number(String(cell.duration ?? "0s").replace("s", ""));

            out[at] = {
                durationSeconds: Number.isFinite(seconds) ? seconds : null,
                distanceMeters: cell.distanceMeters ?? 0,
            };

            // Not awaited: the office has its answer already.
            redis.remember(pairKey(from, missing[slot].p), out[at], PAIR_KEEP_SECONDS);
        }
    } catch (error) {
        console.error("[ROUTE] matrix failed:", error.response?.data || error.message);
    }

    return out;
};

module.exports = { computeRoute, computeRouteMatrix, formatEta, MATRIX_MAX };

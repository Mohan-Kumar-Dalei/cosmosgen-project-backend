const axios = require("axios");

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const keyring = require("./keyring.service");

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
const computeRoute = async (origin, destination) => {
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

    try {
        keyring.count("google");
        const response = await axios.post(
            ROUTES_URL,
            {
                origin: { location: { latLng: { latitude: oLat, longitude: oLon } } },
                destination: { location: { latLng: { latitude: dLat, longitude: dLon } } },
                travelMode: "DRIVE",
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

        const route = response.data?.routes?.[0];
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

    try {
        keyring.count("google");

        const response = await axios.post(
            MATRIX_URL,
            {
                origins: [{
                    waypoint: { location: { latLng: { latitude: oLat, longitude: oLon } } },
                }],
                destinations: points.map((p) => ({
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

            const at = cell.destinationIndex;
            if (!Number.isInteger(at) || at >= out.length) continue;

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
        }
    } catch (error) {
        console.error("[ROUTE] matrix failed:", error.response?.data || error.message);
    }

    return out;
};

module.exports = { computeRoute, computeRouteMatrix, formatEta, MATRIX_MAX };

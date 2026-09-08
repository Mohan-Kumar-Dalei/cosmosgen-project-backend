const axios = require("axios");

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

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

module.exports = { computeRoute, formatEta };

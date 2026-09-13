const axios = require("axios");

const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE = 1000;

const getCache = (key) => {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.time > CACHE_TTL) {
        cache.delete(key);
        return null;
    }
    return hit.value;
};

const setCache = (key, value) => {
    if (cache.size >= MAX_CACHE) {
        cache.delete(cache.keys().next().value); // drop the oldest entry
    }
    cache.set(key, { value, time: Date.now() });
};

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const keyring = require("../services/keyring.service");

// Every response we build for the frontend keeps the same shape the old
// Nominatim version returned, so nothing downstream had to change.
const noKey = (res) =>
    res.status(503).json({ success: false, message: "Map service is not configured" });

// Pull the pieces we care about out of a Google addressComponents array.
// Google returns components in a fixed schema, so a single reader works for
// both Geocoding and Place Details.
const readComponents = (components = []) => {
    const pick = (type) => components.find((c) => (c.types || []).includes(type));

    // Google is inconsistent about which level holds the "locality" people
    // actually recognise, so we walk from most specific to least.
    const areaSource =
        pick("sublocality_level_1") ||
        pick("sublocality") ||
        pick("neighborhood") ||
        pick("locality") ||
        pick("administrative_area_level_3") ||
        pick("administrative_area_level_2");

    const citySource = pick("locality") || pick("administrative_area_level_2") || areaSource;

    // Geocoding uses long_name / Places (New) uses longText - accept both.
    const text = (c) => (c ? c.long_name || c.longText || "" : "");

    return {
        state: text(pick("administrative_area_level_1")),
        area: text(areaSource),
        city: text(citySource),
        pincode: text(pick("postal_code")),
    };
};

/**
 * A coordinate turned into place names, for callers inside the server.
 *
 * The route handler below is one of them; the assign panel is the other,
 * which needs a city to search technicians by and has only a dropped pin to
 * work from. Both share the cache, so the second caller for a given point
 * costs nothing.
 *
 * Returns null when Google genuinely has nothing there, and throws only on a
 * transport or API failure - so a caller that can carry on without a name is
 * free to swallow it.
 */
const lookupPlace = async (lat, lon) => {
    if (!API_KEY) return null;

    // 4 decimals is roughly 11 metres, which lifts the cache hit rate a lot
    // without moving the pin anywhere the user would notice.
    const key = `rev:${lat.toFixed(4)}:${lon.toFixed(4)}`;
    const cached = getCache(key);
    if (cached) return cached;

    keyring.count("google");
    const response = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
        params: {
            latlng: `${lat},${lon}`,
            key: API_KEY,
            region: "in",
            language: "en",
            result_type: "street_address|premise|sublocality|locality|postal_code",
        },
        timeout: 8000,
    });

    const status = response.data?.status;

    // Google answers 200 OK even when it found nothing, so the status string
    // is the only real signal here.
    if (status === "ZERO_RESULTS") return null;
    if (status !== "OK") {
        console.error("Google reverse geocode status:", status, response.data?.error_message || "");
        throw new Error("Reverse geocode failed: " + status);
    }

    const best = response.data.results[0];
    const parts = readComponents(best.address_components);

    const data = {
        results: [{
            formatted_address: best.formatted_address,
            state: parts.state,
            locality: parts.area,
            city: parts.city,
            pincode: parts.pincode,
        }],
    };

    setCache(key, data);
    return data;
};

// GET /api/map/rev-geocode?lat=..&lon=..
const reverseGeocode = async (req, res) => {
    if (!API_KEY) return noKey(res);

    try {
        const lat = Number(req.query.lat);
        const lon = Number(req.query.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return res.status(400).json({ success: false, message: "Latitude and Longitude are required" });
        }
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            return res.status(400).json({ success: false, message: "Coordinates out of range" });
        }

        const data = await lookupPlace(lat, lon);
        if (!data) {
            return res.status(404).json({ success: false, message: "Address not found for these coordinates" });
        }

        return res.status(200).json({ success: true, data });
    } catch (error) {
        console.error("Reverse geocode error:", error.response?.data || error.message);
        return res.status(500).json({ success: false, message: "Failed to fetch address" });
    }
};

// GET /api/map/search?q=..&session=..
// Autocomplete only returns predictions - no coordinates. The client sends the
// chosen placeId to /api/map/place to get those. Splitting it this way means we
// make one billed detail call per selection instead of one per keystroke.
const searchPlaces = async (req, res) => {
    if (!API_KEY) return noKey(res);

    try {
        const q = String(req.query.q || "").trim();
        const sessionToken = String(req.query.session || "").trim();

        if (q.length < 3) {
            return res.status(400).json({ success: false, message: "Query must be at least 3 characters" });
        }
        if (q.length > 120) {
            return res.status(400).json({ success: false, message: "Query too long" });
        }

        // Predictions are only cached when there is no session token. Caching a
        // tokened response would hand the same token to a second user and
        // Google would void the session.
        const key = `search:${q.toLowerCase()}`;
        if (!sessionToken) {
            const cached = getCache(key);
            if (cached) {
                return res.status(200).json({ success: true, cached: true, data: cached });
            }
        }

        const body = {
            input: q,
            includedRegionCodes: ["in"],
            languageCode: "en",
        };
        if (sessionToken) body.sessionToken = sessionToken;

        keyring.count("google");
        const response = await axios.post(
            "https://places.googleapis.com/v1/places:autocomplete",
            body,
            {
                headers: {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": API_KEY,
                    "X-Goog-FieldMask":
                        "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
                },
                timeout: 8000,
            }
        );

        const suggestions = Array.isArray(response.data?.suggestions) ? response.data.suggestions : [];

        const results = suggestions
            .map((s) => s.placePrediction)
            .filter(Boolean)
            .map((p) => ({
                // placeId replaces the old lat/lon/pincode fields. Those now
                // arrive from /api/map/place once the user picks a suggestion.
                placeId: p.placeId,
                label: p.text?.text || "",
                mainText: p.structuredFormat?.mainText?.text || "",
                secondaryText: p.structuredFormat?.secondaryText?.text || "",
            }))
            .slice(0, 5);

        if (!sessionToken) setCache(key, results);
        return res.status(200).json({ success: true, cached: false, data: results });
    } catch (error) {
        console.error("Search places error:", error.response?.data || error.message);
        return res.status(500).json({ success: false, message: "Failed to search location" });
    }
};

// GET /api/map/place?placeId=..&session=..
// Only Essentials-tier fields are requested. Asking for anything outside that
// list (ratings, opening hours, phone) would move the whole call to a pricier
// SKU for data this form never shows.
const placeDetails = async (req, res) => {
    if (!API_KEY) return noKey(res);

    try {
        const placeId = String(req.query.placeId || "").trim();
        const sessionToken = String(req.query.session || "").trim();

        if (!placeId) {
            return res.status(400).json({ success: false, message: "placeId is required" });
        }

        // A place's address does not move, so this cache is safe to keep for
        // the full TTL and saves a billed call on repeat selections.
        const key = `place:${placeId}`;
        const cached = getCache(key);
        if (cached) {
            return res.status(200).json({ success: true, cached: true, data: cached });
        }

        keyring.count("google");
        const response = await axios.get(
            `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
            {
                params: {
                    languageCode: "en",
                    ...(sessionToken ? { sessionToken } : {}),
                },
                headers: {
                    "X-Goog-Api-Key": API_KEY,
                    "X-Goog-FieldMask": "id,formattedAddress,location,addressComponents",
                },
                timeout: 8000,
            }
        );

        const place = response.data;
        if (!place?.location) {
            return res.status(404).json({ success: false, message: "Place not found" });
        }

        const parts = readComponents(place.addressComponents);

        const data = {
            placeId: place.id,
            label: place.formattedAddress || "",
            state: parts.state,
            area: parts.area,
            city: parts.city,
            pincode: parts.pincode,
            lat: place.location.latitude,
            lon: place.location.longitude,
        };

        setCache(key, data);
        return res.status(200).json({ success: true, cached: false, data });
    } catch (error) {
        console.error("Place details error:", error.response?.data || error.message);
        return res.status(500).json({ success: false, message: "Failed to fetch place details" });
    }
};

module.exports = { reverseGeocode, searchPlaces, placeDetails, lookupPlace };

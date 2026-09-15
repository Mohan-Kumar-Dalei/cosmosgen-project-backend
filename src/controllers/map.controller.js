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
const { searchCities } = require("../config/cities");

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
/**
 * The free map of last resort.
 *
 * OpenStreetMap's Nominatim, which this project used before Google and which
 * is still here for the two cases that actually happen: no key configured on a
 * machine, and Google refusing - a billing lapse, a quota, a key restricted to
 * the wrong referrer. None of those are the vendor's fault, and none of them
 * should be the reason a registration cannot be finished.
 *
 * Free, so it is never the first choice: its terms ask for one request per
 * second and a real user agent, and its Indian addresses are patchier than
 * Google's. As a floor under a form it is worth far more than an error.
 *
 * Never throws. A fallback that can fail loudly is not a fallback.
 */
const lookupPlaceFree = async (lat, lon) => {
    try {
        const { data } = await axios.get("https://nominatim.openstreetmap.org/reverse", {
            params: { lat, lon, format: "json", zoom: 18, addressdetails: 1 },
            headers: { "User-Agent": "Cosmosgen/1.0 (support@cosmosgen.in)" },
            timeout: 8000,
        });

        const a = data?.address;
        if (!a) return null;

        return {
            results: [{
                formatted_address: data.display_name || "",
                state: a.state || "",
                locality: a.suburb || a.neighbourhood || a.village || "",
                city: a.city || a.town || a.municipality || a.village || a.county || "",
                pincode: a.postcode || "",
            }],
            provider: "osm",
        };
    } catch (err) {
        console.error("[MAP] OSM fallback failed:", err.message);
        return null;
    }
};

const lookupPlace = async (lat, lon) => {
    if (!API_KEY) return lookupPlaceFree(lat, lon);

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
        // Not fatal any more. Whatever Google's reason - quota, billing, a key
        // locked to the wrong site - the free map is asked before giving up,
        // so a vendor mid-registration gets an address rather than a failure.
        console.error("Google reverse geocode status:", status, response.data?.error_message || "");
        return lookupPlaceFree(lat, lon);
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

/**
 * GET /api/map/areas?pincode=751024
 *
 * The localities inside one pincode, so "which part of Bhubaneswar" is a
 * choice rather than a spelling.
 *
 * Asked of India Post, whose directory is the authority on this and who charge
 * nothing for it: no key, no quota, no bill. Google could answer the same
 * question through Places, at roughly five dollars a thousand and with its own
 * idea of where a neighbourhood ends. The post office's names are the ones
 * written on envelopes, which is also what a vendor will recognise.
 *
 * Cached hard, because a pincode's post offices do not change from one week to
 * the next - so a town everybody registers from is fetched once and answered
 * from memory after that.
 *
 * Never fails loudly. If the directory is unreachable the form falls back to a
 * plain text box, which is what it would have been anyway.
 */
const areas = async (req, res) => {
    const pincode = String(req.query.pincode || "").replace(/\D/g, "");

    if (pincode.length !== 6) {
        return res.status(400).json({ success: false, message: "Send a six digit pincode." });
    }

    const key = "pin:" + pincode;
    const cached = getCache(key);
    if (cached) return res.status(200).json({ success: true, data: cached });

    try {
        const { data } = await axios.get("https://api.postalpincode.in/pincode/" + pincode, {
            timeout: 8000,
        });

        const first = Array.isArray(data) ? data[0] : null;
        const offices = (first && first.PostOffice) || [];

        /*
         * One entry per locality, tidied.
         *
         * The directory returns a post office rather than a neighbourhood, so
         * a few are the town's own name repeated and a few carry a suffix
         * nobody says out loud - "Patia Gds" is the goods office at Patia. The
         * name is kept as the post office writes it, because that is what
         * matches an envelope, and the district is carried alongside so two
         * places called the same thing can be told apart.
         */
        const list = offices
            .map((office) => ({
                name: String(office.Name || "").trim(),
                district: String(office.District || "").trim(),
                state: String(office.State || "").trim(),
            }))
            .filter((row) => row.name);

        setCache(key, list);
        return res.status(200).json({ success: true, data: list });
    } catch (error) {
        console.error("[MAP] Pincode directory failed:", error.message);
        // An empty list, not an error: the form offers a text box instead
        return res.status(200).json({ success: true, data: [] });
    }
};

/**
 * GET /api/map/cities?q=
 *
 * The towns this company works in, matched against what is being typed. Reads
 * a bundled list - no provider, no key, no bill, and an answer in under a
 * millisecond whether or not anything else is reachable.
 *
 * This is what replaced Places Autocomplete on the vendor form, where a paid
 * request went out on every keystroke before anybody had even signed up.
 */
const cities = (req, res) => {
    const list = searchCities(req.query.q, 8);
    return res.status(200).json({ success: true, data: list });
};

module.exports = {
    cities,
    areas, reverseGeocode, searchPlaces, placeDetails, lookupPlace };

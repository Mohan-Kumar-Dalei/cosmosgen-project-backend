const axios = require("axios");

const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE = 4000;

const getCache = (key, ttl = CACHE_TTL) => {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.time > ttl) {
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
const mapUsage = require("../services/mapUsage.service");
const { searchCities, findCity } = require("../config/cities");
const technicianModel = require("../models/technician.model");
const { extraAreasFor } = require("../config/localities");

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
    mapUsage.record("geocode");
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
    mapUsage.record("autocomplete");
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
    mapUsage.record("details");
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
 * Every locality inside one town, with the pincode each one belongs to.
 *
 * A vendor says "Rasulgarh, Bhubaneswar" - he does not say 751010, and asking
 * him to produce it before he can name his own neighbourhood is the wrong way
 * round. So the town is what this takes, and the pincode is what it gives
 * back: picking Rasulgarh fills in 751010 without anybody typing a digit.
 *
 * India Post is the source, and it charges nothing. It has no "list a town"
 * endpoint though - only "what is at this pincode" - so a town is read by
 * walking the block of pincodes its head office sits at the bottom of. Indian
 * pincodes are allocated in contiguous blocks per town, which is what makes
 * that work: Bhubaneswar is 751001 upwards, and Jatni and Khordha are in the
 * 7520xx block rather than scattered through this one.
 *
 * Two things keep a slightly-too-wide guess harmless. A pincode that does not
 * exist simply answers with nothing, and anything belonging to a different
 * district is dropped - so the walk can overshoot without dragging a
 * neighbouring town's streets in.
 *
 * Roughly thirty requests the first time a town is asked for, and none ever
 * again: the answer is cached for a month, because a post office does not move.
 */
const SCAN_SPAN = 40;
const SCAN_AT_ONCE = 5;
const AREA_TTL = 30 * 24 * 60 * 60 * 1000;

/** One pincode's post offices, or an empty list. Never throws. */
const officesAt = async (pincode) => {
    try {
        const { data } = await axios.get("https://api.postalpincode.in/pincode/" + pincode, {
            timeout: 8000,
        });
        const first = Array.isArray(data) ? data[0] : null;
        return (first && first.PostOffice) || [];
    } catch {
        return [];
    }
};

const areasForTown = async (town) => {
    const key = "town:" + town.city.toLowerCase();
    const cached = getCache(key, AREA_TTL);
    if (cached) return cached;

    const base = Number(town.pincode);
    if (!Number.isFinite(base)) return [];

    /*
     * A short rest after a refusal.
     *
     * Walking a town is forty requests, and India Post will rate limit for it
     * - which it did, immediately, under testing. Without this a town that is
     * being refused would set forty more requests going on every single
     * keystroke, which is both useless and the fastest way to be blocked for
     * longer. Ten minutes of quiet, then try again.
     */
    const cool = "cool:" + key;
    if (getCache(cool, 10 * 60 * 1000)) return [];

    // The head office first, because its district is what the rest is judged
    // against - and if even that answers nothing there is no block to walk
    const head = await officesAt(base);
    if (!head.length) {
        setCache(cool, true);
        return [];
    }

    const district = String(head[0].District || "").toLowerCase();
    const found = new Map();

    const keep = (offices) => {
        for (const office of offices) {
            if (String(office.District || "").toLowerCase() !== district) continue;
            const name = String(office.Name || "").trim();
            if (name && !found.has(name)) {
                found.set(name, String(office.Pincode || "").trim());
            }
        }
    };

    keep(head);

    // In small groups rather than all at once - this is somebody else's free
    // service and forty simultaneous requests is not how to treat one
    for (let from = 1; from <= SCAN_SPAN; from += SCAN_AT_ONCE) {
        const batch = [];
        for (let i = from; i < from + SCAN_AT_ONCE && i <= SCAN_SPAN; i += 1) {
            batch.push(officesAt(base + i));
        }
        (await Promise.all(batch)).forEach(keep);
    }

    const list = Array.from(found, ([name, pincode]) => ({ name, pincode }))
        .sort((a, b) => a.name.localeCompare(b.name));

    setCache(key, list);
    return list;
};

/**
 * The localities our own vendors have already named, for one town.
 *
 * India Post lists post offices, and a great many real neighbourhoods do not
 * have one - Palasuni is a well known part of Bhubaneswar and its post is
 * handled by Rasulgarh, so the directory has never heard of it. Those gaps are
 * exactly where a vendor types something rather than picking it.
 *
 * So what one vendor types becomes what the next one is offered. The list
 * fills itself in from real answers, at no cost and without anybody inventing
 * a dataset that then has to be maintained.
 *
 * Only from approved vendors, so a name nobody has vetted cannot be planted in
 * the list by filling in a form.
 */
const vendorAreas = async (city) => {
    try {
        const rows = await technicianModel.distinct("area", {
            city,
            approvalStatus: "approved",
            area: { $nin: [null, ""] },
        });
        return rows.map((name) => String(name).trim()).filter(Boolean);
    } catch (error) {
        console.error("[MAP] Vendor localities failed:", error.message);
        return [];
    }
};

/**
 * Google's guess at a locality, narrowed to one town.
 *
 * India Post's directory is free and exact, and it lists *post offices* - so
 * Palasuni, a real part of Bhubaneswar whose post is handled from
 * G.G.P.Colony, does not appear in it at all. That gap is why this exists:
 * Google knows the names people actually use, and the office has decided the
 * suggestions are worth what they cost.
 *
 * Two things keep that cost to about the minimum Google allows.
 *
 * The session token is the big one. Passed through every keystroke and then
 * handed to the details lookup, Google bills the whole episode as one session
 * instead of one charge per letter typed. The client mints a token when the
 * field is first used and throws it away once something is picked.
 *
 * And the town is appended to the query rather than left to Google's idea of
 * where the user is - "palasuni" alone could be anywhere in India, and a
 * prediction for the wrong state is a request paid for and thrown away.
 */
const googleAreas = async (term, city, sessionToken) => {
    const body = {
        input: term + ", " + city,
        includedRegionCodes: ["in"],
        languageCode: "en",
    };
    if (sessionToken) body.sessionToken = sessionToken;

    keyring.count("google");
    mapUsage.record("autocomplete");
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

    return suggestions
        .map((s) => s.placePrediction)
        .filter(Boolean)
        .map((prediction) => {
            const name = prediction.structuredFormat?.mainText?.text
                || prediction.text?.text
                || "";
            const detail = prediction.structuredFormat?.secondaryText?.text || "";

            return {
                // A placeId rather than a pincode: the pincode arrives from
                // /api/map/place once one of these is actually chosen, which
                // is the call that closes the billing session
                placeId: name ? prediction.placeId : "",
                name,
                detail,

                /*
                 * Both lines as one, which is what gets saved.
                 *
                 * The office used to have a separate address field that
                 * nobody filled in, because a vendor who has just picked
                 * "Palasuni, Rasulgarh - Bhubaneswar, Odisha" has already
                 * said where he is and being asked again reads as the form
                 * not listening. Google's own full line is that answer, so it
                 * travels with the suggestion and the two fields become one.
                 *
                 * The list still shows the two halves separately: the name is
                 * what he is looking for and the rest is how he tells it from
                 * a Palasuni somewhere else.
                 */
                full: prediction.text?.text
                    || [name, detail].filter(Boolean).join(", "),
            };
        })
        .filter((row) => row.name);
};

/**
 * GET /api/map/areas?city=Bhubaneswar&q=palas&session=<token>
 * GET /api/map/areas?pincode=751024
 *
 * By town is what the forms use. By pincode is kept for the one case it still
 * answers better: a dropped map pin gives a pincode and nothing else.
 *
 * Google answers when there is a key and something has been typed. Everything
 * else falls through to the free list - India Post's post offices, the
 * neighbourhoods the office has filled in by hand, and whatever approved
 * vendors have typed for themselves. That fallback is not decoration: it is
 * what a vendor sees if the key is missing, the billing lapses, or Google is
 * simply down, and none of those should stop somebody registering.
 */
const areas = async (req, res) => {
    const city = String(req.query.city || "").trim();

    // Declared once, out here: the free list below narrows itself by the same
    // term Google was asked for, and reading it from inside the block above
    // was a scope mistake that only showed up on the fallback path
    const term = String(req.query.q || "").trim();
    const session = String(req.query.session || "").trim();

    if (city) {
        if (API_KEY && term.length >= 2) {
            try {
                const found = await googleAreas(term, city, session);
                if (found.length) {
                    return res.status(200).json({ success: true, source: "google", data: found });
                }
            } catch (error) {
                console.error("[MAP] Google localities failed:", error.response?.data?.error?.message || error.message);
                // and on to the free list below
            }
        }
    }

    if (city) {
        const town = findCity(city);
        if (!town) return res.status(200).json({ success: true, data: [] });

        try {
            const [listed, typed] = await Promise.all([
                areasForTown(town),
                vendorAreas(town.city),
            ]);

            /*
             * Three sources, in order of how much they can be trusted to spell
             * a place the way an envelope does: India Post, then the names the
             * office has filled in by hand for neighbourhoods the directory
             * misses, then whatever vendors have typed for themselves.
             *
             * First one to claim a name keeps it, so the same place cannot
             * appear twice under three spellings.
             */
            const seen = new Set(listed.map((a) => a.name.toLowerCase()));
            const extra = [];

            const add = (name, pincode) => {
                const key = String(name).trim().toLowerCase();
                if (!key || seen.has(key)) return;
                seen.add(key);
                const clean = String(name).trim();
                extra.push({ name: clean, pincode: pincode || "", full: clean });
            };

            for (const row of extraAreasFor(town.city)) add(row.name, row.pincode);

            // A typed name has no pincode of its own - it belongs to whichever
            // office covers it, and the vendor's own pincode already says which
            for (const name of typed) add(name, "");

            const merged = listed.concat(extra)
                .sort((a, b) => a.name.localeCompare(b.name));

            /*
             * Narrowed to what is being typed, when anything is.
             *
             * The free list is the whole town - seventy-odd names - and
             * handing all of them to somebody who has typed "palas" is worse
             * than handing them nothing: the answer they want is not in the
             * first ten and they have no reason to think the list is even
             * listening. Empty is an honest answer, and the field can be
             * typed into regardless.
             *
             * A match at the start ranks above one in the middle, the same
             * rule the town list uses.
             */
            if (!term) {
                return res.status(200).json({ success: true, source: "post", data: merged });
            }

            const want = term.toLowerCase();
            const starts = [];
            const contains = [];

            for (const row of merged) {
                const name = row.name.toLowerCase();
                if (name.startsWith(want)) starts.push(row);
                else if (name.includes(want)) contains.push(row);
            }

            return res.status(200).json({
                success: true,
                source: "post",
                data: starts.concat(contains).slice(0, 8),
            });
        } catch (error) {
            console.error("[MAP] Town localities failed:", error.message);
            return res.status(200).json({ success: true, data: [] });
        }
    }

    const pincode = String(req.query.pincode || "").replace(/\D/g, "");
    if (pincode.length !== 6) {
        return res.status(400).json({ success: false, message: "Send a town or a six digit pincode." });
    }

    const key = "pin:" + pincode;
    const cached = getCache(key, AREA_TTL);
    if (cached) return res.status(200).json({ success: true, data: cached });

    const list = (await officesAt(pincode))
        .map((office) => ({
            name: String(office.Name || "").trim(),
            pincode: String(office.Pincode || "").trim(),
        }))
        .filter((row) => row.name);

    setCache(key, list);
    return res.status(200).json({ success: true, data: list });
};

/**
 * GET /api/map/cities?q=bhub&session=<token>
 *
 * Towns, from Google, restricted to India and to places that are actually
 * towns. Without that restriction the same query returns Bhubaneswar Railway
 * Station and Bhubaneswar Airport alongside the city, and a vendor filed under
 * an airport is a vendor nobody finds.
 *
 * Google rather than the bundled list because the office asked for it: one
 * provider for every suggestion on the form, so what a vendor sees typing a
 * town and typing his locality behave the same way. The session token is
 * carried through so the whole search plus its details lookup is billed once.
 *
 * `src/config/cities.js` has not gone anywhere - it is the fallback below, and
 * the only thing that still answers when a key is missing or Google is down.
 */
const googleCities = async (term, sessionToken) => {
    const body = {
        input: term,
        includedRegionCodes: ["in"],
        includedPrimaryTypes: ["locality"],
        languageCode: "en",
    };
    if (sessionToken) body.sessionToken = sessionToken;

    keyring.count("google");
    mapUsage.record("autocomplete");
    const response = await axios.post(
        "https://places.googleapis.com/v1/places:autocomplete",
        body,
        {
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": API_KEY,
                "X-Goog-FieldMask":
                    "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat",
            },
            timeout: 8000,
        }
    );

    const suggestions = Array.isArray(response.data?.suggestions) ? response.data.suggestions : [];

    return suggestions
        .map((s) => s.placePrediction)
        .filter(Boolean)
        .map((prediction) => ({
            // The state and pincode arrive from /api/map/place when one of
            // these is chosen - the call that also closes the billing session
            placeId: prediction.placeId,
            city: prediction.structuredFormat?.mainText?.text || "",
            detail: prediction.structuredFormat?.secondaryText?.text || "",
        }))
        .filter((row) => row.city);
};

const cities = async (req, res) => {
    const term = String(req.query.q || "").trim();
    const session = String(req.query.session || "").trim();

    if (API_KEY && term.length >= 2) {
        try {
            const found = await googleCities(term, session);
            if (found.length) {
                return res.status(200).json({ success: true, source: "google", data: found });
            }
        } catch (error) {
            console.error("[MAP] Google towns failed:", error.response?.data?.error?.message || error.message);
            // and on to the bundled list
        }
    }

    // The floor: the towns this company works in, with their state and a
    // starting pincode. Instant, free, and the only thing that answers with no
    // key at all.
    return res.status(200).json({
        success: true,
        source: "bundled",
        data: searchCities(term, 8),
    });
};

module.exports = {
    cities,
    areas, reverseGeocode, searchPlaces, placeDetails, lookupPlace };

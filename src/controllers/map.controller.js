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
        cache.delete(cache.keys().next().value); // sabse purana nikal do
    }
    cache.set(key, { value, time: Date.now() });
};

const USER_AGENT = "CosmosgenApp/1.0 (support@cosmosgen.com)";

// GET /api/map/rev-geocode?lat=..&lon=..
const reverseGeocode = async (req, res) => {
    try {
        const lat = Number(req.query.lat);
        const lon = Number(req.query.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return res.status(400).json({ success: false, message: "Latitude and Longitude are required" });
        }

        // 4 decimal ~ 11 meters. Isse cache hit rate kaafi badh jata hai.
        const key = `rev:${lat.toFixed(4)}:${lon.toFixed(4)}`;
        const cached = getCache(key);
        if (cached) {
            return res.status(200).json({ success: true, cached: true, data: cached });
        }

        const response = await axios.get("https://nominatim.openstreetmap.org/reverse", {
            params: { format: "json", lat, lon, zoom: 18, addressdetails: 1 },
            headers: { "User-Agent": USER_AGENT },
            timeout: 8000,
        });

        const address = response.data?.address;
        if (!address) {
            return res.status(404).json({ success: false, message: "Address not found for these coordinates" });
        }

        const area = address.neighbourhood || address.suburb || address.village || address.town || address.city || address.county || "";
        const data = {
            results: [{
                formatted_address: response.data.display_name,
                state: address.state || "",
                locality: area,
                city: area,
                pincode: address.postcode || "",
            }],
        };

        setCache(key, data);
        return res.status(200).json({ success: true, cached: false, data });
    } catch (error) {
        console.error("Reverse geocode error:", error.message);
        return res.status(500).json({ success: false, message: "Failed to fetch address" });
    }
};

// GET /api/map/search?q=..
// NAYA. Frontend ab Nominatim ko seedha hit nahi karega - wo unki policy
// violate karta tha (no User-Agent) aur IP ban ka risk tha.
const searchPlaces = async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();

        if (q.length < 3) {
            return res.status(400).json({ success: false, message: "Query must be at least 3 characters" });
        }
        if (q.length > 120) {
            return res.status(400).json({ success: false, message: "Query too long" });
        }

        const key = `search:${q.toLowerCase()}`;
        const cached = getCache(key);
        if (cached) {
            return res.status(200).json({ success: true, cached: true, data: cached });
        }

        const response = await axios.get("https://nominatim.openstreetmap.org/search", {
            params: { q, format: "json", addressdetails: 1, countrycodes: "IN", limit: 5 },
            headers: { "User-Agent": USER_AGENT },
            timeout: 8000,
        });

        // Frontend ko sirf zaroori fields bhejo - poora Nominatim payload bhaari hota hai
        const results = (Array.isArray(response.data) ? response.data : []).map((place) => {
            const a = place.address || {};
            return {
                id: place.place_id,
                label: place.display_name,
                state: a.state || "",
                // 👇 NAYA CODE: place.name ko sabse pehle priority di hai
                area: place.name || a.neighbourhood || a.suburb || a.village || a.town || a.city || a.county || "",
                pincode: a.postcode || "",
                lat: Number(place.lat),
                lon: Number(place.lon),
            };
        });
        setCache(key, results);
        return res.status(200).json({ success: true, cached: false, data: results });
    } catch (error) {
        console.error("Search places error:", error.message);
        return res.status(500).json({ success: false, message: "Failed to search location" });
    }
};

module.exports = { reverseGeocode, searchPlaces };
const axios = require('axios');

// Fallback to OpenStreetMap for Real Data (Since Mappls Backend is locked by them)
const reverseGeocode = async (req, res) => {
    try {
        const { lat, lon } = req.query;
        
        if (!lat || !lon) {
            return res.status(400).json({ success: false, message: "Latitude and Longitude are required." });
        }

        // Using OpenStreetMap (Nominatim) - Free, Real Data, No Keys required!
        const osmUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
        
        const response = await axios.get(osmUrl, {
            headers: {
                'User-Agent': 'CosmosgenApp/1.0' // Required by OpenStreetMap
            }
        });

        if (response.data && response.data.address) {
            const address = response.data.address;
            
            // Format data exactly how your frontend expects it
            const state = address.state || '';
            const area = address.city || address.town || address.suburb || address.county || '';
            const formatted_address = response.data.display_name;

            return res.status(200).json({
                success: true,
                data: {
                    results: [
                        {
                            formatted_address: formatted_address,
                            state: state,
                            locality: area,
                            city: area
                        }
                    ]
                }
            });
        }

        throw new Error("Address not found for these coordinates.");

    } catch (error) {
        console.error("Geocoding Error:", error.message);
        res.status(500).json({ 
            success: false, 
            message: "Failed to fetch real address" 
        });
    }
};

module.exports = { reverseGeocode };
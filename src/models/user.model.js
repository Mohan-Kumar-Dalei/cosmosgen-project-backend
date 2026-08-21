const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    address: { type: String, default: '' },
    
    // 👇 Naye fields (Location detect aur AI matchmaking ke liye)
    state: { type: String, default: '' },
    area: { type: String, default: '' },
    lat: { type: Number },
    lon: { type: Number },

    location: {
        type: { type: String, default: 'Point' },
        coordinates: [Number] // [longitude, latitude]
    },
    role: { type: String, default: 'customer' }
}, { timestamps: true });

userSchema.index({ location: '2dsphere' });
const userModel = mongoose.model('User', userSchema);
module.exports = userModel
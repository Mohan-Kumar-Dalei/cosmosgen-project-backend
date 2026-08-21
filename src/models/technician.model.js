const mongoose = require('mongoose');

const technicianSchema = new mongoose.Schema({
    name: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    
    // Naye Location Fields
    state: { type: String, required: true }, // e.g., 'West Bengal'
    area: { type: String, required: true },  // e.g., 'Salt Lake'
    pincode: { type: String, required: true }, 
    
    // Naya Profile Image Field
    profileImage: { type: String, default: "" }, // URL or base64 string
    
    skills: [{ type: String }], 
    hasVehicle: { type: Boolean, default: false },
    rating: { type: Number, default: 5.0 }, 
    
    location: {
        type: { type: String, default: 'Point' },
        coordinates: { type: [Number], default: [0, 0] } 
    },
    completedJobs: { 
        type: Number, 
        default: 0 
    },
    performanceLevel: { 
        type: String, 
        enum: ['STARTER', 'PRO', 'EXPERT'],
        default: 'STARTER' 
    },
    isAvailable: { type: Boolean, default: true },
    activeTicket: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Ticket',
        default: null 
    }
}, { timestamps: true });

technicianSchema.index({ location: '2dsphere' });

const technicianModel = mongoose.model('Technician', technicianSchema);
module.exports = technicianModel
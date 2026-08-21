const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    technician: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician', default: null },
    technicianName: {
        type: String
    },
    serviceCategory: { type: String, required: true },
    problemDescription: { type: String },
    aiDiagnosis: { type: String },
    
    // 👇 Naye fields (Map pe blue line draw karne ke liye)
    locationCoords: {
        lat: { type: Number },
        lon: { type: Number }
    },
    address: { type: String }, 

    // 👇 Billing aur Service Details
    serviceProvided: {
        gasFilled: { type: Boolean, default: false },
        partsUsed: [{ type: String }],
        additionalNotes: { type: String }
    },
    totalAmount: { type: Number, default: 0 },
    
    estimatedPrice: { type: Number },
    finalPrice: { type: Number },
    status: { 
        type: String, 
        enum: ['Open', 'Assigned', 'In-Progress', 'Payment-Pending', 'Closed'], 
        default: 'Open' 
    },
    paymentStatus: { type: String, enum: ['Pending', 'Completed'], default: 'Pending' },
    paymentMethod: { type: String }
}, { timestamps: true });

const ticketModel = mongoose.model('Ticket', ticketSchema);
module.exports = ticketModel;
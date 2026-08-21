// src/models/message.model.js
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    chat: { 
        // Agar aap ticket ID ya chat session ID bhej rahe hain, toh String theek hai. 
        // Agar relation banana hai toh mongoose.Schema.Types.ObjectId use kar sakte hain.
        type: String, 
        required: true 
    },
    user: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true 
    },
    content: { 
        type: String, 
        required: true 
    },
    role: { 
        type: String, 
        enum: ['user', 'model'], // Gemini strictly demands 'user' or 'model'
        required: true 
    }
}, { timestamps: true }); // Timestamps se sorting (oldest to newest) easy ho jayegi

const messageModel = mongoose.model('Message', messageSchema);
module.exports = messageModel;
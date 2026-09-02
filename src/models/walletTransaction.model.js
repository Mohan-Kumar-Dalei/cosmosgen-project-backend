const mongoose = require("mongoose");

const walletTransactionSchema = new mongoose.Schema({
    technician: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: "Technician", 
        required: true, 
        index: true 
    },
    type: { 
        type: String, 
        enum: ["credit", "debit"], 
        required: true 
    },
    amountPaise: { 
        type: Number, 
        required: true
    },
    balanceAfterPaise: { 
        type: Number, 
        required: true // Transaction ke baad wallet ka total balance kitna bacha
    },
    source: { 
        type: String, 
        enum: [
            "job_online",  // Customer ne online pay kiya (Tech ko uska hissa mila)
            "job_cash",    // Customer ne cash diya (Company ne commission kaata)
            "recharge",    // Tech ne khud paise add kiye (negative hatane ke liye)
            "payout",      // Company ne Tech ke bank me paise bheje
            "adjustment"   // Admin ne manually balance theek kiya
        ], 
        required: true 
    },
    ticket: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: "Ticket", 
        default: null // Agar ye job se related hai, toh ticket ID
    },
    description: { 
        type: String, 
        required: true // e.g. "Commission deducted for Ticket #CG-..."
    },
}, { timestamps: true });

// Passbook history nikalne ke liye indexing zaroori hai
walletTransactionSchema.index({ technician: 1, createdAt: -1 });

module.exports = mongoose.model("WalletTransaction", walletTransactionSchema);
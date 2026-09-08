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

    // How the money actually moved, and the reference for it.
    //
    // These used to live inside the description string, which is why every
    // older row reads "Collected from technician: Razorpay" with no id in it -
    // untraceable, and impossible to group or filter on. Rows written before
    // this field existed simply have it unset.
    method: {
        type: String,  // Cash | UPI | Razorpay | Bank Transfer
        default: null,
    },
    reference: {
        type: String,  // UTR or Razorpay payment id
        default: null,
    },
}, { timestamps: true });

// Passbook history nikalne ke liye indexing zaroori hai
walletTransactionSchema.index({ technician: 1, createdAt: -1 });
// The settlements screen reads across every technician at once, filtered by
// source and sorted by date - which had no index of its own to work from
walletTransactionSchema.index({ source: 1, createdAt: -1 });

module.exports = mongoose.model("WalletTransaction", walletTransactionSchema);
const Technician = require("../models/technician.model");
const WalletTransaction = require("../models/walletTransaction.model");
const Payment = require("../models/payment.model");
const ticketModel = require("../models/ticket.model");
const { emitToRoom, techRoom, adminRoom } = require("../sockets/socket.instance");

const calculateCommission = (totalPaise, commissionRate) =>
    Math.round((totalPaise * commissionRate) / 100);

/**
 * Cash job: the technician holds the whole amount, so the company's
 * commission is owed back. Balance goes negative - that's the technician
 * owing us, and it's a normal state, not an error.
 */
const deductCommissionForCashJob = async (technicianId, ticketId, ticketNumber, totalPaise, commissionRate) => {
    const commissionPaise = calculateCommission(totalPaise, commissionRate);
    if (commissionPaise <= 0) return null;

    const updatedTech = await Technician.findByIdAndUpdate(
        technicianId,
        { $inc: { walletBalancePaise: -commissionPaise } },
        { returnDocument: "after" }
    ).select("walletBalancePaise");

    if (!updatedTech) return null;

    return WalletTransaction.create({
        technician: technicianId,
        type: "debit",
        amountPaise: commissionPaise,
        balanceAfterPaise: updatedTech.walletBalancePaise,
        source: "job_cash",
        ticket: ticketId,
        description: "Commission (" + commissionRate + "%) on cash job #" + ticketNumber,
    });
};

/**
 * Online job: the money reached the company, so the technician's share is
 * owed to them. Balance goes positive.
 */
const addEarningsForOnlineJob = async (technicianId, ticketId, ticketNumber, totalPaise, commissionRate) => {
    const commissionPaise = calculateCommission(totalPaise, commissionRate);
    const techSharePaise = totalPaise - commissionPaise;
    if (techSharePaise <= 0) return null;

    const updatedTech = await Technician.findByIdAndUpdate(
        technicianId,
        { $inc: { walletBalancePaise: techSharePaise } },
        { returnDocument: "after" }
    ).select("walletBalancePaise");

    if (!updatedTech) return null;

    const txn = await WalletTransaction.create({
        technician: technicianId,
        type: "credit",
        amountPaise: techSharePaise,
        balanceAfterPaise: updatedTech.walletBalancePaise,
        source: "job_online",
        ticket: ticketId,
        description: "Your share of online job #" + ticketNumber + " (after " + commissionRate + "% commission)",
    });

    await autoVerifyCashPayments(technicianId);
    return txn;
};

/**
 * Company sends money to a technician. The balance condition lives in the
 * filter, not in a separate read - reading the balance first and then
 * decrementing is what lets a double click send the money twice.
 */
const processPayout = async (technicianId, amountPaise, referenceNote) => {
    if (!referenceNote || String(referenceNote).trim().length < 3) {
        throw new Error("A payment reference (UTR or transaction id) is required");
    }

    const tech = await Technician.findById(technicianId).select("walletBalancePaise name").lean();
    if (!tech) throw new Error("Technician not found");

    const balance = tech.walletBalancePaise || 0;
    if (balance <= 0) {
        throw new Error("This technician has no positive balance to pay out");
    }

    const requested = amountPaise ? Number(amountPaise) : balance;
    if (!Number.isFinite(requested) || requested <= 0) {
        throw new Error("Payout amount must be a positive number");
    }

    const payoutAmount = Math.min(requested, balance);

    const updatedTech = await Technician.findOneAndUpdate(
        { _id: technicianId, walletBalancePaise: { $gte: payoutAmount } },
        { $inc: { walletBalancePaise: -payoutAmount } },
        { returnDocument: "after" }
    ).select("walletBalancePaise");

    if (!updatedTech) {
        throw new Error("Balance changed since you opened this. Refresh and try again.");
    }

    return WalletTransaction.create({
        technician: technicianId,
        type: "debit",
        amountPaise: payoutAmount,
        balanceAfterPaise: updatedTech.walletBalancePaise,
        source: "payout",
        ticket: null,
        description: "Payout: Rs " + (payoutAmount / 100).toFixed(2) + " (" + String(referenceNote).trim() + ")",
    });
};

/**
 * Auto-verifies pending cash payments when the technician's wallet is credited.
 */
const autoVerifyCashPayments = async (technicianId) => {
    try {
        const tech = await Technician.findById(technicianId).select("walletBalancePaise name").lean();
        if (!tech) return;

        const balance = tech.walletBalancePaise || 0;

        const pendingCashJobs = await Payment.find({
            collectedBy: technicianId,
            method: "cash",
            status: "collected"
        }).sort({ createdAt: 1 });

        if (!pendingCashJobs.length) return;

        let verifiedCount = 0;

        if (balance >= 0) {
            // Balance is zero or positive -> they owe nothing. Verify all.
            for (const job of pendingCashJobs) {
                await Payment.updateOne({ _id: job._id }, { status: "verified", verifiedAt: new Date() });
                await ticketModel.updateOne({ _id: job.ticket }, { "payment.status": "Verified", "payment.verifiedAt": new Date() });
                verifiedCount++;
            }
        } else {
            // Balance is negative (they owe us Math.abs(balance)).
            // Verify oldest jobs until the unverified commission equals what they owe.
            const targetDebt = Math.abs(balance);
            let unverifiedCommission = pendingCashJobs.reduce((sum, job) => sum + (job.commissionPaise || 0), 0);

            for (const job of pendingCashJobs) {
                if (unverifiedCommission <= targetDebt) break;

                await Payment.updateOne({ _id: job._id }, { status: "verified", verifiedAt: new Date() });
                await ticketModel.updateOne({ _id: job.ticket }, { "payment.status": "Verified", "payment.verifiedAt": new Date() });
                
                unverifiedCommission -= (job.commissionPaise || 0);
                verifiedCount++;
            }
        }

        if (verifiedCount > 0) {
            emitToRoom(techRoom(technicianId), "cash:verified", {});
            emitToRoom(adminRoom(), "payment:reconciled", {});
        }
    } catch (err) {
        console.error("Auto-verify cash payments failed:", err);
    }
};

/**
 * Technician cleared their dues - online through Razorpay, or in cash at
 * the office. Credits the wallet so the negative balance moves back
 * towards zero.
 */
const recordRecharge = async (technicianId, amountPaise, referenceNote) => {
    const amount = Number(amountPaise);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Recharge amount must be positive");
    }

    const updatedTech = await Technician.findByIdAndUpdate(
        technicianId,
        { $inc: { walletBalancePaise: amount } },
        { returnDocument: "after" }
    ).select("walletBalancePaise");

    if (!updatedTech) throw new Error("Technician not found");

    const txn = await WalletTransaction.create({
        technician: technicianId,
        type: "credit",
        amountPaise: amount,
        balanceAfterPaise: updatedTech.walletBalancePaise,
        source: "recharge",
        ticket: null,
        description: "Settled: Rs " + (amount / 100).toFixed(2) + (referenceNote ? " (" + referenceNote + ")" : ""),
    });

    await autoVerifyCashPayments(technicianId);
    return txn;
};

/**
 * Manual correction when the ledger and reality drift - a payout that
 * bounced, a cash amount counted wrong. Signed: positive credits,
 * negative debits.
 */
const adjustBalance = async (technicianId, deltaPaise, reason) => {
    const delta = Number(deltaPaise);
    if (!Number.isFinite(delta) || delta === 0) {
        throw new Error("Adjustment amount must be a non-zero number");
    }
    if (!reason || String(reason).trim().length < 5) {
        throw new Error("A reason is required for a manual adjustment");
    }

    const updatedTech = await Technician.findByIdAndUpdate(
        technicianId,
        { $inc: { walletBalancePaise: delta } },
        { returnDocument: "after" }
    ).select("walletBalancePaise");

    if (!updatedTech) throw new Error("Technician not found");

    const txn = await WalletTransaction.create({
        technician: technicianId,
        type: delta > 0 ? "credit" : "debit",
        amountPaise: Math.abs(delta),
        balanceAfterPaise: updatedTech.walletBalancePaise,
        source: "adjustment",
        ticket: null,
        description: "Manual adjustment: " + String(reason).trim(),
    });

    if (delta > 0) {
        await autoVerifyCashPayments(technicianId);
    }
    return txn;
};

module.exports = {
    calculateCommission,
    deductCommissionForCashJob,
    addEarningsForOnlineJob,
    processPayout,
    recordRecharge,
    adjustBalance,
};
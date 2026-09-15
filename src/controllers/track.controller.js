const crypto = require("crypto");

const ticketModel = require("../models/ticket.model");
const technicianModel = require("../models/technician.model");

/**
 * The customer's view of a job in progress.
 *
 * Public on purpose: the customer is on WhatsApp, not signed in to anything,
 * and asking them to make an account to find out where the technician is
 * would defeat the point. The secret is the token in the link, so this
 * endpoint returns nothing that is not already in the WhatsApp thread the
 * link arrived in - no address of anyone else, no money, no ticket list.
 */

const STAGES = ["assigned", "on_the_way", "arrived", "working", "done"];

/** A token that cannot be walked back to a ticket number. */
const issueToken = () => crypto.randomBytes(16).toString("hex");

/**
 * Where the job actually is, in the five words a customer thinks in.
 *
 * Deliberately not the ticket status: "Assigned" and "In-Progress" are what
 * the office needs to run a queue, and neither tells the person waiting at
 * home whether anyone has set off yet. The ride block does.
 */
const stageOf = (ticket) => {
    // Cancelled belongs here too. A job that was called off is finished as
    // far as this page is concerned, and leaving it on "arrived" would keep
    // showing a technician heading somewhere nobody is waiting.
    if (["Closed", "Payment-Pending", "Cancelled"].includes(ticket.status)) return "done";
    if (ticket.status === "In-Progress") return "working";
    if (ticket.ride?.arrivedAt) return "arrived";
    if (ticket.ride?.startedAt) return "on_the_way";
    return "assigned";
};

// GET /api/track/:token
const getTracking = async (req, res) => {
    try {
        const token = String(req.params.token || "").trim();

        // A short or empty token would otherwise match a ticket whose tracking
        // block was never set, because Mongo happily matches undefined
        if (token.length !== 32) {
            return res.status(404).json({ success: false, message: "This tracking link is not valid." });
        }

        const ticket = await ticketModel
            .findOne({ "tracking.token": token })
            .select("ticketNumber serviceLabel status customerSnapshot location ride technicianSnapshot technician createdAt assignedAt")
            .lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: "This tracking link is not valid." });
        }

        const stage = stageOf(ticket);

        // The technician's live position, and only while it is any of the
        // customer's business. Once the job is done, where he went next is
        // not something this link should keep answering.
        /*
         * From assignment, not from departure.
         *
         * It used to start at "on the way", which left the customer with a
         * green pin and nothing else for as long as it took somebody to set
         * off. The page now draws a dashed arc from the vendor to the door the
         * moment a job has somebody on it, so it needs his position one stage
         * earlier. Still nothing once the job is done, which is the part that
         * was actually about privacy.
         */
        let technicianAt = null;
        if (stage === "assigned" || stage === "on_the_way" || stage === "arrived") {
            const tech = await technicianModel
                .findById(ticket.technician)
                .select("location lastLocationAt")
                .lean();

            const coords = tech?.location?.coordinates;
            if (Array.isArray(coords) && coords.length === 2) {
                technicianAt = { lat: coords[1], lon: coords[0], at: tech.lastLocationAt || null };
            }
        }

        const tech = ticket.technicianSnapshot || {};
        const customer = ticket.customerSnapshot || {};

        return res.status(200).json({
            success: true,
            data: {
                ticketNumber: ticket.ticketNumber,
                serviceLabel: ticket.serviceLabel,
                stage,
                stages: STAGES,

                // The name and the number, because the one thing a waiting
                // customer wants more than a map is to be able to ring the
                // person on it.
                technician: {
                    name: tech.name || null,
                    phone: tech.phone || null,
                    rating: tech.rating ? Number(tech.rating).toFixed(1) : null,
                },

                technicianAt,

                destination: {
                    lat: customer.lat ?? ticket.location?.coordinates?.[1] ?? null,
                    lon: customer.lon ?? ticket.location?.coordinates?.[0] ?? null,
                    area: customer.area || null,
                    landmark: customer.landmark || null,
                },

                ride: {
                    startedAt: ticket.ride?.startedAt || null,
                    arrivedAt: ticket.ride?.arrivedAt || null,
                    etaSeconds: ticket.ride?.etaSeconds ?? null,
                    etaAt: ticket.ride?.etaAt || null,
                    distanceMeters: ticket.ride?.distanceMeters ?? null,
                    encodedPolyline: ticket.ride?.encodedPolyline || null,
                },
            },
        });
    } catch (error) {
        console.error("Tracking fetch error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

module.exports = { getTracking, issueToken, stageOf, STAGES };

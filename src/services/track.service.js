const crypto = require("crypto");

/**
 * What a job looks like to the customer, stated once.
 *
 * This is a leaf on purpose. The words live here rather than in the tracking
 * controller because half the system needs them - the controller, the
 * customer's own ticket list, booking, and every message that carries a
 * tracking link - and reaching into a controller for them dragged the whole
 * request-handling side of the app in behind.
 *
 * It did worse than that. notification.service asked the controller for a
 * token, the controller asked ride.service for the arrival radius, and
 * ride.service asked notification.service for the messages: a ring. Node hands
 * a half-built module to whoever is second into a ring like that, and on this
 * server the loser was ride.service - so notifyCustomerArrived and
 * notifyCustomerTechnicianEnRoute were undefined at the moment a vendor
 * reached a door. No message, no arrival, and nothing in the code looking
 * wrong. Nothing here requires anything of ours, so the ring cannot form
 * again.
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

    /*
     * Accepting is what tells the customer somebody is coming.
     *
     * It used to be the Directions tap alone, which left a gap: the office had
     * picked somebody, that somebody had agreed to come, and the customer was
     * still being told we were looking. Mohan's rule is that the moment the
     * technician says yes is the moment the job is on its way - the route
     * turns up a little later, when he actually sets off.
     */
    if (ticket.ride?.startedAt || ticket.acceptedAt) return "on_the_way";

    return "assigned";
};

module.exports = { issueToken, stageOf, STAGES };

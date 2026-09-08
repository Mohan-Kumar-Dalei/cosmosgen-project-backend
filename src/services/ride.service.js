const ticketModel = require("../models/ticket.model");
const routeService = require("./route.service");
const notification = require("./notification.service");
const { emitToRoom, techRoom, adminRoom } = require("../sockets/socket.instance");

/**
 * How close the technician has to get before we tell the customer they have
 * arrived. A city GPS fix is good to roughly 20-50 m, and a flat or shop
 * entrance can sit that far off the pin the customer dropped, so anything
 * tighter than this would leave technicians standing at the door with the
 * message never sent. Wider starts firing while they are still driving past.
 */
const ARRIVAL_RADIUS_METRES = 120;

/**
 * The stored ETA is refreshed at most this often. Each refresh is a billed
 * Routes call, and an ETA does not meaningfully move faster than this.
 */
const ETA_RECOMPUTE_MS = 5 * 60 * 1000;

/** Great-circle metres between two points. */
const metresBetween = (aLat, aLon, bLat, bLon) => {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * Everything the ride used to need a button for.
 *
 * There is no "start ride" and no "I have arrived" any more. The technician
 * opens Google Maps and drives; this runs off the location ping they are
 * already sending and works out the rest:
 *
 *   - first fix on an assigned job  -> compute the route once, tell the
 *     customer their technician is on the way and give them an ETA
 *   - every fix after that          -> refresh the ETA, but no faster than
 *     ETA_RECOMPUTE_MS, because each refresh is billed
 *   - inside ARRIVAL_RADIUS_METRES  -> mark arrival and message the customer
 *
 * Arrival is decided here rather than in the panel on purpose: it sends a
 * message the customer will act on, so it has to be the server's call, not a
 * value a client can post whenever it likes.
 *
 * Returns nothing and never throws. A failure here must not cost the
 * technician their location ping.
 */
const syncRideProgress = async (technician, lat, lon) => {
    try {
        const ticket = await ticketModel.findOne({
            technician: technician._id,
            status: "Assigned",
        }).sort({ assignedAt: -1 });

        if (!ticket) return;

        const destLon = ticket.location?.coordinates?.[0];
        const destLat = ticket.location?.coordinates?.[1];
        if (!Number.isFinite(destLat) || !Number.isFinite(destLon)) return;

        // Already arrived - nothing left to track until the job moves on.
        if (ticket.ride?.arrivedAt) return;

        const now = new Date();
        const distance = metresBetween(lat, lon, destLat, destLon);
        const isFirstFix = !ticket.ride?.startedAt;

        if (isFirstFix) {
            const route = await routeService.computeRoute(
                { lat, lon },
                { lat: destLat, lon: destLon }
            );

            ticket.ride = {
                startedAt: now,
                arrivedAt: null,
                origin: { lat, lon },
                etaSeconds: route?.durationSeconds ?? null,
                distanceMeters: route?.distanceMeters ?? null,
                etaAt: route?.durationSeconds
                    ? new Date(now.getTime() + route.durationSeconds * 1000)
                    : null,
                encodedPolyline: route?.encodedPolyline ?? null,
                computedAt: route ? now : null,
            };
        } else {
            const computedAt = ticket.ride.computedAt
                ? new Date(ticket.ride.computedAt).getTime()
                : 0;

            // Skip the refresh when we are about to declare arrival anyway -
            // paying for a route to a point 100 m away is money for nothing.
            const worthRefreshing =
                distance > ARRIVAL_RADIUS_METRES &&
                now.getTime() - computedAt > ETA_RECOMPUTE_MS;

            if (worthRefreshing) {
                const route = await routeService.computeRoute(
                    { lat, lon },
                    { lat: destLat, lon: destLon }
                );
                if (route) {
                    ticket.ride.etaSeconds = route.durationSeconds ?? null;
                    ticket.ride.distanceMeters = route.distanceMeters ?? null;
                    ticket.ride.etaAt = route.durationSeconds
                        ? new Date(now.getTime() + route.durationSeconds * 1000)
                        : null;
                    ticket.ride.encodedPolyline = route.encodedPolyline ?? null;
                    ticket.ride.computedAt = now;
                }
            }
        }

        const hasArrived = distance <= ARRIVAL_RADIUS_METRES;
        if (hasArrived) ticket.ride.arrivedAt = now;

        await ticket.save();

        const plain = ticket.toObject();

        // Both messages go out only once each: the en-route branch runs on the
        // first fix and the arrival branch flips arrivedAt, which is the guard
        // at the top of this function on every later ping.
        if (isFirstFix) {
            await notification.notifyCustomerTechnicianEnRoute(plain);
            notification.notifyAdminsRideStarted(plain);
        }

        if (hasArrived) {
            await notification.notifyCustomerArrived(plain);
            emitToRoom(techRoom(technician._id), "ride:arrived", {
                ticketId: String(ticket._id),
                ticketNumber: ticket.ticketNumber,
            });
            emitToRoom(adminRoom(), "ticket:arrived", {
                ticketId: String(ticket._id),
                ticketNumber: ticket.ticketNumber,
                technicianId: String(technician._id),
                technicianName: ticket.technicianSnapshot?.name,
                arrivedAt: now,
            });
        }
    } catch (error) {
        console.error("[RIDE] progress sync failed:", error.message);
    }
};

module.exports = { syncRideProgress, metresBetween, ARRIVAL_RADIUS_METRES };

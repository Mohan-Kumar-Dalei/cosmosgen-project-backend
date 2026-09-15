const ticketModel = require("../models/ticket.model");
const technicianModel = require("../models/technician.model");
const routeService = require("./route.service");
const notification = require("./notification.service");
const { emitToRoom, techRoom, trackRoom, adminRoom } = require("../sockets/socket.instance");

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

        /*
         * The line is information; "on the way" is an announcement.
         *
         * Only the announcement waits for the Directions button. The route,
         * the distance and the estimate are worked out from the first position
         * that arrives, exactly as they always were - taking those away as
         * well left the customer with two pins and no line between them, which
         * is not what was asked for.
         *
         * So a ride object exists from the first fix, with everything in it
         * except startedAt. markOnTheWay() fills that in, and that is the only
         * thing the customer's stage is read from.
         */
        const started = Boolean(ticket.ride?.startedAt);
        const isFirstFix = !ticket.ride?.computedAt;

        if (isFirstFix) {
            const route = await routeService.computeRoute(
                { lat, lon },
                { lat: destLat, lon: destLon }
            );

            ticket.ride = {
                ...(ticket.ride?.toObject ? ticket.ride.toObject() : ticket.ride || {}),
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

        // The customer's page moves on this, not on a timer. Every fix that
        // reaches the server reaches them, which is what makes the marker
        // crawl rather than jump.
        if (ticket.tracking?.token) {
            emitToRoom(trackRoom(ticket.tracking.token), "track:update", {
                technicianAt: { lat, lon, at: now },

                /*
                 * "assigned" until he has actually set off.
                 *
                 * This used to say on_the_way on every ping, which announced a
                 * departure that had not happened - the whole reason the
                 * button exists. Arriving still overrides everything, because
                 * being at the door is a fact whatever the record says.
                 */
                stage: hasArrived ? "arrived" : (started ? "on_the_way" : "assigned"),
                etaSeconds: ticket.ride?.etaSeconds ?? null,
                etaAt: ticket.ride?.etaAt || null,
                distanceMeters: ticket.ride?.distanceMeters ?? null,
                encodedPolyline: ticket.ride?.encodedPolyline || null,
            });
        }

        // Both messages go out only once each: the en-route branch runs on the
        // first fix and the arrival branch flips arrivedAt, which is the guard
        // at the top of this function on every later ping.
        if (isFirstFix && started) {
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

/**
 * The vendor has tapped Directions: he is setting off.
 *
 * This is the one place a ride begins. It works the route out once, so the
 * customer's page has a line and an estimate the moment the stage changes, and
 * it tells that page directly rather than waiting for the first GPS fix - a
 * vendor in a basement car park can be a minute away from his first position,
 * and the customer should not spend that minute looking at a screen that has
 * not moved.
 */
const markOnTheWay = async (technicianId, ticketId) => {
    const ticket = await ticketModel.findOne({
        _id: ticketId,
        technician: technicianId,
        status: "Assigned",
    });

    if (!ticket) return { ok: false, code: "not_yours" };
    if (ticket.ride?.startedAt) return { ok: true, ticket, already: true };

    const destLon = ticket.location?.coordinates?.[0];
    const destLat = ticket.location?.coordinates?.[1];

    const tech = await technicianModel.findById(technicianId).select("location").lean();
    const coords = tech?.location?.coordinates;
    const from = Array.isArray(coords) && coords.length === 2
        ? { lat: coords[1], lon: coords[0] }
        : null;

    const now = new Date();

    // No route without both ends. The ride still starts - the customer is told
    // somebody has set off either way - it simply has no line yet.
    const route = from && Number.isFinite(destLat) && Number.isFinite(destLon)
        ? await routeService.computeRoute(from, { lat: destLat, lon: destLon })
        : null;

    const had = ticket.ride?.toObject ? ticket.ride.toObject() : (ticket.ride || {});

    ticket.ride = {
        ...had,
        startedAt: now,
        arrivedAt: null,
        origin: from || had.origin,

        // A fresh route wins; without one, whatever the first GPS fix already
        // worked out stays. Losing a good line because this one call failed
        // would leave the customer worse off than before he set off.
        etaSeconds: route?.durationSeconds ?? had.etaSeconds ?? null,
        distanceMeters: route?.distanceMeters ?? had.distanceMeters ?? null,
        etaAt: route?.durationSeconds
            ? new Date(now.getTime() + route.durationSeconds * 1000)
            : (had.etaAt || null),
        encodedPolyline: route?.encodedPolyline ?? had.encodedPolyline ?? null,
        computedAt: route ? now : (had.computedAt || null),
    };

    await ticket.save();

    if (ticket.tracking?.token) {
        emitToRoom(trackRoom(ticket.tracking.token), "track:update", {
            stage: "on_the_way",
            technicianAt: from ? { ...from, at: now } : null,
            etaSeconds: ticket.ride.etaSeconds,
            etaAt: ticket.ride.etaAt,
            distanceMeters: ticket.ride.distanceMeters,
            encodedPolyline: ticket.ride.encodedPolyline,
        });
    }

    return { ok: true, ticket };
};

module.exports = { syncRideProgress, markOnTheWay, metresBetween, ARRIVAL_RADIUS_METRES };

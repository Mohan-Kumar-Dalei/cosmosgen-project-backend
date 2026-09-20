const errors = require("../config/sentry");
const ticketModel = require("../models/ticket.model");
const technicianModel = require("../models/technician.model");
const routeService = require("./route.service");
const { lookupPlace } = require("../controllers/map.controller");
const notification = require("./notification.service");
const { emitToRoom, techRoom, trackRoom, adminRoom, roomSize } = require("../sockets/socket.instance");

/**
 * How close the technician has to get before we tell the customer they have
 * arrived. A city GPS fix is good to roughly 20-50 m, and a flat or shop
 * entrance can sit that far off the pin the customer dropped, so anything
 * tighter than this would leave technicians standing at the door with the
 * message never sent. Wider starts firing while they are still driving past.
 */
/*
 * How close counts as arrived.
 *
 * It was 120 m, and in the field that declared arrival while the technician
 * was still a street away - which the customer can see on their own map, and
 * which stops the tracking dead, because an arrived ride is not synced again.
 *
 * A hundred metres, and the customer's map draws a circle of exactly that
 * around their door - so "arrived" is not a claim they have to take on trust,
 * it is the bike crossing a line they can see. The number and the circle are
 * the same number on purpose; change one here and the other follows.
 *
 * Tunable from the environment, because the right figure is a thing to find
 * out on real roads: a city fix is good to 10-30 m, a flat is not where its
 * pin is, and too tight simply never fires at all.
 */
const ARRIVAL_RADIUS_METRES = Number(process.env.ARRIVAL_RADIUS_METRES) || 100;

/**
 * The stored ETA is refreshed at most this often. Each refresh is a billed
 * Routes call, and an ETA does not meaningfully move faster than this.
 */
const ETA_RECOMPUTE_MS = 5 * 60 * 1000;

/*
 * How far off the drawn line he can be before it is treated as the wrong line
 * rather than an old one.
 *
 * It was 150 m, which is a long way to ride beside a line that says you are
 * somewhere else: a vendor who knows a shortcut takes it, and the customer
 * watches the bike leave the road we drew and keep going. Seventy is past
 * anything GPS noise produces - a city fix is good to 20-50 m and a road has
 * width - and it is about one turning, which is what a shortcut starts with.
 *
 * On its own it would still be twitchy, so nothing acts on a single fix: see
 * offRouteSince on the ticket.
 */
const OFF_ROUTE_METRES = 70;

/** How long he has to stay off the line before it counts as a decision. */
const OFF_ROUTE_SETTLE_MS = 4 * 1000;

/*
 * How far the technician has to travel before we ask where he is.
 *
 * "He is in Rasulgarh" is the one thing a customer watching a map actually
 * wants said out loud, and a name is worth an occasional geocode. Asking on
 * every fix would not be - the position changes every few seconds and the
 * answer changes every few minutes, so the same name would be bought over and
 * over. Two hundred metres is close enough that the name keeps up with him -
 * at four hundred he was still shown in the locality he had left.
 */
const PLACE_RECHECK_METRES = 200;

/**
 * The floor between drift-triggered refreshes, so this cannot loop.
 *
 * Six seconds rather than a minute, and once fifteen. A route costs a call and
 * a minute was the cautious figure; the cost of being slow is the customer
 * watching a marker ride away from the road it is supposed to be on, which is
 * worse than the call. The settle above is what stops noise spending it - four
 * seconds of that is inside this.
 */
const DRIFT_RECHECK_MS = 6 * 1000;

/**
 * And how far he has to have gone since the last one.
 *
 * Time on its own was the wrong measure for a vendor who rides his own way.
 * The customer's line is redrawn from where he is, he carries on down the lane
 * he knows, and six seconds later the line describes him no better than it did
 * before - so the clock alone would buy a route every six seconds for the whole
 * journey, for a line that is always a little behind him anyway.
 *
 * Distance is the honest trigger: a line drawn from a point fifty metres back
 * is a line worth replacing, and one drawn from twenty metres back is not. A
 * rider who stops off the route buys nothing at all.
 *
 * This was a hundred, and a hundred metres is twenty-four seconds on a cycle -
 * which is exactly the wait Mohan was asking about, a bike riding beside a road
 * that is not its own for that long. Fifty halves it, and the calls it costs
 * are inside the monthly allowance for any traffic this will see.
 *
 * It is measured from where the route was asked for, because that is the place
 * it describes.
 */
const DRIFT_RECHECK_METRES = 50;

/**
 * And how far, when there is no line on the screen at all.
 *
 * Short enough that it is asked again on practically every position he sends,
 * because the two situations are not equally bad: off the drawn line the
 * customer is at least watching a road, and with no line at all the bike is in
 * somebody's arms waiting for one. Mohan asked for it in those words - keep
 * asking as he moves, a little further along each time, until the answer is
 * the road he is really on. Twenty-five metres is about six seconds on a bike,
 * which the floor above makes the real limit anyway.
 */
const NO_LINE_RECHECK_METRES = 25;

/**
 * When the road Google offers is not the journey he is making.
 *
 * Some of the lanes a vendor rides are not in the map as roads at all. Asked
 * for a way through them, Google answers with the only thing it has - a ride
 * out to a main road, along it, and back in - and it is not a small
 * difference: ninety metres of lane came back as thirteen hundred, and two
 * hundred and fifty as twelve hundred. Drawn on the customer's screen that is
 * a line looping away from a bike that is going straight, beside a distance
 * that grows while he gets closer.
 *
 * An answer like that is worse than no answer, so it is refused. Nothing is
 * drawn, the screen falls back to the bow it already uses before a route
 * exists - a dashed curve from the bike to the door - and the distance becomes
 * the honest straight-line one. He is still tracked, still moving, and nothing
 * on screen claims to know a road that nobody has.
 *
 * Both tests have to fail for it to be refused. Ratio alone would throw away
 * good routes on short hops, where a one-way system doubles a hundred metres
 * quite legitimately, and around Mohan's own house the real roads run to more
 * than twice the straight line - so the excess has to be large in metres too.
 */
const UNUSABLE_TIMES = 3.5;
const UNUSABLE_EXTRA_METRES = 500;

/**
 * How far the road it gives back may differ from the way he is going.
 *
 * A route computed from a man in a lane the map does not have is often a route
 * back out of that lane - it begins by sending him the way he came, because
 * the nearest road Google knows is the one he left. That answer is not wrong
 * about the roads; it is wrong about him, and drawing it would show a bike
 * riding one way down a line pointing the other.
 *
 * So the first stretch of every fresh route is checked against the way he is
 * actually travelling, and one that disagrees by more than a right angle is
 * refused. He stays carried, and it is asked again a few seconds later from
 * further along - which is exactly what Mohan described: keep asking as he
 * moves until the answer is the road he is really on.
 */
const ROUTE_AGREES_DEGREES = 80;

/** How much of the new line to look at when deciding that. */
const ROUTE_START_METRES = 60;

/** Which way one point lies from another, in degrees from north. */
const bearingBetween = (aLat, aLon, bLat, bLon) => {
    const toRad = (d) => (d * Math.PI) / 180;
    const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
    const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat))
        - Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
    return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
};

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
 * How far a position is from the line the customer is looking at.
 *
 * Google hands the route back encoded, so it has to be unpacked to be measured
 * against. The projection onto each segment is flat maths: over the few
 * kilometres a job covers the error from treating the earth as flat is
 * centimetres, and a great-circle formula cannot project a point onto a
 * segment anyway. Longitude is scaled by cos(latitude) so that "closest" means
 * closest rather than closest-if-you-are-on-the-equator.
 *
 * Returns null when there is no line to measure against, which the caller
 * treats as "no reason to think anything is wrong".
 */
/** Already at the door - no point naming where he is. */
const hasArrivedAlready = (ticket) => Boolean(ticket.ride?.arrivedAt);

const decodeLine = (encoded) => {
    const points = [];
    let index = 0;
    let plat = 0;
    let plon = 0;

    while (index < encoded.length) {
        let result = 0;
        let shift = 0;
        let byte;

        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        plat += (result & 1) ? ~(result >> 1) : result >> 1;

        result = 0;
        shift = 0;

        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        plon += (result & 1) ? ~(result >> 1) : result >> 1;

        points.push([plat / 1e5, plon / 1e5]);
    }

    return points;
};

/**
 * Where the line the customer is looking at was drawn from.
 *
 * Google snaps the origin it is given to the nearest road, so this is within a
 * few metres of where the technician was when the route was bought - which is
 * what makes "how far has he gone since then" answerable without keeping a
 * second copy of it on the ticket.
 */
/**
 * Which way a route sets off, over its first stretch of road.
 *
 * Its first two points can be a metre apart on a curve, which says nothing, so
 * it is measured over a length rather than a point - see ROUTE_START_METRES.
 */
const routeSetsOff = (encoded) => {
    const points = decodeLine(encoded || "");
    if (points.length < 2) return null;

    const from = { lat: points[0][0], lon: points[0][1] };

    for (const [lat, lon] of points.slice(1)) {
        if (metresBetween(from.lat, from.lon, lat, lon) >= ROUTE_START_METRES) {
            return bearingBetween(from.lat, from.lon, lat, lon);
        }
    }

    const last = points[points.length - 1];
    return bearingBetween(from.lat, from.lon, last[0], last[1]);
};

const routeBegins = (encoded) => {
    if (!encoded) return null;

    const points = decodeLine(encoded);
    return points.length ? { lat: points[0][0], lon: points[0][1] } : null;
};

const metresFromRoute = (encoded, lat, lon) => {
    if (!encoded) return null;

    const points = decodeLine(encoded);

    if (points.length < 2) return null;

    const DEG_M = 111320;
    const k = Math.cos((lat * Math.PI) / 180);
    const px = lon * k;
    const py = lat;

    let best = Infinity;

    for (let i = 0; i < points.length - 1; i += 1) {
        const ax = points[i][1] * k;
        const ay = points[i][0];
        const dx = points[i + 1][1] * k - ax;
        const dy = points[i + 1][0] - ay;
        const len2 = dx * dx + dy * dy;

        const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
        const fx = ax + t * dx;
        const fy = ay + t * dy;
        const gap = (px - fx) * (px - fx) + (py - fy) * (py - fy);

        if (gap < best) best = gap;
    }

    return Math.sqrt(best) * DEG_M;
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
const syncRideProgress = async (technician, lat, lon, heading = null) => {
    /*
     * Which way his phone says he is pointing, when it says anything.
     *
     * Worked out on the handset rather than here - see facingFrom in the
     * vendor app - because only the handset has the compass, and only it knows
     * whether he is moving fast enough for the direction of travel to be the
     * better answer.
     */
    const facingDeg = Number.isFinite(Number(heading)) ? Number(heading) : null;

    try {
        const ticket = await ticketModel.findOne({
            technician: technician._id,
            status: "Assigned",
        }).sort({ assignedAt: -1 });

        if (!ticket) return;

        const destLon = ticket.location?.coordinates?.[0];
        const destLat = ticket.location?.coordinates?.[1];
        if (!Number.isFinite(destLat) || !Number.isFinite(destLon)) return;

        /*
         * Arrived is not the end of the ride.
         *
         * This used to stop dead here, which froze the bike on the customer's
         * map at whatever point it crossed the hundred metre line - so the
         * marker sat in the middle of a road while the vendor was walking up
         * to the door, and the last hundred metres, which is the stretch the
         * customer is actually watching, never happened on screen. Mohan's
         * rule: the bike goes to the door and stops beside it.
         *
         * So positions keep flowing. What does not happen twice is the
         * announcement, the route refresh - both pointless at this range - and
         * the geocode.
         */
        const alreadyArrived = Boolean(ticket.ride?.arrivedAt);

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
        /*
         * Accepting counts as well, not only pressing Directions.
         *
         * The customer's stage turns on the moment somebody agrees to come,
         * and this emit has to answer the same way the REST payload does, or a
         * position ping arriving between the accept and the Directions tap
         * would quietly put the screen back to "Finding somebody".
         */
        const started = Boolean(ticket.ride?.startedAt || ticket.acceptedAt);

        /*
         * No route until somebody has agreed to come.
         *
         * The route used to be worked out from the very first position that
         * arrived, on the reasoning that a line is information and only the
         * announcement should wait. In front of a customer that reads as a
         * promise: they see the full blue road route drawn from a vendor who
         * has not accepted the job and may hand it straight back.
         *
         * Mohan's rule is the one every delivery app follows. Before the
         * accept: a dashed arc from him to the door and a man standing still.
         * After it: the road route and the bike. So nothing is computed here
         * until he has said yes - which also means an offer that is refused
         * costs no Routes call at all.
         *
         * His position still goes out, because the arc is drawn from it.
         */
        if (!started) {
            if (ticket.tracking?.token) {
                emitToRoom(trackRoom(ticket.tracking.token), "track:update", {
                    stage: "assigned",
                    technicianAt: { lat, lon, at: now, heading: facingDeg },
                });
            }
            return;
        }

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

            /*
             * A route also goes stale by being wrong, not only by being old.
             *
             * The five minute timer assumes he is following the line we drew.
             * When he is not - a different turning, a road closed, or a route
             * worked out from a position that was already old when he pressed
             * Directions - the customer sees a bike sitting on a road it is
             * not on, pointing the way that road runs, with the part he has
             * already ridden still drawn ahead of him. It reads as the bike
             * going back the way it came, because that is what is on screen.
             *
             * So drift forces a refresh as well as age, with a shorter floor
             * so it cannot loop: off the line by more than OFF_ROUTE_METRES
             * and at least DRIFT_RECHECK_MS since the last one.
             */
            const age = now.getTime() - computedAt;
            const drift = metresFromRoute(ticket.ride?.encodedPolyline, lat, lon);
            const wandered = drift !== null && drift > OFF_ROUTE_METRES;

            /*
             * Off the line, and not for the first time.
             *
             * The moment it started is kept on the ticket, so a fix that lands
             * in the next street on its own is forgotten as soon as the next
             * one lands back on the road. Two in a row, six seconds apart, is
             * a man who has taken a different turning.
             */
            if (!wandered) {
                ticket.ride.offRouteSince = null;
            } else if (!ticket.ride.offRouteSince) {
                ticket.ride.offRouteSince = now;
            }

            const strayed = wandered
                && ticket.ride.offRouteSince
                && now.getTime() - new Date(ticket.ride.offRouteSince).getTime() >= OFF_ROUTE_SETTLE_MS;

            const lost = strayed;

            /*
             * How far he has come since this line was drawn.
             *
             * A vendor who knows the area does not follow the road we drew: he
             * rides the lanes he knows, and the customer is left watching a
             * bike beside a line that belongs to a journey nobody is making.
             * The answer is to draw it again from where he is - and to keep
             * doing that as he goes, which is what makes the drawn road end up
             * being the road he actually took.
             */
            const asked = ticket.ride?.askedFrom?.lat != null
                ? ticket.ride.askedFrom
                : routeBegins(ticket.ride?.encodedPolyline);

            const goneSince = asked
                ? metresBetween(lat, lon, asked.lat, asked.lon)
                : Infinity;

            /*
             * No line at all, and he is riding.
             *
             * Either the last answer was refused as nonsense - see
             * UNUSABLE_TIMES - or Google was down when it was asked. Both leave
             * the customer on the bow, and both are worth another try as he
             * moves: a hundred metres further on he may be back on roads the
             * map knows, and the line can come back.
             */
            const noLine = !ticket.ride?.encodedPolyline;

            /*
             * And whether anybody is actually looking at it.
             *
             * A route is bought so that a line can be drawn on somebody's
             * screen. Most customers never open one: they book, they get the
             * push when he sets off, and they meet him at the door. Redrawing
             * the road for them every hundred metres is money spent on a
             * picture nobody sees - and at five hundred jobs a day it is the
             * largest bill this system has.
             *
             * Both the map and the job card hold a socket on this token while
             * they are open, so one question answers both: is any screen
             * watching this job right now? The first route is not asked this -
             * see the note where the ride starts - because its ETA is what the
             * card, the push and the assistant all quote, watched or not.
             *
             * When somebody opens a screen, whatever was last drawn is what
             * they get, and it is made stale at once so the next position
             * refreshes it. See the track room in socketManager.
             */
            const watched = roomSize(trackRoom(ticket.tracking?.token || "")) > 0;

            /*
             * Skip the refresh when we are about to declare arrival anyway -
             * paying for a route to a point 100 m away is money for nothing.
             *
             * The five minute one is not asked whether anybody is watching. It
             * is the ETA, and the ETA is quoted to people who are not looking
             * at a screen at all: the assistant answers "kitni der" with it on
             * WhatsApp, and the card and the push carry it. Letting that go
             * stale for a whole ride to save a handful of calls would be saving
             * money on the one number the customer actually asks for.
             *
             * The frequent ones are the opposite. Redrawing every fifty metres
             * exists to keep a line under a bike on a map, and a map nobody has
             * open needs no line. Those are the many, so those are gated.
             */
            const worthRefreshing =
                !alreadyArrived &&
                distance > ARRIVAL_RADIUS_METRES &&
                (age > ETA_RECOMPUTE_MS
                    || (watched
                        && (lost || noLine)
                        && age > DRIFT_RECHECK_MS
                        && goneSince > (noLine ? NO_LINE_RECHECK_METRES : DRIFT_RECHECK_METRES)));

            if (worthRefreshing) {
                /*
                 * The way he has been going, so the new route starts the way
                 * he is already pointing rather than with a U-turn.
                 *
                 * From where the last line was drawn to where he is now, which
                 * is a hundred metres or so of actual travel - a steadier
                 * answer than the last two fixes, which can disagree by ninety
                 * degrees on a phone in a pocket. Too short a hop and there is
                 * no direction in it worth sending.
                 */
                const facing = asked && goneSince > 30 && goneSince < Infinity
                    ? bearingBetween(asked.lat, asked.lon, lat, lon)
                    : null;

                /** Is this a road, or the map's way of saying it has none? */
                const nonsense = (answer) => {
                    const byRoad = Number(answer?.distanceMeters) || 0;

                    if (byRoad > 0
                        && byRoad > distance * UNUSABLE_TIMES
                        && byRoad - distance > UNUSABLE_EXTRA_METRES) return true;

                    /*
                     * And does it go the way he is going? See
                     * ROUTE_AGREES_DEGREES. Only asked when we know which way
                     * that is - at the start of a ride we do not.
                     */
                    const sets = facing === null ? null : routeSetsOff(answer?.encodedPolyline);
                    if (sets === null) return false;

                    const apart = Math.abs((((sets - facing) % 360) + 540) % 360 - 180);
                    return apart > ROUTE_AGREES_DEGREES;
                };

                const route = await routeService.computeRoute(
                    { lat, lon },
                    { lat: destLat, lon: destLon },
                    { heading: facing }
                );

                if (route) {
                    const byRoad = Number(route.distanceMeters) || 0;
                    const unusable = nonsense(route);

                    if (unusable) {
                        console.log(
                            "[RIDE] " + ticket.ticketNumber + ": Google wants " + Math.round(byRoad)
                            + " m for " + Math.round(distance) + " m - no road here, he is carried"
                        );
                    }

                    ticket.ride.etaSeconds = unusable ? null : (route.durationSeconds ?? null);
                    ticket.ride.distanceMeters = unusable ? null : (route.distanceMeters ?? null);
                    ticket.ride.etaAt = (!unusable && route.durationSeconds)
                        ? new Date(now.getTime() + route.durationSeconds * 1000)
                        : null;
                    ticket.ride.encodedPolyline = unusable ? null : (route.encodedPolyline ?? null);
                    ticket.ride.computedAt = now;

                    // Where it was asked from, drawn or not - it is what says
                    // how far he has come before it is worth asking again.
                    ticket.ride.askedFrom = { lat, lon };

                    // The new line is drawn from where he is, so he is on it.
                    // No line and there is nothing for him to be off.
                    ticket.ride.offRouteSince = null;
                }
            }
        }

        /*
         * And where that is, in words, when he has moved far enough to be
         * somewhere else.
         *
         * Looked up here rather than on each customer's phone, so one geocode
         * serves the app, the web page and anybody else watching. It never
         * fails the ride: a name is a nicety and the map is the substance.
         */
        const namedAt = ticket.ride?.placeAt;
        const movedSincePlace = Number.isFinite(namedAt?.lat)
            ? metresBetween(lat, lon, namedAt.lat, namedAt.lon)
            : Infinity;

        if (!hasArrivedAlready(ticket) && movedSincePlace > PLACE_RECHECK_METRES) {
            try {
                const place = (await lookupPlace(lat, lon))?.results?.[0];
                const name = String(place?.locality || place?.city || "").trim();

                if (name) {
                    ticket.ride.nearPlace = name;
                    ticket.ride.placeAt = { lat, lon };
                }
            } catch (err) {
                console.error("[RIDE] place lookup failed:", err.message);
            }
        }

        const hasArrived = distance <= ARRIVAL_RADIUS_METRES;

        // The moment it crosses the line, once. Everything after that is just
        // the last few metres being drawn.
        const justArrived = hasArrived && !alreadyArrived;
        if (justArrived) ticket.ride.arrivedAt = now;

        await ticket.save();

        const plain = ticket.toObject();

        // The customer's page moves on this, not on a timer. Every fix that
        // reaches the server reaches them, which is what makes the marker
        // crawl rather than jump.
        if (ticket.tracking?.token) {
            emitToRoom(trackRoom(ticket.tracking.token), "track:update", {
                technicianAt: { lat, lon, at: now, heading: facingDeg },

                /*
                 * "assigned" until he has actually set off.
                 *
                 * This used to say on_the_way on every ping, which announced a
                 * departure that had not happened - the whole reason the
                 * button exists. Arriving still overrides everything, because
                 * being at the door is a fact whatever the record says.
                 */
                stage: (hasArrived || alreadyArrived)
                    ? "arrived"
                    : (started ? "on_the_way" : "assigned"),
                etaSeconds: ticket.ride?.etaSeconds ?? null,
                etaAt: ticket.ride?.etaAt || null,
                distanceMeters: ticket.ride?.distanceMeters ?? null,
                encodedPolyline: ticket.ride?.encodedPolyline || null,
                nearPlace: ticket.ride?.nearPlace || null,

                /*
                 * Whether the line on their screen still describes him.
                 *
                 * Sent rather than worked out on each phone, because the
                 * server is the one holding both the line and the fix - and
                 * because it has already waited for a second fix before
                 * believing it. A screen that knows he is off the road can
                 * stop drawing that road at once, which is the whole of "the
                 * line should move with the bike"; the real new route follows
                 * a few seconds later.
                 */
                offRoute: Boolean(ticket.ride?.offRouteSince),
            });
        }

        /*
         * The arrival message goes out once, because arrivedAt is the guard at
         * the top of this function on every later ping.
         *
         * The "he has set off" message used to live here too, behind
         * `isFirstFix && started`, and it never fired once. markOnTheWay works
         * the route out itself, which sets computedAt - so by the time the
         * first GPS fix arrived, isFirstFix was already false. It now goes out
         * from markOnTheWay, which is the moment it describes anyway.
         */

        if (justArrived) {
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

        /*
         * Reported, because this is the catch that hid the worst bug of the
         * week: a require cycle left the notifier undefined, every fix threw
         * here, and the line above was the only trace - in a log file nobody
         * had open. A customer's arrival message simply stopped existing.
         */
        errors.report(error, "ride.sync", { technician: String(technician?._id || "") });
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
const markOnTheWay = async (technicianId, ticketId, at = null) => {
    const ticket = await ticketModel.findOne({
        _id: ticketId,
        technician: technicianId,
        status: "Assigned",
    });

    if (!ticket) {
        /*
         * The commonest reason is the honest one: the job is not his, or it
         * has already moved past Assigned. Worth a line either way - this is
         * the call behind "I tapped Directions and the customer's page did
         * not change", and silence here is what made that hard to chase.
         */
        console.warn("[RIDE] on-the-way refused: ticket " + ticketId + " is not assigned to " + technicianId);
        return { ok: false, code: "not_yours" };
    }

    if (ticket.ride?.startedAt) {
        console.log("[RIDE] " + ticket.ticketNumber + " was already on the way");
        return { ok: true, ticket, already: true };
    }

    const destLon = ticket.location?.coordinates?.[0];
    const destLat = ticket.location?.coordinates?.[1];

    /*
     * The position the app sent, before the one on file.
     *
     * This is the whole reason the bike used to appear late. Tapping
     * Directions hands the vendor straight to Google Maps, and on Android the
     * foreground GPS watcher stops the moment this app is no longer in front -
     * so no new position reached the server until he came back, which is
     * exactly when Mohan saw the bike turn up. The app now sends its last fix
     * with the tap, so the customer has a marker the same second.
     */
    const sent = Number.isFinite(Number(at?.lat)) && Number.isFinite(Number(at?.lon))
        ? { lat: Number(at.lat), lon: Number(at.lon) }
        : null;

    const tech = sent
        ? null
        : await technicianModel.findById(technicianId).select("location").lean();

    const coords = tech?.location?.coordinates;
    const from = sent || (Array.isArray(coords) && coords.length === 2
        ? { lat: coords[1], lon: coords[0] }
        : null);

    // Written back, so anything that reads the record later - the customer's
    // page on a plain refresh, the office board - sees the same place.
    if (sent) {
        await technicianModel.updateOne(
            { _id: technicianId },
            {
                $set: {
                    location: { type: "Point", coordinates: [sent.lon, sent.lat] },
                    lastLocationAt: new Date(),
                },
            }
        );
    }

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

    console.log(
        "[RIDE] " + ticket.ticketNumber + " is on the way"
        + (from ? "" : " - no position stored yet, so the customer gets the stage without a marker")
        + (ticket.ride.encodedPolyline ? " (route found)" : " (no route)")
    );

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

    /*
     * And the customer is told, here, because here is where it happened.
     *
     * This used to sit in syncRideProgress behind "first GPS fix and already
     * started", which could never both be true - this function works the route
     * out itself, and that is what marks the ride as computed. The message was
     * dead from the day the Directions button became the start of the ride.
     */
    const plain = ticket.toObject();
    await notification.notifyCustomerTechnicianEnRoute(plain);
    notification.notifyAdminsRideStarted(plain);

    return { ok: true, ticket };
};

/**
 * Tells whoever is watching the map that the job has changed hands.
 *
 * The arc the customer sees before anybody accepts is drawn from the assigned
 * vendor to their door, and it has to follow the assignment: the office moves
 * the job, the arc moves with it; the vendor hands it back, the arc goes. None
 * of that reaches the page on its own, because the page is fed by position
 * pings and a vendor who no longer has the job stops sending them - so the arc
 * would sit where he was, pointing at a house nobody is going to.
 *
 * Called with no technician for a hand-back, which sends the marker away and
 * puts the screen back to "Finding somebody".
 */
const announceAssignment = async (ticket, technicianId) => {
    if (!ticket?.tracking?.token) return;

    let technicianAt = null;

    if (technicianId) {
        const tech = await technicianModel
            .findById(technicianId)
            .select("location lastLocationAt")
            .lean()
            .catch(() => null);

        const coords = tech?.location?.coordinates;
        if (Array.isArray(coords) && coords.length === 2) {
            technicianAt = { lat: coords[1], lon: coords[0], at: tech.lastLocationAt || null };
        }
    }

    emitToRoom(trackRoom(ticket.tracking.token), "track:update", {
        stage: "assigned",
        technicianAt,

        // The route belonged to the last ride. There is no route until somebody
        // sets off, and the screens clear theirs on seeing this stage.
        encodedPolyline: null,
        etaSeconds: null,
        etaAt: null,
        distanceMeters: null,
        nearPlace: null,
    });
};

/**
 * And that somebody has said yes.
 *
 * Nothing about the ride changes here - he has not set off - but the customer
 * moves from "Finding somebody" to being told who is coming, and the screen
 * should do that without waiting for the next position ping.
 */
const announceAccepted = async (ticket) => {
    if (!ticket?.tracking?.token) return;

    const tech = ticket.technicianSnapshot || {};

    /*
     * The road, worked out here, in the same breath as the yes.
     *
     * Nothing is routed before the accept - see syncRideProgress - so at this
     * moment the customer's screen has a dashed arc on it. If the route waited
     * for his next position ping the bike would appear over that arc and sit
     * there for several seconds, which is precisely what Mohan saw: the bike
     * arrives instantly, the line is still dashed, and only leaving the screen
     * and coming back produces the real road.
     *
     * One Routes call, at the one moment it is certainly worth paying for -
     * somebody has agreed to come.
     */
    let ride = null;

    const destLon = ticket.location?.coordinates?.[0];
    const destLat = ticket.location?.coordinates?.[1];

    const at = await technicianModel
        .findById(ticket.technician)
        .select("location lastLocationAt")
        .lean()
        .catch(() => null);

    const coords = at?.location?.coordinates;
    const from = (Array.isArray(coords) && coords.length === 2)
        ? { lat: coords[1], lon: coords[0] }
        : null;

    if (from && Number.isFinite(destLat) && Number.isFinite(destLon)) {
        const route = await routeService
            .computeRoute(from, { lat: destLat, lon: destLon })
            .catch(() => null);

        if (route) {
            const now = new Date();

            ride = {
                arrivedAt: null,
                origin: from,
                etaSeconds: route.durationSeconds ?? null,
                distanceMeters: route.distanceMeters ?? null,
                etaAt: route.durationSeconds
                    ? new Date(now.getTime() + route.durationSeconds * 1000)
                    : null,
                encodedPolyline: route.encodedPolyline ?? null,
                computedAt: now,
            };

            // startedAt is deliberately absent: he has agreed to come, he has
            // not set off. That is still the Directions button's to say.
            await ticketModel.updateOne({ _id: ticket._id }, { $set: { ride } }).catch(() => {});
        }
    }

    emitToRoom(trackRoom(ticket.tracking.token), "track:update", {
        stage: "on_the_way",

        technicianAt: from ? { ...from, at: at?.lastLocationAt || new Date() } : null,
        encodedPolyline: ride?.encodedPolyline || null,
        etaSeconds: ride?.etaSeconds ?? null,
        etaAt: ride?.etaAt || null,
        distanceMeters: ride?.distanceMeters ?? null,

        // Who, in the same breath. The page has been showing a nameless arc
        // and this is the answer to it - waiting for the next position ping to
        // carry it would leave a gap of several seconds on the one update the
        // customer has been sitting there for.
        technician: {
            name: tech.name || null,
            phone: tech.phone || null,
            rating: tech.rating ? Number(tech.rating).toFixed(1) : null,
            photo: tech.profileImage || null,
        },
    });
};

module.exports = {
    syncRideProgress,
    markOnTheWay,
    metresBetween,
    announceAssignment,
    announceAccepted,
    ARRIVAL_RADIUS_METRES,
};

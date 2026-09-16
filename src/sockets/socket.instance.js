let io = null;

const setIo = (instance) => {
    io = instance;
};

const getIo = () => io;

const userRoom = (userId) => `user_${String(userId)}`;
const techRoom = (techId) => `tech_${String(techId)}`;
// One room per tracking link. The token is the room name because the
// token is already the credential - anyone holding it can watch this job.
const trackRoom = (token) => `track_${String(token)}`;
const adminRoom = () => "admins"; // saare backoffice staff ek hi room mein

const emitToRoom = (room, event, payload) => {
    if (!io) {
        console.warn(`Socket not ready, skipped emit "${event}" to ${room}`);
        return;
    }
    try {
        io.to(room).emit(event, payload);
    } catch (err) {
        console.error(`Socket emit failed (${event}):`, err.message);
    }
};

/**
 * How many devices are actually listening to a room, right now.
 *
 * `emit` succeeds whether or not anybody is there - it is a broadcast into a
 * room, not a delivery to a person - and that is what makes "the phone did not
 * ring" so hard to chase: the server log says the event was sent, and it was,
 * to nobody. This answers the only question that matters at that moment, which
 * is whether there was anyone to send it to.
 *
 * Zero on any failure. A count that cannot be read must not be reported as
 * listeners present, because the whole point of asking is to notice absence.
 */
const roomSize = (room) => {
    if (!io) return 0;
    try {
        return io.sockets.adapter.rooms.get(room)?.size || 0;
    } catch {
        return 0;
    }
};

/**
 * Cut every live socket in a room, now.
 *
 * The connect-time check runs once. A vendor who is deleted or blocked while
 * his app is open keeps the socket he already has, and the office goes on
 * counting him as reachable - which was reported exactly that way: "I deleted
 * the vendor and he is still connected."
 *
 * `close: true` closes the underlying transport rather than only the
 * namespace, so the client sees a real disconnect instead of silently
 * reattaching.
 */
const dropRoom = (room) => {
    if (!io) return;
    try {
        io.in(room).disconnectSockets(true);
    } catch (err) {
        console.error(`Socket drop failed (${room}):`, err.message);
    }
};

module.exports = { setIo, getIo, userRoom, techRoom, trackRoom, adminRoom, emitToRoom, roomSize, dropRoom };
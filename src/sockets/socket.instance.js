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

module.exports = { setIo, getIo, userRoom, techRoom, trackRoom, adminRoom, emitToRoom };
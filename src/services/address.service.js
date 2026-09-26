const userModel = require("../models/user.model");

/**
 * The places a customer can have somebody sent to.
 *
 * The account has always carried one address, and everything already written
 * reads it straight off the user: registration, the WhatsApp flow, the web
 * panel, the booking. That address has not moved. What lives here is the list
 * around it, and one rule that keeps the two in step - whichever entry is
 * marked default *is* the account's address, copied onto the same fields the
 * rest of the code has always read.
 *
 * Doing it that way means nothing else had to be taught about the list. A
 * customer with one address behaves exactly as before; a customer with three
 * has two more to choose from at the moment of booking, and choosing one does
 * not change where they live.
 *
 * There is no migration. An account whose list is empty but whose address is
 * set gets that address seeded into the list the first time the list is read,
 * so the first thing a long-standing customer sees is their own address rather
 * than an empty screen and a form.
 */

/** The fields an address carries, taken off whatever shape arrives. */
const clean = (body = {}) => ({
    label: String(body.label || "").trim().slice(0, 40),
    address: String(body.address || "").trim().slice(0, 300),
    area: String(body.area || "").trim().slice(0, 120),
    city: String(body.city || "").trim().slice(0, 80),
    state: String(body.state || "").trim().slice(0, 80),
    pincode: String(body.pincode || "").trim().slice(0, 10),

    // What gets somebody through the gate rather than to the road. See the
    // note on these in the user model.
    floor: String(body.floor || "").trim().slice(0, 40),
    landmark: String(body.landmark || "").trim().slice(0, 120),
    lat: Number.isFinite(Number(body.lat)) ? Number(body.lat) : undefined,
    lon: Number.isFinite(Number(body.lon)) ? Number(body.lon) : undefined,
});

/** Is there enough here to send somebody to it? */
const isUsable = (a) => Number.isFinite(a?.lat) && Number.isFinite(a?.lon);

/**
 * The account's own address fields, rewritten from whichever entry is default.
 *
 * This is the whole compatibility story in one function. Everything that reads
 * `user.address`, `user.lat`, `user.location` keeps working, and keeps getting
 * the right answer, because the default is copied onto them whenever the list
 * changes.
 */
const mirrorDefault = (user) => {
    const main = (user.addresses || []).find((a) => a.isDefault) || (user.addresses || [])[0];
    if (!main) return;

    user.address = main.address;
    user.area = main.area;
    user.city = main.city;
    user.state = main.state;
    user.pincode = main.pincode;
    user.lat = main.lat;
    user.lon = main.lon;

    if (isUsable(main)) {
        user.location = { type: "Point", coordinates: [main.lon, main.lat] };
    }
};

/**
 * Seed the list from the account's address, once, for customers who had one
 * before the list existed.
 */
const seedIfEmpty = (user) => {
    if ((user.addresses || []).length) return false;
    if (!user.address && !isUsable(user)) return false;

    user.addresses = [{
        label: "Home",
        address: user.address || "",
        area: user.area || "",
        city: user.city || "",
        state: user.state || "",
        pincode: user.pincode || "",
        lat: user.lat,
        lon: user.lon,
        isDefault: true,
    }];

    return true;
};

/** Exactly one default, whatever happened above. */
const settleDefault = (user, preferId) => {
    const list = user.addresses || [];
    if (!list.length) return;

    let chosen = preferId ? list.find((a) => String(a._id) === String(preferId)) : null;
    if (!chosen) chosen = list.find((a) => a.isDefault) || list[0];

    list.forEach((a) => { a.isDefault = String(a._id) === String(chosen._id); });
};

const list = async (userId) => {
    const user = await userModel.findById(userId);
    if (!user) return [];

    if (seedIfEmpty(user)) {
        settleDefault(user);
        await user.save();
    }

    return (user.addresses || []).map((a) => a.toObject());
};

const add = async (userId, body) => {
    const user = await userModel.findById(userId);
    if (!user) throw new Error("No such customer");

    const entry = clean(body);
    if (!isUsable(entry)) throw new Error("An address needs a point on the map");

    seedIfEmpty(user);

    /*
     * The first address a customer saves becomes the default, because there is
     * nothing else it could be. After that, the caller has to ask.
     */
    const first = !(user.addresses || []).length;
    user.addresses.push({ ...entry, isDefault: first });

    const added = user.addresses[user.addresses.length - 1];
    settleDefault(user, (first || body.isDefault) ? added._id : undefined);
    mirrorDefault(user);

    await user.save();
    return added.toObject();
};

const update = async (userId, addressId, body) => {
    const user = await userModel.findById(userId);
    if (!user) throw new Error("No such customer");

    seedIfEmpty(user);

    const entry = (user.addresses || []).id(addressId);
    if (!entry) throw new Error("No such address");

    Object.entries(clean(body)).forEach(([k, v]) => {
        // An absent field is left alone; only what was sent is changed.
        if (v !== undefined && v !== "") entry[k] = v;
    });

    settleDefault(user, body.isDefault ? entry._id : undefined);
    mirrorDefault(user);

    await user.save();
    return entry.toObject();
};

const remove = async (userId, addressId) => {
    const user = await userModel.findById(userId);
    if (!user) throw new Error("No such customer");

    seedIfEmpty(user);

    const entry = (user.addresses || []).id(addressId);
    if (!entry) throw new Error("No such address");

    /*
     * The last one stays.
     *
     * An account with no address cannot book at all, and the screen that would
     * explain why does not exist. Refusing here is kinder than letting somebody
     * delete their way into a dead end.
     */
    if (user.addresses.length === 1) throw new Error("This is your only address");

    entry.deleteOne();

    settleDefault(user);
    mirrorDefault(user);

    await user.save();
    return true;
};

const setDefault = async (userId, addressId) => {
    const user = await userModel.findById(userId);
    if (!user) throw new Error("No such customer");

    seedIfEmpty(user);

    const entry = (user.addresses || []).id(addressId);
    if (!entry) throw new Error("No such address");

    settleDefault(user, entry._id);
    mirrorDefault(user);

    await user.save();
    return entry.toObject();
};

/**
 * Where this particular job should go.
 *
 * Given an id, that address. Given nothing, the account's own - which is the
 * default entry, or the fields themselves for a customer who has never opened
 * the list. So a caller that knows nothing about addresses keeps behaving
 * exactly as it did.
 */
const resolve = async (user, addressId) => {
    const fallback = {
        address: user.address || "",
        area: user.area || "",
        city: user.city || "",
        state: user.state || "",
        pincode: user.pincode || "",
        lat: user.lat,
        lon: user.lon,
    };

    if (!addressId) return fallback;

    const found = (user.addresses || []).find((a) => String(a._id) === String(addressId));
    if (!found || !isUsable(found)) return fallback;

    return {
        address: found.address || "",
        area: found.area || "",
        city: found.city || "",
        state: found.state || "",
        pincode: found.pincode || "",
        lat: found.lat,
        lon: found.lon,
    };
};

module.exports = { list, add, update, remove, setDefault, resolve, isUsable };

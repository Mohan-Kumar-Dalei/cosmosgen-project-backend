const ServiceModel = require("../models/service.model");
const { SERVICE_CATALOG, setCatalog } = require("../config/services");
const { SERVICE_IMAGE_DEFAULTS, APPLIANCE_IMAGE_DEFAULTS } = require("../config/siteImages");

/**
 * Keeps the in-memory catalogue and the database saying the same thing.
 *
 * Everything in this codebase reads the catalogue synchronously - the WhatsApp
 * menu builder, the assistant's prompt, the skill regex that decides who can
 * be sent to a job. Making all of those asynchronous to move four services
 * into a collection would have been a large change to a booking flow that
 * works, for no benefit to anybody.
 *
 * So the array they read stays exactly where it was and this file keeps it
 * current: seeded from the file on first boot, reloaded from the database
 * after every change the office makes. One source of truth, and no caller had
 * to learn a new shape.
 */

/** The file's own four, written in the first time the server ever starts. */
const seedFromConfig = async (fileCatalog) => {
    const existing = await ServiceModel.countDocuments();
    if (existing > 0) return 0;

    const rows = fileCatalog.map((service, i) => ({
        key: service.key,
        label: service.label,
        labelHinglish: service.labelHinglish,
        labelOdia: service.labelOdia,
        worker: service.worker,
        keywords: service.keywords || [],
        appliances: (service.appliances || []).map((a) => ({
            key: a.key,
            label: a.label,
            labelHinglish: a.labelHinglish,
            labelOdia: a.labelOdia,
            issues: a.issues || [],
        })),
        issues: service.issues || [],
        order: i * 10,
        isActive: true,
        source: "config",
    }));

    await ServiceModel.insertMany(rows);
    return rows.length;
};

/** Turn a stored document back into the shape every caller already expects. */
const toCatalogEntry = (doc) => ({
    key: doc.key,
    label: doc.label,
    labelHinglish: doc.labelHinglish || doc.label,
    labelOdia: doc.labelOdia || doc.label,
    worker: doc.worker || "technician",
    keywords: doc.keywords?.length ? doc.keywords : [doc.label.toLowerCase()],

    // The drawing it ships with, until somebody chooses another
    image: doc.image || SERVICE_IMAGE_DEFAULTS[doc.key] || "",
    blurb: doc.blurb || "",
    badges: doc.badges || [],

    appliances: (doc.appliances || []).map((a) => ({
        key: a.key,
        label: a.label,
        labelHinglish: a.labelHinglish || a.label,
        labelOdia: a.labelOdia || a.label,
        image: a.image || APPLIANCE_IMAGE_DEFAULTS[a.key] || "",
        issues: a.issues || [],
    })),

    issues: doc.issues || [],
});

/**
 * Reload the array the rest of the app reads.
 *
 * Mutated in place rather than replaced, because several modules captured the
 * reference when they were first required - handing back a new array would
 * leave them all pointing at the old one for the life of the process.
 */
const refresh = async () => {
    const docs = await ServiceModel.find({ isActive: true })
        .sort({ order: 1, createdAt: 1 })
        .lean();

    if (!docs.length) return SERVICE_CATALOG.length;

    setCatalog(docs.map(toCatalogEntry));
    return docs.length;
};

/**
 * Called once at boot, after the database connects.
 *
 * A failure here must not stop the server: the file's own catalogue is still
 * in memory and every existing flow works off it, so the worst case is that
 * the office's newest service is missing until the next restart. That is a
 * much better Tuesday than a platform that will not start.
 */
const init = async () => {
    try {
        const seeded = await seedFromConfig(SERVICE_CATALOG.map((s) => s));
        if (seeded) console.log("Catalogue seeded with " + seeded + " services from config");

        const loaded = await refresh();
        console.log("Catalogue loaded: " + loaded + " services");
    } catch (error) {
        console.error("Catalogue init failed, staying on the file's copy:", error.message);
    }
};

module.exports = { init, refresh, toCatalogEntry };

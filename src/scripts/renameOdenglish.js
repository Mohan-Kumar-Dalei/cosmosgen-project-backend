require("dotenv").config();
const mongoose = require("mongoose");

/**
 * Renames the Odia language from `odenglish` to `odia`, everywhere it is
 * stored.
 *
 * The language was called "odenglish" while it was written as Odia in Roman
 * letters mixed with English. It is plain Odia in Odia script now, so the name
 * was wrong - but the old word is written on customer records, conversations,
 * call logs and every service the office has added through the panel, so
 * renaming it in code is only half the job.
 *
 * Until this has run, `config/languages.js` still understands the old word on
 * the way in, so nothing breaks in between. Run it once per deployment, after
 * the code is deployed, and the legacy entry there can be dropped afterwards.
 *
 *   node src/scripts/renameOdenglish.js            # say what would change
 *   node src/scripts/renameOdenglish.js --write    # change it
 *
 * Safe to run twice: everything below matches only documents that still carry
 * the old name.
 */
const WRITE = process.argv.includes("--write");

const run = async () => {
    if (!process.env.MONGODB_URI) {
        console.error("MONGODB_URI is not set. Run this from the backend folder, with its .env.");
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.db;
    console.log((WRITE ? "WRITING to " : "Reading (no changes) ") + db.databaseName + "\n");

    /* ---- the three collections that store a chosen language ---- */
    for (const name of ["users", "conversations", "calls"]) {
        const filter = { language: "odenglish" };
        const count = await db.collection(name).countDocuments(filter);

        if (!count) {
            console.log(name + ": nothing to change");
            continue;
        }

        if (!WRITE) {
            console.log(name + ": " + count + " document(s) would become odia");
            continue;
        }

        const res = await db.collection(name).updateMany(filter, { $set: { language: "odia" } });
        console.log(name + ": " + res.modifiedCount + " document(s) set to odia");
    }

    /*
     * ---- the catalogue ----
     *
     * Rewritten document by document rather than with $rename. The Odia label
     * sits at three depths - on the service, on each appliance, and on every
     * issue inside both - and $rename cannot reach a field inside an array.
     */
    const services = await db.collection("services")
        .find({ $or: [{ labelOdenglish: { $exists: true } }, { "issues.odenglish": { $exists: true } }] })
        .toArray();

    if (!services.length) {
        console.log("services: nothing to change");
    } else if (!WRITE) {
        console.log("services: " + services.length + " document(s) would have their Odia fields renamed");
    } else {
        let changed = 0;

        for (const service of services) {
            // A label, or a list of issues, or a list of appliances that have
            // both of their own.
            const moveLabel = (node) => {
                if (!node || node.labelOdenglish === undefined) return node;
                const { labelOdenglish, ...rest } = node;
                return { ...rest, labelOdia: labelOdenglish };
            };

            const moveIssues = (issues) => (Array.isArray(issues)
                ? issues.map((issue) => {
                    if (!issue || issue.odenglish === undefined) return issue;
                    const { odenglish, ...rest } = issue;
                    return { ...rest, odia: odenglish };
                })
                : issues);

            const next = moveLabel({ ...service });
            next.issues = moveIssues(next.issues);

            if (Array.isArray(next.appliances)) {
                next.appliances = next.appliances.map((appliance) => {
                    const moved = moveLabel({ ...appliance });
                    moved.issues = moveIssues(moved.issues);
                    return moved;
                });
            }

            delete next._id;

            await db.collection("services").replaceOne({ _id: service._id }, next);
            changed += 1;
        }

        console.log("services: " + changed + " document(s) rewritten");
    }

    if (!WRITE) {
        console.log("\nNothing was changed. Run it again with --write to apply.");
    }

    await mongoose.disconnect();
    process.exit(0);
};

run().catch((err) => {
    console.error("Rename failed:", err.message);
    process.exit(1);
});

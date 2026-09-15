/**
 * The neighbourhoods India Post has never heard of.
 *
 * The area list a vendor picks from is built from India Post's directory,
 * which is free, accurate and complete - about *post offices*. A great many
 * real neighbourhoods do not have one. Palasuni is a well known part of
 * Bhubaneswar whose post is handled from G.G.P.Colony, so 751025 returns one
 * name and it is not the one anybody living there would say.
 *
 * Two things already cover most of that gap: the field is typed rather than
 * chosen, and whatever an approved vendor types is offered to the next vendor
 * from the same town. This file is for the third case - a place the office
 * already knows is missing and would rather not wait for a vendor to discover.
 *
 * Only add a name somebody who knows the town has actually given you. The
 * point of the directory is that nobody invented it; a list of guesses
 * alongside it would quietly undo that.
 *
 * `pincode` is the one the locality sits in, which the form uses to fill the
 * field in when this is picked. Leave it empty if it is genuinely not known -
 * the vendor's own pincode still stands.
 */
const EXTRA_AREAS = {
    Bhubaneswar: [
        { name: "Palasuni", pincode: "751025" },
    ],
};

/** What we hold for one town, or nothing. Matching is case-insensitive. */
const extraAreasFor = (city) => {
    const want = String(city || "").trim().toLowerCase();
    const key = Object.keys(EXTRA_AREAS).find((k) => k.toLowerCase() === want);
    return key ? EXTRA_AREAS[key] : [];
};

module.exports = { EXTRA_AREAS, extraAreasFor };

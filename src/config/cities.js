/**
 * The towns a vendor can register in, with their state and a starting pincode.
 *
 * Bundled rather than looked up, and that is the whole point of the file.
 *
 * Registration used to ask Google Places for suggestions on every keystroke -
 * a paid call per letter typed, several per field, before anybody had actually
 * signed up. A vendor is always in a town this company works in, and that list
 * is short, changes about once a year, and fits in a few kilobytes. So it
 * ships with the server and the answer is instant, offline and free.
 *
 * The pincode here is the town's head post office, offered as a starting
 * point. A town has many pincodes and this is not a guess at the vendor's own
 * - the form leaves the field editable, and a dropped pin overwrites it with
 * the real one. It exists so that somebody who does not know their pincode off
 * the top of their head is not stopped by the question.
 *
 * Odisha first because that is where the work is. Adding a state is adding
 * rows here; nothing else changes.
 */
const CITIES = [
    // --- Odisha: the coast and the capital region ---
    { city: "Bhubaneswar", state: "Odisha", pincode: "751001" },
    { city: "Cuttack", state: "Odisha", pincode: "753001" },
    { city: "Puri", state: "Odisha", pincode: "752001" },
    { city: "Khordha", state: "Odisha", pincode: "752055" },
    { city: "Jatni", state: "Odisha", pincode: "752050" },
    { city: "Nayagarh", state: "Odisha", pincode: "752069" },
    { city: "Jagatsinghpur", state: "Odisha", pincode: "754103" },
    { city: "Paradip", state: "Odisha", pincode: "754142" },
    { city: "Kendrapara", state: "Odisha", pincode: "754211" },
    { city: "Athagarh", state: "Odisha", pincode: "754029" },

    // --- Odisha: the north ---
    { city: "Balasore", state: "Odisha", pincode: "756001" },
    { city: "Bhadrak", state: "Odisha", pincode: "756100" },
    { city: "Baripada", state: "Odisha", pincode: "757001" },
    { city: "Jajpur", state: "Odisha", pincode: "755001" },
    { city: "Keonjhar", state: "Odisha", pincode: "758001" },
    { city: "Barbil", state: "Odisha", pincode: "758035" },
    { city: "Joda", state: "Odisha", pincode: "758034" },

    // --- Odisha: the west ---
    { city: "Sambalpur", state: "Odisha", pincode: "768001" },
    { city: "Burla", state: "Odisha", pincode: "768017" },
    { city: "Bargarh", state: "Odisha", pincode: "768028" },
    { city: "Jharsuguda", state: "Odisha", pincode: "768201" },
    { city: "Rourkela", state: "Odisha", pincode: "769001" },
    { city: "Sundargarh", state: "Odisha", pincode: "770001" },
    { city: "Deogarh", state: "Odisha", pincode: "768108" },
    { city: "Balangir", state: "Odisha", pincode: "767001" },
    { city: "Titlagarh", state: "Odisha", pincode: "767033" },
    { city: "Sonepur", state: "Odisha", pincode: "767017" },

    // --- Odisha: the centre ---
    { city: "Angul", state: "Odisha", pincode: "759122" },
    { city: "Talcher", state: "Odisha", pincode: "759100" },
    { city: "Dhenkanal", state: "Odisha", pincode: "759001" },
    { city: "Boudh", state: "Odisha", pincode: "762014" },
    { city: "Phulbani", state: "Odisha", pincode: "762001" },

    // --- Odisha: the south ---
    { city: "Berhampur", state: "Odisha", pincode: "760001" },
    { city: "Gopalpur", state: "Odisha", pincode: "761002" },
    { city: "Paralakhemundi", state: "Odisha", pincode: "761200" },
    { city: "Rayagada", state: "Odisha", pincode: "765001" },
    { city: "Jeypore", state: "Odisha", pincode: "764001" },
    { city: "Koraput", state: "Odisha", pincode: "764020" },
    { city: "Sunabeda", state: "Odisha", pincode: "763002" },
    { city: "Nabarangpur", state: "Odisha", pincode: "764059" },
    { city: "Malkangiri", state: "Odisha", pincode: "764045" },
    { city: "Bhawanipatna", state: "Odisha", pincode: "766001" },
    { city: "Nuapada", state: "Odisha", pincode: "766105" },
];

/**
 * Matching that forgives the way people actually type a town.
 *
 * Case is ignored and so is everything that is not a letter, so "Bhubaneswar",
 * "bhubaneswar" and "Bhubaneswar " all find the same row. A match at the start
 * of the name is ranked above a match in the middle, because somebody typing
 * "bar" means Bargarh or Baripada long before they mean Sambalpur.
 */
const fold = (value) => String(value || "").toLowerCase().replace(/[^a-z]/g, "");

const searchCities = (term, limit = 8) => {
    const q = fold(term);
    if (!q) return CITIES.slice(0, limit);

    const starts = [];
    const contains = [];

    for (const row of CITIES) {
        const name = fold(row.city);
        if (name.startsWith(q)) starts.push(row);
        else if (name.includes(q)) contains.push(row);
    }

    return starts.concat(contains).slice(0, limit);
};

/** One town by name, for checking what a form sent back. */
const findCity = (name) => {
    const q = fold(name);
    return CITIES.find((row) => fold(row.city) === q) || null;
};

module.exports = { CITIES, searchCities, findCity };

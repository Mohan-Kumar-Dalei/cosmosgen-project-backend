/**
 * The three languages this company serves, named in one place.
 *
 * They were spelled out as a literal array in nine files - two model enums,
 * the copy table, the catalogue, the assistant's rules, the voice styles, the
 * picker and two validators - which is how the fourth one, whenever it comes,
 * turns into a search-and-replace across the whole backend.
 *
 * The Odia one used to be called `odenglish`, because it was written as Odia
 * mixed into Roman letters. Mohan had that changed - "jo bhi odenglish likha
 * hai usko simple Odia" - so the language is Odia, written in Odia script,
 * and the name says so.
 */
const LANGUAGES = ["english", "hinglish", "odia"];

/**
 * Names that are still written on rows in the database.
 *
 * A rename in code is instant; a rename in a collection is a script somebody
 * has to remember to run. Until `scripts/renameOdenglish.js` has been run on a
 * deployment, every customer who chose Odia still carries the old word, and
 * every one of them would fail validation the moment anything saved their
 * record. So the old name stays understood on the way in, and is translated to
 * the new one before anything uses it.
 */
const LEGACY = { odenglish: "odia" };

/**
 * What the models accept.
 *
 * Wider than LANGUAGES on purpose, and only until the migration has run
 * everywhere. Dropping the legacy entry is safe once no document carries it.
 */
const LANGUAGE_ENUM = [...LANGUAGES, ...Object.keys(LEGACY)];

/**
 * A stored or submitted value, as one of the three we actually serve.
 *
 * Returns null for anything unrecognised rather than guessing, so a caller can
 * tell "they have not chosen" from "they chose Odia" and fall back to English
 * itself. Every table keyed by language should be read through this.
 */
const asLanguage = (value) => {
    if (!value) return null;
    const name = LEGACY[value] || value;
    return LANGUAGES.includes(name) ? name : null;
};

module.exports = { LANGUAGES, LANGUAGE_ENUM, LEGACY, asLanguage };

/**
 * What each kind of map call costs, and what the panel should say about it.
 *
 * READ THIS BEFORE TRUSTING THE FIGURES ON THE PAGE.
 *
 * These are Google's published list prices as they stood when this file was
 * written, in US dollars per thousand calls. They are a starting point, not an
 * invoice: Google restructured its Maps pricing during 2025, rates differ by
 * the exact SKU a request lands in, and every account has its own free
 * allowance and any discount it has negotiated. The only authority on what
 * this actually costs is the Billing → Reports page in the Google Cloud
 * console, filtered by SKU.
 *
 * So the page built on this file is for answering "which call is eating the
 * budget, and roughly how much" - a shape, not a bill. Correct `usd` below
 * against the console once, note the date in `reviewedOn`, and the page starts
 * telling the truth for this account rather than for the list price.
 *
 * `inrPerUsd` is the same kind of thing: a number to keep current, not a live
 * rate. Nothing here calls a currency API - a page that quietly spends money
 * to tell you how much money you are spending would be a poor joke.
 */
const RATES = {
    autocomplete: {
        label: "Place suggestions",
        usd: 2.83,
        what: "Each keystroke while a town or an area is being typed - unless a session token groups the whole search into one charge, which is what this app does.",
    },
    details: {
        label: "Place details",
        usd: 5,
        what: "Looking up the state, pincode and coordinates behind a suggestion somebody picked. One per choice.",
    },
    geocode: {
        label: "Reverse geocode",
        usd: 5,
        what: "Turning a dropped pin into an address. One per press of \"use my location\", and cached to about eleven metres.",
    },
    routes: {
        label: "Route",
        usd: 5,
        what: "The road a vendor takes to a customer, drawn on the tracking screen.",
    },
    matrix: {
        label: "Route matrix",
        usd: 5,
        what: "How far each nearby vendor is from one job. Priced per element, so one dispatch with eight vendors is eight.",
    },
};

/**
 * The map views, which are worth stating because two of the three are what the
 * office was paying for before and is not any more.
 */
const VIEW_RATES = {
    embed: {
        label: "Embed map",
        usd: 0,
        what: "Free, with no cap. Every place the panel only needs to *show* a location uses this - the vendor location modal and the ticket thumbnail.",
    },
    static: {
        label: "Static map",
        usd: 2,
        what: "A picture of a map. Not used here; the free embed does the same job.",
    },
    dynamic: {
        label: "Maps JavaScript SDK",
        usd: 7,
        what: "A live map our own code can draw on. Only the two tracking screens load it, because only they have a marker that moves.",
    },
};

const CONFIG = {
    /** Keep this current by hand. See the note at the top of the file. */
    inrPerUsd: 88,

    /** When the rates above were last checked against the Google console. */
    reviewedOn: "2026-09-15",

    /**
     * Google gives every account some free usage each month, and the shape of
     * it changed in 2025. Rather than guess at it, the page says so and points
     * at the console - a figure invented here would be worse than none.
     */
    freeAllowanceNote:
        "Google includes a monthly free allowance that this page does not model. Check Billing → Reports in the Google Cloud console for what is actually charged.",
};

/** Cost of `n` calls of one kind, in rupees. Unknown kinds cost nothing. */
const rupeesFor = (kind, n) => {
    const rate = RATES[kind];
    if (!rate || !n) return 0;
    return (n / 1000) * rate.usd * CONFIG.inrPerUsd;
};

module.exports = { RATES, VIEW_RATES, CONFIG, rupeesFor };

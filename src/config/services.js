// Single source of truth. The WhatsApp menu, the AI prompt, and technician
// skill matching all read from here.
//
// Every issue carries all three languages. `en` is the canonical one: it is
// what goes onto the ticket, so the office and the technician always read the
// same words whichever language the customer chose. The other two are display
// only.
//
// Keep every string at 24 characters or fewer. WhatsApp truncates list row
// titles at 24, and these rows carry no sub-heading to fall back on, so
// assertLabelLengths below fails the boot rather than letting a menu ship
// with a clipped word in it.

const issue = (key, en, hinglish, odia) => ({ key, en, hinglish, odia });

const SERVICE_CATALOG = [
    {
        key: "AC_APPLIANCE",
        label: "AC & Appliance Repair",
        labelHinglish: "AC aur Appliance Repair",
        labelOdia: "AC ଓ Appliance ମରାମତି",
        // What to call the person on this job. "Technician" everywhere sounds
        // wrong when someone books a house cleaning.
        worker: "technician",
        keywords: ["ac", "appliance", "air condition", "refrigerator", "fridge", "washing machine"],

        // This service covers several machines, so we ask which one before
        // asking what's wrong. Services without this list skip that step.
        appliances: [
            {
                key: "AC",
                label: "Air Conditioner",
                labelHinglish: "Air Conditioner (AC)",
                labelOdia: "Air Conditioner (AC)",
                issues: [
                    issue("NOT_COOLING", "Not cooling properly", "Cooling nahi ho rahi", "ଥଣ୍ଡା ହେଉନାହିଁ"),
                    issue("WATER_LEAK", "Water leaking", "Paani tapak raha hai", "ପାଣି ଝରୁଛି"),
                    issue("NOISE", "Unusual noise", "Awaaz aa rahi hai", "ଶବ୍ଦ ଆସୁଛି"),
                    issue("NOT_STARTING", "Not turning on", "Chalu nahi ho raha", "ଚାଲୁ ହେଉନାହିଁ"),
                    issue("GAS_REFILL", "Gas refill required", "Gas refill karana hai", "Gas refill ଦରକାର"),
                    issue("SERVICING", "Routine servicing", "Servicing karani hai", "Servicing ଦରକାର"),
                ],
            },
            {
                key: "FRIDGE",
                label: "Refrigerator",
                labelHinglish: "Fridge",
                labelOdia: "Fridge",
                issues: [
                    issue("NOT_COOLING", "Not cooling properly", "Cooling nahi ho rahi", "ଥଣ୍ଡା ହେଉନାହିଁ"),
                    issue("NOISE", "Unusual noise", "Awaaz aa rahi hai", "ଶବ୍ଦ ଆସୁଛି"),
                    issue("WATER_INSIDE", "Water collecting", "Paani jama ho raha hai", "ପାଣି ଜମୁଛି"),
                    issue("DOOR_SEAL", "Door seal damaged", "Door seal kharab hai", "Door seal ଖରାପ"),
                    issue("DEAD", "Not working at all", "Bilkul band ho gaya", "ପୁରାପୁରି ବନ୍ଦ"),
                ],
            },
            {
                key: "WASHING_MACHINE",
                label: "Washing Machine",
                labelHinglish: "Washing Machine",
                labelOdia: "Washing Machine",
                issues: [
                    issue("NO_WATER", "Not filling water", "Paani nahi bhar raha", "ପାଣି ଭରୁନାହିଁ"),
                    issue("NO_DRAIN", "Not draining", "Paani nikal nahi raha", "ପାଣି ବାହାରୁନାହିଁ"),
                    issue("NO_SPIN", "Spin not working", "Spin nahi kar raha", "Spin ହେଉନାହିଁ"),
                    issue("NOISE", "Excessive noise", "Bahut awaaz aa rahi hai", "ବହୁତ ଶବ୍ଦ ଆସୁଛି"),
                    issue("NOT_STARTING", "Not starting", "Start nahi ho raha", "Start ହେଉନାହିଁ"),
                ],
            },
            {
                key: "MICROWAVE",
                label: "Microwave / Oven",
                labelHinglish: "Microwave / Oven",
                labelOdia: "Microwave / Oven",
                issues: [
                    issue("NOT_HEATING", "Not heating", "Garam nahi kar raha", "ଗରମ କରୁନାହିଁ"),
                    issue("NOT_STARTING", "Not turning on", "Chalu nahi ho raha", "ଚାଲୁ ହେଉନାହିଁ"),
                    issue("SPARKING", "Sparking inside", "Andar spark ho raha", "ଭିତରେ spark ହେଉଛି"),
                    issue("TURNTABLE", "Turntable not moving", "Plate ghoom nahi rahi", "Plate ଘୂରୁନାହିଁ"),
                ],
            },
            {
                key: "GEYSER",
                label: "Geyser / Water Heater",
                labelHinglish: "Geyser",
                labelOdia: "Geyser",
                issues: [
                    issue("NOT_HEATING", "Water not heating", "Paani garam nahi hota", "ପାଣି ଗରମ ହେଉନାହିଁ"),
                    issue("WATER_LEAK", "Water leaking", "Leak ho raha hai", "ପାଣି ଝରୁଛି"),
                    issue("NOT_STARTING", "Not turning on", "Chalu nahi ho raha", "ଚାଲୁ ହେଉନାହିଁ"),
                    issue("SLOW", "Slow to heat water", "Bahut time le raha hai", "ବହୁତ ସମୟ ନେଉଛି"),
                ],
            },
        ],

        // Shown when a service has no appliance list, and used as a fallback
        issues: [
            issue("AC_NOT_COOLING", "AC not cooling", "AC cooling nahi karta", "AC ଥଣ୍ଡା କରୁନାହିଁ"),
            issue("FRIDGE_NOT_COOLING", "Fridge not cooling", "Fridge cooling nahi", "Fridge ଥଣ୍ଡା କରୁନି"),
            issue("WM_NOT_WORKING", "Washing machine fault", "Washing machine kharab", "Washing machine ଖରାପ"),
            issue("SERVICING", "Routine servicing", "Servicing karani hai", "Servicing ଦରକାର"),
        ],
    },
    {
        key: "ELECTRICAL",
        label: "Electrical Issues",
        labelHinglish: "Bijli ki Problem",
        labelOdia: "ବିଦ୍ୟୁତ ସମସ୍ୟା",
        worker: "electrician",
        keywords: ["electric", "electrical", "wiring", "switch"],
        issues: [
            issue("SWITCHBOARD", "Switchboard fault", "Switch board kharab hai", "Switch board ଖରାପ"),
            issue("FUSE", "Fuse blowing often", "Baar baar fuse udta hai", "ବାରମ୍ବାର fuse ଯାଉଛି"),
            issue("WIRING", "Wiring work needed", "Wiring ka kaam hai", "Wiring କାମ ଦରକାର"),
            issue("FITTING", "Fan or light fitting", "Fan / light lagwana hai", "Fan / light ଲଗାଇବା"),
            issue("INVERTER", "Inverter problem", "Inverter ki problem", "Inverter ସମସ୍ୟା"),
        ],
    },
    {
        key: "PLUMBING",
        label: "Plumbing Services",
        labelHinglish: "Plumbing Kaam",
        labelOdia: "Plumbing କାମ",
        worker: "plumber",
        keywords: ["plumb", "plumbing", "pipe", "tap"],
        issues: [
            issue("TAP_LEAK", "Tap leaking", "Nal se paani leak", "ନଳରୁ ପାଣି ଝରୁଛି"),
            issue("DRAIN_BLOCK", "Drain blocked", "Drain block hai", "Drain ବନ୍ଦ ହୋଇଛି"),
            issue("MOTOR", "Motor not working", "Motor kaam nahi karta", "Motor କାମ କରୁନାହିଁ"),
            issue("NEW_FITTING", "New fitting needed", "Naya fitting lagwana", "ନୂଆ fitting ଦରକାର"),
        ],
    },
    {
        key: "HOME_CLEANING",
        label: "Home Cleaning",
        labelHinglish: "Ghar ki Safai",
        labelOdia: "ଘର ସଫା",
        worker: "cleaner",
        keywords: ["clean", "cleaning", "housekeeping"],
        issues: [
            issue("DEEP_CLEAN", "Full home cleaning", "Poore ghar ki cleaning", "ସାରା ଘର cleaning"),
            issue("KITCHEN", "Kitchen cleaning", "Sirf kitchen cleaning", "କେବଳ kitchen clean"),
            issue("BATHROOM", "Bathroom cleaning", "Sirf bathroom cleaning", "କେବଳ bathroom clean"),
            issue("SOFA", "Sofa or carpet clean", "Sofa / carpet clean", "Sofa / carpet clean"),
        ],
    },
];

const ISSUE_FIELDS = ["en", "hinglish", "odia"];

/** The customer's language names the field; English is the fallback. */

const { asLanguage } = require("./languages");
const issueLabel = (item, language) => {
    if (!item) return "";
    if (typeof item === "string") return item;
    const name = asLanguage(language) || "english";
    return item[name === "english" ? "en" : name] || item.en;
};

/**
 * A service or appliance name in the customer's language.
 *
 * These carry the English word inside the translation wherever that is what
 * people actually say - nobody here asks for a "batanukula jantra", they say
 * AC - so several read the same in all three, on purpose.
 */
const displayLabel = (item, language) => {
    if (!item) return "";
    const name = asLanguage(language);
    if (name === "hinglish") return item.labelHinglish || item.label;
    if (name === "odia") return item.labelOdia || item.label;
    return item.label;
};

/**
 * WhatsApp clips a list row title at 24 characters, and these rows carry no
 * sub-heading underneath to finish the sentence. A clipped label is the kind
 * of thing nobody notices until a customer picks the wrong issue, so fail the
 * boot instead of shipping one.
 */
const assertLabelLengths = () => {
    const tooLong = [];
    const check = (item) => ISSUE_FIELDS.forEach((field) => {
        const value = item[field];
        if (value && value.length > 24) {
            tooLong.push(item.key + "." + field + " (" + value.length + '): "' + value + '"');
        }
    });

    SERVICE_CATALOG.forEach((service) => {
        service.issues?.forEach(check);
        service.appliances?.forEach((appliance) => appliance.issues.forEach(check));
    });

    if (tooLong.length) {
        throw new Error("Issue labels over WhatsApp's 24-char limit:\n  " + tooLong.join("\n  "));
    }
};

assertLabelLengths();

/**
 * Replace the catalogue with what the database now holds.
 *
 * Mutated in place, never reassigned: several modules captured this array when
 * they were first required, and handing back a new one would leave every one
 * of them reading a stale copy for the life of the process.
 *
 * Labels are clipped rather than rejected here. The assertion above exists to
 * stop a developer shipping a clipped WhatsApp row; this path is the office
 * adding a service through a form at two in the afternoon, and refusing their
 * data outright would take the whole catalogue down with it.
 */
const setCatalog = (entries) => {
    const clip = (value) => (typeof value === "string" && value.length > 24 ? value.slice(0, 24).trim() : value);

    const tidy = (item) => ({ ...item, en: clip(item.en), hinglish: clip(item.hinglish), odia: clip(item.odia) });

    SERVICE_CATALOG.length = 0;

    entries.forEach((entry) => SERVICE_CATALOG.push({
        ...entry,
        issues: (entry.issues || []).map(tidy),
        appliances: (entry.appliances || []).map((a) => ({ ...a, issues: (a.issues || []).map(tidy) })),
    }));
};

const getServiceByKey = (key) => SERVICE_CATALOG.find((s) => s.key === key) || null;

const getServiceByLabel = (label) => {
    if (!label) return null;
    const clean = String(label).toLowerCase().trim();
    return SERVICE_CATALOG.find((s) => s.label.toLowerCase() === clean) || null;
};

const getAppliance = (serviceKey, applianceKey) => {
    const service = getServiceByKey(serviceKey);
    if (!service?.appliances) return null;
    return service.appliances.find((a) => a.key === applianceKey) || null;
};

// Escaping matters - state and area come from user input and would
// otherwise be able to break the regex
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Technician skills are free text ("AC & Appliance Repair", "ac repair",
// "Appliance"), so match on keywords rather than exact strings
const buildSkillRegex = (serviceKey) => {
    const service = getServiceByKey(serviceKey);
    if (!service) return null;
    return new RegExp(service.keywords.map(escapeRegex).join("|"), "i");
};

/**
 * A stored issue, as words rather than as a database key.
 *
 * The app picks faults from chips and sends back what it was given, which is
 * the catalogue key - NOT_COOLING, ROUTINE_SERVICE. Those went straight onto
 * the ticket and straight onto the customer's own screen, shouting in capitals
 * with underscores in the middle. WhatsApp never had the problem because that
 * flow stores the label it showed.
 *
 * So the keys are turned back into words here, on the way in, and both
 * channels store the same thing: a phrase in the customer's own language.
 *
 * The key can belong to the service itself or to any appliance under it - the
 * app does not say which, and it does not need to, because a key is unique
 * within a service. Anything not found is passed through with its underscores
 * opened out, which is better than dropping a fault the customer chose.
 */
const issuePhrases = (serviceKey, values, language) => {
    const service = getServiceByKey(serviceKey);

    const pool = [
        ...(service?.issues || []),
        ...(service?.appliances || []).flatMap((a) => a.issues || []),
    ];

    return (Array.isArray(values) ? values : [])
        .map((value) => {
            if (typeof value !== "string") return "";

            const raw = value.trim();
            if (!raw) return "";

            const found = pool.find((i) => i.key === raw);
            if (found) return issueLabel(found, language);

            // Not a key we know. If it reads like one - SHOUTED_WITH_
            // UNDERSCORES - open it out; otherwise it is already a phrase
            // somebody typed and it is left exactly as they wrote it.
            if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(raw)) {
                const words = raw.toLowerCase().split("_").join(" ");
                return words.charAt(0).toUpperCase() + words.slice(1);
            }

            return raw;
        })
        .filter(Boolean);
};

module.exports = {
    SERVICE_CATALOG,
    setCatalog,
    getServiceByKey,
    getServiceByLabel,
    getAppliance,
    issueLabel,
    issuePhrases,
    displayLabel,
    buildSkillRegex,
    escapeRegex,
};

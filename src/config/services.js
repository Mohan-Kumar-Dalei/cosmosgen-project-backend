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

const issue = (key, en, hinglish, odenglish) => ({ key, en, hinglish, odenglish });

const SERVICE_CATALOG = [
    {
        key: "AC_APPLIANCE",
        label: "AC & Appliance Repair",
        labelHinglish: "AC aur Appliance Repair",
        labelOdenglish: "AC o Appliance Marammati",
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
                labelOdenglish: "Air Conditioner (AC)",
                issues: [
                    issue("NOT_COOLING", "Not cooling properly", "Cooling nahi ho rahi", "Thanda heuni"),
                    issue("WATER_LEAK", "Water leaking", "Paani tapak raha hai", "Pani jharuchi"),
                    issue("NOISE", "Unusual noise", "Awaaz aa rahi hai", "Awaj asuchi"),
                    issue("NOT_STARTING", "Not turning on", "Chalu nahi ho raha", "Chalu heuni"),
                    issue("GAS_REFILL", "Gas refill required", "Gas refill karana hai", "Gas refill darkar"),
                    issue("SERVICING", "Routine servicing", "Servicing karani hai", "Servicing darkar"),
                ],
            },
            {
                key: "FRIDGE",
                label: "Refrigerator",
                labelHinglish: "Fridge",
                labelOdenglish: "Fridge",
                issues: [
                    issue("NOT_COOLING", "Not cooling properly", "Cooling nahi ho rahi", "Thanda heuni"),
                    issue("NOISE", "Unusual noise", "Awaaz aa rahi hai", "Awaj asuchi"),
                    issue("WATER_INSIDE", "Water collecting", "Paani jama ho raha hai", "Pani jamuchi"),
                    issue("DOOR_SEAL", "Door seal damaged", "Door seal kharab hai", "Door seal kharap"),
                    issue("DEAD", "Not working at all", "Bilkul band ho gaya", "Puraputi banda"),
                ],
            },
            {
                key: "WASHING_MACHINE",
                label: "Washing Machine",
                labelHinglish: "Washing Machine",
                labelOdenglish: "Washing Machine",
                issues: [
                    issue("NO_WATER", "Not filling water", "Paani nahi bhar raha", "Pani bharuni"),
                    issue("NO_DRAIN", "Not draining", "Paani nikal nahi raha", "Pani baharuni"),
                    issue("NO_SPIN", "Spin not working", "Spin nahi kar raha", "Spin heuni"),
                    issue("NOISE", "Excessive noise", "Bahut awaaz aa rahi hai", "Bahut awaj asuchi"),
                    issue("NOT_STARTING", "Not starting", "Start nahi ho raha", "Start heuni"),
                ],
            },
            {
                key: "MICROWAVE",
                label: "Microwave / Oven",
                labelHinglish: "Microwave / Oven",
                labelOdenglish: "Microwave / Oven",
                issues: [
                    issue("NOT_HEATING", "Not heating", "Garam nahi kar raha", "Garam karuni"),
                    issue("NOT_STARTING", "Not turning on", "Chalu nahi ho raha", "Chalu heuni"),
                    issue("SPARKING", "Sparking inside", "Andar spark ho raha", "Bhitare spark heuchi"),
                    issue("TURNTABLE", "Turntable not moving", "Plate ghoom nahi rahi", "Plate ghuruni"),
                ],
            },
            {
                key: "GEYSER",
                label: "Geyser / Water Heater",
                labelHinglish: "Geyser",
                labelOdenglish: "Geyser",
                issues: [
                    issue("NOT_HEATING", "Water not heating", "Paani garam nahi hota", "Pani garam heuni"),
                    issue("WATER_LEAK", "Water leaking", "Leak ho raha hai", "Pani jharuchi"),
                    issue("NOT_STARTING", "Not turning on", "Chalu nahi ho raha", "Chalu heuni"),
                    issue("SLOW", "Slow to heat water", "Bahut time le raha hai", "Bahut samay neuchi"),
                ],
            },
        ],

        // Shown when a service has no appliance list, and used as a fallback
        issues: [
            issue("AC_NOT_COOLING", "AC not cooling", "AC cooling nahi karta", "AC thanda karuni"),
            issue("FRIDGE_NOT_COOLING", "Fridge not cooling", "Fridge cooling nahi", "Fridge thanda karuni"),
            issue("WM_NOT_WORKING", "Washing machine fault", "Washing machine kharab", "Washing machine kharap"),
            issue("SERVICING", "Routine servicing", "Servicing karani hai", "Servicing darkar"),
        ],
    },
    {
        key: "ELECTRICAL",
        label: "Electrical Issues",
        labelHinglish: "Bijli ki Problem",
        labelOdenglish: "Bijuli Samasya",
        worker: "electrician",
        keywords: ["electric", "electrical", "wiring", "switch"],
        issues: [
            issue("SWITCHBOARD", "Switchboard fault", "Switch board kharab hai", "Switch board kharap"),
            issue("FUSE", "Fuse blowing often", "Baar baar fuse udta hai", "Barambar fuse jauchi"),
            issue("WIRING", "Wiring work needed", "Wiring ka kaam hai", "Wiring kaam darkar"),
            issue("FITTING", "Fan or light fitting", "Fan / light lagwana hai", "Fan / light lagaiba"),
            issue("INVERTER", "Inverter problem", "Inverter ki problem", "Inverter samasya"),
        ],
    },
    {
        key: "PLUMBING",
        label: "Plumbing Services",
        labelHinglish: "Plumbing Kaam",
        labelOdenglish: "Plumbing Kama",
        worker: "plumber",
        keywords: ["plumb", "plumbing", "pipe", "tap"],
        issues: [
            issue("TAP_LEAK", "Tap leaking", "Nal se paani leak", "Nal ru pani jharuchi"),
            issue("DRAIN_BLOCK", "Drain blocked", "Drain block hai", "Drain bandha heichi"),
            issue("MOTOR", "Motor not working", "Motor kaam nahi karta", "Motor kaam karuni"),
            issue("NEW_FITTING", "New fitting needed", "Naya fitting lagwana", "Nua fitting darkar"),
        ],
    },
    {
        key: "HOME_CLEANING",
        label: "Home Cleaning",
        labelHinglish: "Ghar ki Safai",
        labelOdenglish: "Ghara Safa",
        worker: "cleaner",
        keywords: ["clean", "cleaning", "housekeeping"],
        issues: [
            issue("DEEP_CLEAN", "Full home cleaning", "Poore ghar ki cleaning", "Sara ghara cleaning"),
            issue("KITCHEN", "Kitchen cleaning", "Sirf kitchen cleaning", "Kebala kitchen cleaning"),
            issue("BATHROOM", "Bathroom cleaning", "Sirf bathroom cleaning", "Kebala bathroom clean"),
            issue("SOFA", "Sofa or carpet clean", "Sofa / carpet cleaning", "Sofa / carpet cleaning"),
        ],
    },
];

const ISSUE_FIELDS = ["en", "hinglish", "odenglish"];

/** The customer's language names the field; English is the fallback. */
const issueLabel = (item, language) => {
    if (!item) return "";
    if (typeof item === "string") return item;
    return item[language === "english" ? "en" : language] || item.en;
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
    if (language === "hinglish") return item.labelHinglish || item.label;
    if (language === "odenglish") return item.labelOdenglish || item.label;
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

module.exports = {
    SERVICE_CATALOG,
    getServiceByKey,
    getServiceByLabel,
    getAppliance,
    issueLabel,
    displayLabel,
    buildSkillRegex,
    escapeRegex,
};

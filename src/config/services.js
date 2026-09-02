// Single source of truth. The WhatsApp menu, the AI prompt, and technician
// skill matching all read from here.

const SERVICE_CATALOG = [
    {
        key: "AC_APPLIANCE",
        label: "AC & Appliance Repair",
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
                issues: [
                    "Cooling nahi kar raha",
                    "Paani tapak raha hai",
                    "Awaaz aa rahi hai",
                    "On hi nahi ho raha",
                    "Gas refill karwana hai",
                    "Servicing karwani hai",
                ],
            },
            {
                key: "FRIDGE",
                label: "Refrigerator",
                issues: [
                    "Cooling nahi kar raha",
                    "Awaaz aa rahi hai",
                    "Paani jama ho raha hai",
                    "Door seal kharab hai",
                    "Bilkul band ho gaya",
                ],
            },
            {
                key: "WASHING_MACHINE",
                label: "Washing Machine",
                issues: [
                    "Paani nahi bhar raha",
                    "Drain nahi ho raha",
                    "Spin nahi kar raha",
                    "Awaaz bahut aa rahi hai",
                    "Start hi nahi ho raha",
                ],
            },
            {
                key: "MICROWAVE",
                label: "Microwave / Oven",
                issues: [
                    "Garam nahi kar raha",
                    "Chalu nahi ho raha",
                    "Spark ho raha hai",
                    "Plate ghoom nahi rahi",
                ],
            },
            {
                key: "GEYSER",
                label: "Geyser / Water Heater",
                issues: [
                    "Paani garam nahi ho raha",
                    "Leak ho raha hai",
                    "Chalu nahi ho raha",
                    "Bahut time le raha hai",
                ],
            },
        ],

        // Shown when a service has no appliance list, and used as a fallback
        issues: [
            "AC cooling nahi kar raha",
            "Fridge cooling nahi kar raha",
            "Washing machine kaam nahi kar raha",
            "Servicing karwani hai",
        ],
    },
    {
        key: "ELECTRICAL",
        label: "Electrical Issues",
        worker: "electrician",
        keywords: ["electric", "electrical", "wiring", "switch"],
        issues: [
            "Switch board kaam nahi kar raha",
            "Baar baar fuse ud raha hai",
            "Wiring ka kaam hai",
            "Fan / light lagwana hai",
            "Inverter ki problem",
        ],
    },
    {
        key: "PLUMBING",
        label: "Plumbing Services",
        worker: "plumber",
        keywords: ["plumb", "plumbing", "pipe", "tap"],
        issues: [
            "Nal se paani leak ho raha hai",
            "Bathroom drain block hai",
            "Motor kaam nahi kar raha",
            "Naya fitting lagwana hai",
        ],
    },
    {
        key: "HOME_CLEANING",
        label: "Home Cleaning",
        worker: "cleaner",
        keywords: ["clean", "cleaning", "housekeeping"],
        issues: [
            "Full home deep cleaning",
            "Sirf kitchen cleaning",
            "Sirf bathroom cleaning",
            "Sofa / carpet cleaning",
        ],
    },
];

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
    buildSkillRegex,
    escapeRegex,
};
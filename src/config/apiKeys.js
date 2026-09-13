/**
 * Every credential the platform runs on, named and explained.
 *
 * The reason this list exists is that Cosmosgen currently stands on free
 * tiers. That is a perfectly reasonable way to start a company and a terrible
 * thing to be unable to see: when a quota runs out the symptom is never "quota
 * ran out", it is the assistant going quiet, or a photograph failing to save,
 * or a call that never rings - and working backwards from that to which of a
 * dozen keys expired is an afternoon.
 *
 * So the developer platform reads this and shows, for every platform: a title,
 * every credential it is made of - the ids as well as the secrets - whether
 * each is set, the last four characters of each, what stops working without
 * it, and a bar of how much of today's allowance it has eaten.
 *
 * `fields` is that full list and `envVar` is the headline one, the one whose
 * usage is counted. A platform with one key has one field; Exotel has six, and
 * an id missing is as fatal there as a secret missing.
 *
 * Nothing here contains a secret. Each row names an environment variable; the
 * value is read at the moment it is needed and only ever leaves the server
 * masked.
 */
const ENV_KEYS = [
    {
        envVar: "GEMINI_API_KEY",
        fields: [
            { envVar: "GEMINI_API_KEY", label: "API key", kind: "key" },
        ],
        provider: "gemini",
        label: "Gemini",
        powers: "The assistant on WhatsApp and the website, the words spoken on phone calls, drafting a new service, and the memory of past conversations.",
        free: true,
        // Counted through the key ring, so this one has real numbers rather
        // than a yes-or-no
        metered: true,
        note: "The free tier is a few hundred calls a day. Add a second key under the keys above and the platform steps onto it the moment this one runs out.",
    },
    {
        envVar: "SARVAM_API_KEY",
        fields: [
            { envVar: "SARVAM_API_KEY", label: "API subscription key", kind: "key" },
        ],
        provider: "sarvam",
        label: "Sarvam",
        powers: "Turning the customer's speech into text and the assistant's reply back into speech, in Odia and Hindi.",
        free: true,
        note: "Without it, phone calls stop working. WhatsApp and the website are unaffected.",
    },
    {
        envVar: "PINECONE_API_KEY",
        fields: [
            { envVar: "PINECONE_API_KEY", label: "API key", kind: "key" },
        ],
        provider: "pinecone",
        label: "Pinecone",
        powers: "Remembering what a customer has said before, so the assistant does not start from nothing each time.",
        free: true,
    },
    {
        envVar: "IMAGEKIT_PRIVATE_KEY",
        fields: [
            { envVar: "IMAGEKIT_PRIVATE_KEY", label: "Private key", kind: "secret" },
            { envVar: "IMAGEKIT_PUBLIC_KEY", label: "Public key", kind: "id" },
            { envVar: "IMAGEKIT_URL_ENDPOINT", label: "URL endpoint", kind: "url" },
        ],
        provider: "imagekit",
        label: "ImageKit",
        powers: "Storing every picture and resizing it for the page that asks. Uploads from the office's own screens land here.",
        free: true,
        also: ["IMAGEKIT_PUBLIC_KEY", "IMAGEKIT_URL_ENDPOINT"],
    },
    {
        envVar: "GOOGLE_MAPS_API_KEY",
        fields: [
            { envVar: "GOOGLE_MAPS_API_KEY", label: "Server key", kind: "key", where: "This backend calls with it", calls: true },
            { envVar: "GOOGLE_MAPS_ANDROID_KEY", label: "Android app key", kind: "key", where: "The app, recorded here" },
        ],
        provider: "google",
        label: "Google Maps",
        powers: "Turning an address into a point on a map, working out who is nearest, and the distance shown while somebody is on the way.",
        free: false,
        note: "Billed per request after the monthly free allowance. Three separate keys exist for this one account, restricted to different things, and only the server key below is the one this backend calls with - every geocode, every address search and every distance on a job. The website's own key is a browser key and is compiled into the site, not read here. The Android key belongs to the app and is only recorded here so all three sit in one place.",
    },
    {
        envVar: "WHATSAPP_TOKEN",
        fields: [
            { envVar: "WHATSAPP_TOKEN", label: "Permanent access token", kind: "secret" },
            { envVar: "WHATSAPP_PHONE_NUMBER_ID", label: "Phone number ID", kind: "id" },
            { envVar: "WHATSAPP_BUSINESS_ACCOUNT_ID", label: "Business account ID", kind: "id" },
            { envVar: "WHATSAPP_VERIFY_TOKEN", label: "Webhook verify token", kind: "secret" },
            { envVar: "WHATSAPP_APP_SECRET", label: "App secret", kind: "secret" },
        ],
        provider: "meta",
        label: "WhatsApp Cloud API",
        powers: "Every message the company sends or receives - bookings, codes at the door, invoices.",
        free: false,
        also: ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"],
        note: "This is the one nothing else can stand in for. If it lapses, the company stops taking bookings.",
    },
    {
        envVar: "RAZORPAY_KEY_ID",
        fields: [
            { envVar: "RAZORPAY_KEY_ID", label: "Key ID", kind: "id" },
            { envVar: "RAZORPAY_KEY_SECRET", label: "Key secret", kind: "secret" },
            { envVar: "RAZORPAY_WEBHOOK_SECRET", label: "Webhook secret", kind: "secret" },
        ],
        provider: "razorpay",
        label: "Razorpay",
        powers: "Payment links, and the webhook that confirms a customer has paid.",
        free: false,
        also: ["RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
    },
    {
        envVar: "EXOTEL_API_KEY",
        fields: [
            { envVar: "EXOTEL_API_KEY", label: "API key", kind: "key" },
            { envVar: "EXOTEL_API_TOKEN", label: "API token", kind: "secret" },
            { envVar: "EXOTEL_SID", label: "Account SID", kind: "id" },
            { envVar: "EXOTEL_APP_ID", label: "Voicebot app ID", kind: "id" },
            { envVar: "EXOTEL_SUBDOMAIN", label: "Subdomain", kind: "url" },
            { envVar: "EXOTEL_CALLER_ID", label: "Caller ID", kind: "id" },
        ],
        provider: "exotel",
        label: "Exotel",
        powers: "Placing the two calls a job gets - before an engineer is assigned, and after the work is closed.",
        free: false,
        also: ["EXOTEL_API_TOKEN", "EXOTEL_SID", "EXOTEL_APP_ID", "EXOTEL_SUBDOMAIN", "EXOTEL_CALLER_ID"],
    },
];

/**
 * The platform's own secrets, as opposed to somebody else's service.
 *
 * Shown separately and never with a provider's name next to them, because
 * these have no quota, no bill and no dashboard to log into - they are simply
 * either set or the platform will not start.
 */
const ENV_SECRETS = [
    { envVar: "MONGODB_URI", label: "Database", powers: "Everything. Every ticket, customer, vendor and invoice." },
    { envVar: "JWT_SECRET", label: "Customer sessions", powers: "Signs the token that keeps a customer signed in." },
    { envVar: "ADMIN_JWT_SECRET", label: "Staff sessions", powers: "Signs the token behind every office screen, including this one." },
    { envVar: "ADMIN_REGISTRATION_SECRET", label: "Owner security key", powers: "The second factor asked for at the owner's sign-in, and at this platform's." },
];

module.exports = { ENV_KEYS, ENV_SECRETS };

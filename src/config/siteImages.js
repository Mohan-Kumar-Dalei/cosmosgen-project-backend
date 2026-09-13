/**
 * Every picture the customer website shows, and where it loads from by default.
 *
 * This list is the contract between the two halves: the website asks for a
 * slot by name, and the office's screen shows exactly these rows to fill in.
 * A picture that is not here cannot be managed, so anything new the site
 * starts showing is added here first.
 *
 * The defaults are the drawings as commissioned. They stay in the code on
 * purpose - a fresh database, a failed query or a slot nobody has touched all
 * end with the site looking the way it was designed rather than with holes in
 * it.
 */
const IK = "https://ik.imagekit.io/h7wep5nji/cosmosgen/";

const SITE_IMAGES = [
    {
        slot: "LOGO",
        label: "Company mark",
        group: "The company",
        note: "In the header, the footer, the assistant's replies and on the tracking card.",
        url: IK + "cosmosgen-logo.png",
    },
    {
        slot: "HERO_TEAM",
        label: "The team, with their tools",
        group: "Home",
        note: "The opening picture on the home page. Engineers from each trade together.",
        url: IK + "cg-hero-team.png",
    },
    {
        slot: "HERO_VISIT",
        label: "An engineer at a customer's door",
        group: "Home",
        note: "Stands in for the team picture until that one exists, and opens the About page.",
        // The double extension is the name the file was actually uploaded
        // under, and a URL has to match what exists
        url: IK + "cg-hero-visit.png.png",
    },
    {
        slot: "HERO_AC",
        label: "Appliance work",
        group: "Home",
        note: "Beside the section about how a price is set.",
        url: IK + "cg-hero-ac.png",
    },
    {
        slot: "HERO_ELECTRICAL",
        label: "Electrical work",
        group: "Home",
        note: "Beside the assistant, and at the top of the Ask AI page.",
        url: IK + "cg-hero-electrical.png",
    },
    {
        slot: "AT_THE_DOOR",
        label: "Reading the code at the door",
        group: "How it works",
        note: "The picture for the two codes, on How it works and About.",
        url: IK + "cg-at-the-door.png",
    },
    {
        slot: "ON_THE_WAY",
        label: "On the road",
        group: "Work with us",
        note: "Opens the page for engineers who want to join.",
        url: IK + "cg-on-the-way.png",
    },
    {
        slot: "APP_SHOT",
        label: "The app in a hand",
        group: "The app",
        note: "In the dark band about the Android app.",
        url: IK + "cg-app-shot.png",
    },
];

/** Fast lookup by slot, for validating what the office sends. */
const SITE_IMAGE_BY_SLOT = Object.fromEntries(SITE_IMAGES.map((row) => [row.slot, row]));

/**
 * The drawing each service and each machine ships with.
 *
 * These were only in the website's own source, which had one visible
 * consequence: a customer saw a picture on every service tile while the
 * office's own screen showed empty grey squares, because nothing had ever been
 * written to the service's `image` field. The website was falling back and the
 * panel had nothing to fall back to.
 *
 * Now the server holds them, so every reader - the panel, the app, the
 * WhatsApp menu - sees the same picture the website does, whether or not
 * anybody has ever chosen one.
 */
const SERVICE_IMAGE_DEFAULTS = {
    AC_APPLIANCE: IK + "service-appliance.png",
    ELECTRICAL: IK + "service-electrical.png",
    PLUMBING: IK + "service-plumbing.png",
    HOME_CLEANING: IK + "service-cleaning.png",
    // Not sold yet, but a service the office adds should arrive with a picture
    // already waiting rather than an empty tile
    CARPENTRY: IK + "service-carpentry.png",
    PEST_CONTROL: IK + "service-pest.png",
    PAINTING: IK + "service-painting.png",
};

const APPLIANCE_IMAGE_DEFAULTS = {
    AC: IK + "appliance-ac.png",
    FRIDGE: IK + "appliance-fridge.png",
    WASHING_MACHINE: IK + "appliance-washing-machine.png",
    MICROWAVE: IK + "appliance-microwave.png",
    GEYSER: IK + "appliance-geyser.png",
    WATER_PURIFIER: IK + "appliance-water-purifier.png",
};

module.exports = {
    SITE_IMAGES,
    SITE_IMAGE_BY_SLOT,
    SERVICE_IMAGE_DEFAULTS,
    APPLIANCE_IMAGE_DEFAULTS,
};

/**
 * Every line the WhatsApp flow says for itself, in the three languages a
 * customer can pick.
 *
 * Only the assistant's replies come from the model; the menus, prompts and
 * confirmations are written here, so without this file a customer who chose
 * Odia still got English buttons on every screen.
 *
 * The welcome and the location request are deliberately absent: they are sent
 * before the customer has chosen anything, so they stay in English.
 *
 * The button labels and section titles stay English in all three languages:
 * they are controls, not conversation, and a translated button read as a
 * sentence the customer was meant to answer. Everything the flow actually
 * says - questions, confirmations, the issue rows - follows their choice.
 *
 * WhatsApp caps interactive text - list button 20 characters, section title
 * 24 - and assertCopyLengths fails the boot rather than shipping a clipped
 * button.
 */

const { asLanguage } = require("./languages");

const COPY = {
    english: {
        appNeedsLocation: "You have a Cosmosgen account, but no location saved on it." + "\n\n" +
            "Open the app, tap Use my current location while you are standing at the door, and save. " +
            "That pin is how the office finds somebody near you - without it a job cannot be sent anywhere.",
        /*
         * The one thing WhatsApp says to a number it does not know.
         *
         * It asks for nothing - not a name, not a pin. Registration happens
         * once, on the app, and this says why rather than simply refusing: a
         * customer told to install an app walks away, a customer told what it
         * saves them usually does it.
         */
        appOnly: "To book with Cosmosgen you need an account on our app." + "\n\n" +
            "Register there once - that is where you set the address an engineer is sent to, " +
            "so we never have to ask for your location here. Then message me again and we will carry on.",
        welcomeVerified: (name, place) =>
            "Verified: " + name + (place ? " - " + place : "") + "." + "\n\n" +
            "Welcome to Cosmosgen services. If that is not where you want somebody sent, " +
            "change the address in the app.",
        alreadyHaveLocation: "No need for that - we already use the address you saved on the app, and that is where somebody will be sent.",
        languageDone: (name) => "Done. We will chat in " + name + ".",
        welcomeBack: (name) => "Hi" + name + "! Welcome back to Cosmosgen.",
        serviceBody: "What do you need help with today?",
        serviceButton: "Choose service",
        serviceSection: "Our services",
        applianceBody: "Which appliance needs attention?",
        applianceButton: "Choose appliance",
        issueBody: (heading) => heading + " - what's the problem?",
        issueButton: "Choose issue",
        issueSection: "Common issues",
        somethingElse: "Something else",

        // The two taps under the booking question. WhatsApp caps a reply
        // button at 20 characters, which assertCopyLengths below enforces.
        bookYes: "Yes, book it",
        bookNo: "Not now",
        ownWords: "No problem - tell me what's happening in your own words.",
        aiUnavailable: "Sorry, I could not process that just now. Please try again in a moment.",
    },

    hinglish: {
        appNeedsLocation: "Aapka Cosmosgen account hai, par usme location save nahi hai." + "\n\n" +
            "App kholiye, darwaze par khade hokar Use my current location dabaiye aur save kar dijiye. " +
            "Usi pin se office aapke paas wala banda dhoondta hai - uske bina job kahin bheja hi nahi ja sakta.",
        appOnly: "Cosmosgen se booking ke liye aapko hamare app par account banana hoga." + "\n\n" +
            "Ek baar register kar lijiye - wahin wo address set hota hai jahan engineer bheja jayega, " +
            "isliye yahan baar baar location maangni nahi padti. Uske baad yahan message kijiye, hum aage badh jayenge.",
        welcomeVerified: (name, place) =>
            "Verify ho gaya: " + name + (place ? " - " + place : "") + "." + "\n\n" +
            "Cosmosgen services mein aapka swagat hai. Agar wahan nahi bhijwana hai toh app mein address badal lijiye.",
        alreadyHaveLocation: "Iski zaroorat nahi - jo address aapne app mein save kiya hai wahi hum use karte hain, aur wahin bheja jayega.",
        languageDone: (name) => "Theek hai, hum " + name + " mein baat karenge.",
        welcomeBack: (name) => "Hi" + name + "! Cosmosgen mein wapas swagat hai.",
        serviceBody: "Aaj aapko kis cheez mein madad chahiye?",
        serviceButton: "Choose service",
        serviceSection: "Our services",
        applianceBody: "Kis appliance mein problem hai?",
        applianceButton: "Choose appliance",
        issueBody: (heading) => heading + " - kya problem hai?",
        issueButton: "Choose issue",
        issueSection: "Common issues",
        somethingElse: "Something else",

        bookYes: "Haan, book karein",
        bookNo: "Abhi nahi",
        ownWords: "Koi baat nahi - apne shabdon mein bataiye kya ho raha hai.",
        aiUnavailable: "Maaf kijiye, abhi process nahi kar paya. Kripya thodi der baad try karein.",
    },

    /*
     * Odia, in Odia script.
     *
     * This was Odia written in Roman letters, and Mohan could not read his
     * own product: "ye AI kya keh raha hai samajh nahi aa raha hai". He is
     * right - transliterated Odia is a puzzle even to somebody who speaks
     * it, because there is no agreed spelling and the reader has to sound
     * every word out before it means anything.
     *
     * The words that stay in English are the ones people actually say in
     * English - app, booking, location, engineer, service. Translating
     * those is what makes a line read as a translation rather than as
     * somebody speaking.
     */
    odia: {
        appNeedsLocation: "ଆପଣଙ୍କର Cosmosgen account ଅଛି, କିନ୍ତୁ ସେଥିରେ location save ହୋଇନାହିଁ।" + "\n\n" +
            "App ଖୋଲନ୍ତୁ, ଦୁଆର ପାଖରେ ଠିଆ ହୋଇ Use my current location ଦବାନ୍ତୁ ଏବଂ save କରନ୍ତୁ। " +
            "ସେହି pin ରୁ ହିଁ office ଆପଣଙ୍କ ପାଖର ଲୋକ ଖୋଜେ - ତାହା ବିନା କାମ କେଉଁଠିକୁ ପଠାଯାଇ ପାରିବ ନାହିଁ।",
        appOnly: "Cosmosgen ରେ booking କରିବା ପାଇଁ ଆପଣଙ୍କର ଆମ app ରେ account ଦରକାର।" + "\n\n" +
            "ଥରେ ସେଠାରେ register କରନ୍ତୁ - ସେଠାରେ ହିଁ ସେହି ଠିକଣା ଦିଅନ୍ତି ଯେଉଁଠିକୁ engineer ଯିବେ, " +
            "ତେଣୁ ଏଠାରେ ବାରମ୍ବାର location ମାଗିବାକୁ ପଡ଼େ ନାହିଁ। ତାପରେ ଏଠାରେ message କରନ୍ତୁ, ଆମେ ଆଗକୁ ବଢ଼ିବା।",
        welcomeVerified: (name, place) =>
            "Verify ହୋଇଗଲା: " + name + (place ? " - " + place : "") + "।" + "\n\n" +
            "Cosmosgen services କୁ ସ୍ୱାଗତ। ଯଦି ସେଠିକୁ ଲୋକ ପଠାଇବାକୁ ଚାହୁଁନାହାନ୍ତି, app ରେ ଠିକଣା ବଦଳାନ୍ତୁ।",
        alreadyHaveLocation: "ଦରକାର ନାହିଁ - ଆପଣ app ରେ save କରିଥିବା ଠିକଣା ଆମ ପାଖରେ ଅଛି, ସେଠିକୁ ହିଁ ଲୋକ ଯିବେ।",
        languageDone: (name) => "ଠିକ ଅଛି, ଆମେ " + name + " ରେ କଥା ହେବା।",
        welcomeBack: (name) => "ନମସ୍କାର" + name + "! Cosmosgen କୁ ପୁଣି ସ୍ୱାଗତ।",
        serviceBody: "ଆଜି ଆପଣଙ୍କୁ କେଉଁ କାମରେ ସାହାଯ୍ୟ ଦରକାର?",
        serviceButton: "Choose service",
        serviceSection: "Our services",
        applianceBody: "କେଉଁ appliance ରେ ସମସ୍ୟା ହେଉଛି?",
        applianceButton: "Choose appliance",
        issueBody: (heading) => heading + " - କଣ ସମସ୍ୟା ହେଉଛି?",
        issueButton: "Choose issue",
        issueSection: "Common issues",
        somethingElse: "Something else",

        bookYes: "ହଁ, book କରନ୍ତୁ",
        bookNo: "ଏବେ ନୁହେଁ",
        ownWords: "ଠିକ ଅଛି - ନିଜ ଭାଷାରେ କୁହନ୍ତୁ କଣ ହେଉଛି।",
        aiUnavailable: "ଦୁଃଖିତ, ଏବେ process କରି ପାରିଲି ନାହିଁ। ଟିକେ ପରେ ଆଉ ଥରେ ଚେଷ୍ଟା କରନ୍ତୁ।",
    },
};

/**
 * English until somebody chooses otherwise.
 *
 * This used to fall back to Odenglish on the grounds that Odia is the house
 * language. It is - but a fallback is not a choice, and the first message a
 * stranger ever gets from this company was going out in transliterated Odia
 * they had never asked for. Mohan's word for it was "bakwas", and he is right:
 * Roman-script Odia is unreadable to somebody not expecting it, and it is the
 * one message that has to land.
 *
 * So the order is English first, then the language question, then everything
 * after that in whatever they picked.
 */
const copyFor = (language) => COPY[asLanguage(language)] || COPY.english;

const assertCopyLengths = () => {
    const tooLong = [];
    const limits = {
        serviceButton: 20, applianceButton: 20, issueButton: 20,
        serviceSection: 24, issueSection: 24,

        // Reply buttons are capped tighter than list buttons by WhatsApp.
        bookYes: 20, bookNo: 20,
    };

    Object.entries(COPY).forEach(([language, strings]) => {
        Object.entries(limits).forEach(([field, max]) => {
            const value = strings[field];
            if (value.length > max) {
                tooLong.push(language + "." + field + " (" + value.length + "/" + max + '): "' + value + '"');
            }
        });
    });

    if (tooLong.length) {
        throw new Error("WhatsApp interactive text over the limit:\n  " + tooLong.join("\n  "));
    }
};

assertCopyLengths();

module.exports = { COPY, copyFor };

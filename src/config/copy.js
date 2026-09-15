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
        ownWords: "Koi baat nahi - apne shabdon mein bataiye kya ho raha hai.",
        aiUnavailable: "Maaf kijiye, abhi process nahi kar paya. Kripya thodi der baad try karein.",
    },

    odenglish: {
        appNeedsLocation: "Apananka Cosmosgen account achhi, kintu sethire location save heini." + "\n\n" +
            "App kholantu, duara pakhare thai Use my current location tipantu ebang save karantu. " +
            "Sei pin dwara hin office apananka pakhara loka khoje - taha bina kaam kouthiku pathajai paribani.",
        appOnly: "Cosmosgen re booking pain apananka ama app re account darkar." + "\n\n" +
            "Thare register kari nianTu - sethire sei thikana set heba jouthiku engineer pathajiba, " +
            "tenu ethire barambara location puchhiba darkar pade nahin. Tarapare ethire message karantu, ame agaku jiba.",
        welcomeVerified: (name, place) =>
            "Verify heigala: " + name + (place ? " - " + place : "") + "." + "\n\n" +
            "Cosmosgen services ku swagata. Jadi sethire pathaibaku chahuni, app re thikana badalantu.",
        alreadyHaveLocation: "Darkar nahin - apana app re save karithiba thikana ame byabahara karu, ebang sethiku hin kehi jibe.",
        languageDone: (name) => "Thik achhi, ame " + name + " re katha heba.",
        welcomeBack: (name) => "Namaskar" + name + "! Cosmosgen ku punarbara swagata.",
        serviceBody: "Aji apananka kou bisayare sahajya darkar?",
        serviceButton: "Choose service",
        serviceSection: "Our services",
        applianceBody: "Kou appliance re samasya hauchi?",
        applianceButton: "Choose appliance",
        issueBody: (heading) => heading + " - kana samasya hauchi?",
        issueButton: "Choose issue",
        issueSection: "Common issues",
        somethingElse: "Something else",
        ownWords: "Thik achhi - nija bhasare kuhantu kana hauchi.",
        aiUnavailable: "Kshama karibe, ebe process kari parili nahin. Dayakari kichhi samay pare cheshta karantu.",
    },
};

/** Odia is the house language, so an unset record falls back to it. */
const copyFor = (language) => COPY[language] || COPY.odenglish;

const assertCopyLengths = () => {
    const tooLong = [];
    const limits = { serviceButton: 20, applianceButton: 20, issueButton: 20, serviceSection: 24, issueSection: 24 };

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

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
        languageDone: (name) => "Done. We will chat in " + name + ".",
        askName: "Now type your full name. (For example: Vicky Sahoo)",
        nameRetry: "Sorry, I didn't catch that. Please type your name in letters - for example, Vicky Sahoo.",
        namePlease: "Please type your full name to carry on.",
        thanksName: (first) => "Thanks, " + first + ".",
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
        languageDone: (name) => "Theek hai, hum " + name + " mein baat karenge.",
        askName: "Ab apna poora naam likh kar bhejein. (Jaise: Vicky Sahoo)",
        nameRetry: "Maaf kijiye, samajh nahi aaya. Kripya naam akshron mein likhein - jaise Vicky Sahoo.",
        namePlease: "Aage badhne ke liye apna poora naam likhein.",
        thanksName: (first) => "Shukriya, " + first + ".",
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
        languageDone: (name) => "Thik achhi, ame " + name + " re katha heba.",
        askName: "Ebe apananka pura nama lekhi pathantu.",
        nameRetry: "Kshama karibe, mun bujhi parili nahin. Dayakari akhyara re nama lekhantu - jemiti Vicky Sahoo.",
        namePlease: "Agaku jibaku apananka pura nama lekhantu.",
        thanksName: (first) => "Dhanyabad, " + first + ".",
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

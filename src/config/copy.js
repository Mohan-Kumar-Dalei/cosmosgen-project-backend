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

        // The list of their own saved addresses, offered when a job could go
        // to more than one of them. A list button is capped at 20 characters.
        addressButton: "Choose address",
        addressSection: "Your addresses",

        /*
         * The handful of messages the office sends rather than the assistant.
         *
         * They were written in English and sent in English to everybody, which
         * on an Odia thread reads as a different company talking. The
         * assistant has spoken their language since the first message; these
         * are the only lines that did not, and they are the ones that matter
         * most - a code at the door and a bill.
         */
        ticketCancelled: (number, reason) =>
            "Your service request has been cancelled.\n\n" +
            "Ticket: " + number + "\n" +
            "Reason: " + reason + "\n\n" +
            "Send us a message anytime if you'd like to book again.",

        otpStart: (code, number) =>
            "*" + code + "* is your code to let the technician start.\n\n" +
            "Ticket: " + number + "\n\n" +
            "Share it with them when they are at your door.",

        otpClose: (code, number) =>
            "*" + code + "* is your code to confirm the work is finished.\n\n" +
            "Ticket: " + number + "\n\n" +
            "Share it only once you are happy the job is done.",

        rescheduled: (number, date, who, phone) =>
            "Your service visit has been moved.\n\n" +
            "Ticket: " + number + "\n" +
            "New date: " + date + "\n" +
            "Technician: " + who + " (" + phone + ")\n\n" +
            "Reply to this message if the new time doesn't work for you.",

        visitChargeBill: (invoice, number, total) =>
            "*VISIT CHARGE " + invoice + "*\n" +
            "Ticket: " + number + "\n\n" +
            "Our technician came out and checked the problem. As you have decided not " +
            "to go ahead, only the visit charge applies.\n\n" +
            "*Total: Rs " + total + "*\n\n" +
            "Please pay this in cash to the technician.",

        visitChargePaid: (total, invoice, number) =>
            "Visit charge received. Rs " + total + "\n" +
            "Invoice: " + invoice + "\n\n" +
            "Thank you for your time. Ticket " + number + " is now closed. " +
            "Message us any time if you change your mind.",

        paymentDone: (total, invoice, number, split) =>
            "Payment received. Rs " + total + "\n" +
            (split ? split + "\n" : "") +
            "Invoice: " + invoice + "\n\n" +
            "Thank you for choosing Cosmosgen. Ticket " + number + " is now closed.",

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

        addressButton: "Address chunein",
        addressSection: "Aapke addresses",

        ticketCancelled: (number, reason) =>
            "Aapki service request cancel kar di gayi hai.\n\n" +
            "Ticket: " + number + "\n" +
            "Wajah: " + reason + "\n\n" +
            "Dobara book karna ho to bas message kar dijiye.",

        otpStart: (code, number) =>
            "*" + code + "* aapka code hai, jisse technician kaam shuru karega.\n\n" +
            "Ticket: " + number + "\n\n" +
            "Jab wo darwaze par ho, tabhi ye code batayein.",

        otpClose: (code, number) =>
            "*" + code + "* aapka code hai, kaam pura hone ki confirmation ke liye.\n\n" +
            "Ticket: " + number + "\n\n" +
            "Ye tabhi batayein jab aap kaam se santusht hon.",

        rescheduled: (number, date, who, phone) =>
            "Aapki service visit aage badha di gayi hai.\n\n" +
            "Ticket: " + number + "\n" +
            "Nayi date: " + date + "\n" +
            "Technician: " + who + " (" + phone + ")\n\n" +
            "Naya time theek na ho to is message ka reply kar dijiye.",

        visitChargeBill: (invoice, number, total) =>
            "*VISIT CHARGE " + invoice + "*\n" +
            "Ticket: " + number + "\n\n" +
            "Hamara technician aakar problem dekh chuka hai. Aapne kaam aage na " +
            "karwane ka faisla kiya hai, isliye sirf visit charge lagega.\n\n" +
            "*Total: Rs " + total + "*\n\n" +
            "Ye technician ko cash mein de dijiye.",

        visitChargePaid: (total, invoice, number) =>
            "Visit charge mil gaya. Rs " + total + "\n" +
            "Invoice: " + invoice + "\n\n" +
            "Aapke waqt ke liye shukriya. Ticket " + number + " ab band ho gaya hai. " +
            "Mann badle to kabhi bhi message kar dijiye.",

        paymentDone: (total, invoice, number, split) =>
            "Payment mil gaya. Rs " + total + "\n" +
            (split ? split + "\n" : "") +
            "Invoice: " + invoice + "\n\n" +
            "Cosmosgen chunne ke liye shukriya. Ticket " + number + " ab band ho gaya hai.",

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
    /*
     * Odia, written the way somebody is spoken to here - not translated at
     * them.
     *
     * Mohan read this block back and the word he used was "unrespected". Two
     * things were wrong with it. Odia carries respect in its grammar: the
     * customer is ଆପଣ, an instruction ends in -ନ୍ତୁ, and anything said about
     * them or about our own engineer takes the honorific - ଆସିବେ, not ଆସିବ.
     * And our technician was ଲୋକ, which is "a man"; he is ଆମ technician.
     *
     * The other half was plain awkwardness. "ଯଦି ସେଠିକୁ ଲୋକ ପଠାଇବାକୁ
     * ଚାହୁଁନାହାନ୍ତି" is a sentence nobody speaks. What a customer needs to be
     * told is where we are sending somebody, and how to change it - said
     * once, warmly, in that order.
     *
     * Every line below is addressed to ଆପଣ, asks with ଦୟାକରି and apologises
     * with କ୍ଷମା କରିବେ. LANGUAGE_RULES.odia in ai.service.js holds the
     * assistant to the same register, so the menus and the conversation do
     * not read as two different companies.
     */
    odia: {
        appNeedsLocation: "ଆଜ୍ଞା, ଆପଣଙ୍କର Cosmosgen account ଅଛି, କିନ୍ତୁ ସେଥିରେ ଠିକଣା save ହୋଇନାହିଁ।" + "\n\n" +
            "ଦୟାକରି app ଖୋଲନ୍ତୁ, ଦୁଆର ପାଖରେ ଠିଆ ହୋଇ Use my current location ଦବାନ୍ତୁ ଏବଂ save କରନ୍ତୁ। " +
            "ସେହି ଠିକଣାରୁ ହିଁ ଆମ office ଆପଣଙ୍କ ପାଖରେ ଥିବା technician ଖୋଜନ୍ତି - ତାହା ବିନା ଆମେ କାହାକୁ ପଠାଇ ପାରିବୁ ନାହିଁ।",
        appOnly: "ନମସ୍କାର। Cosmosgen ରେ booking କରିବା ପାଇଁ ଆପଣଙ୍କର ଆମ app ରେ ଗୋଟିଏ account ଦରକାର।" + "\n\n" +
            "ଦୟାକରି ଥରେ ସେଠାରେ register କରିନିଅନ୍ତୁ। ସେଠାରେ ଆପଣ ଯେଉଁ ଠିକଣା ଦେବେ, ଆମ technician ସେଇଠିକୁ ଆସିବେ - " +
            "ତେଣୁ ଏଠାରେ ଆପଣଙ୍କୁ ବାରମ୍ବାର location ଦେବାକୁ ପଡ଼ିବ ନାହିଁ। ତାପରେ ଏଠାରେ ଟିକେ message କରନ୍ତୁ, ଆମେ ଆଗକୁ ବଢ଼ିବା।",
        welcomeVerified: (name, place) =>
            "ନମସ୍କାର " + name + "! ଆପଣଙ୍କ ବିବରଣୀ verify ହୋଇଗଲା।" + "\n\n" +
            "Cosmosgen Services କୁ ଆପଣଙ୍କୁ ସ୍ୱାଗତ।" +
            (place ? " ଆମ technician " + place + " ରେ ଥିବା ଆପଣଙ୍କ ଠିକଣାକୁ ଆସିବେ।" : " ଆପଣ app ରେ save କରିଥିବା ଠିକଣାକୁ ଆମ technician ଆସିବେ।") +
            " ଅନ୍ୟ ଠିକଣାକୁ ଡାକିବାକୁ ଚାହିଁଲେ ଦୟାକରି app ରେ ଠିକଣା ବଦଳାଇଦିଅନ୍ତୁ।",
        alreadyHaveLocation: "ଆଜ୍ଞା, ଏହାର ଆବଶ୍ୟକତା ନାହିଁ। ଆପଣ app ରେ ଯେଉଁ ଠିକଣା save କରିଛନ୍ତି ତାହା ଆମ ପାଖରେ ଅଛି, ଆମ technician ସେଇଠିକୁ ହିଁ ଆସିବେ। ବଦଳାଇବାକୁ ଚାହିଁଲେ ଦୟାକରି app ରେ ବଦଳାଇଦିଅନ୍ତୁ।",
        languageDone: (name) => "ଠିକ ଅଛି ଆଜ୍ଞା। ଆମେ ଏବେଠାରୁ " + name + " ରେ କଥା ହେବା।",
        welcomeBack: (name) => "ନମସ୍କାର" + name + "! Cosmosgen କୁ ପୁଣିଥରେ ସ୍ୱାଗତ।",
        serviceBody: "ଆଜି ଆପଣଙ୍କୁ କେଉଁ କାମରେ ସାହାଯ୍ୟ ଦରକାର ଆଜ୍ଞା?",
        serviceButton: "Choose service",
        serviceSection: "Our services",
        applianceBody: "ଆପଣଙ୍କ କେଉଁ appliance ରେ ସମସ୍ୟା ହେଉଛି?",
        applianceButton: "Choose appliance",
        issueBody: (heading) => heading + " ରେ କଣ ସମସ୍ୟା ହେଉଛି ଆଜ୍ଞା?",
        issueButton: "Choose issue",
        issueSection: "Common issues",
        somethingElse: "Something else",

        addressButton: "Address ବାଛନ୍ତୁ",
        addressSection: "ଆପଣଙ୍କ address",

        ticketCancelled: (number, reason) =>
            "ଆପଣଙ୍କ service request ଟି cancel ହୋଇଯାଇଛି।\n\n" +
            "Ticket: " + number + "\n" +
            "କାରଣ: " + reason + "\n\n" +
            "ପୁଣି book କରିବାକୁ ଚାହିଁଲେ ଆମକୁ message କରନ୍ତୁ।",

        otpStart: (code, number) =>
            "*" + code + "* ହେଉଛି ଆପଣଙ୍କ code, ଯାହା ଦେଲେ technician କାମ ଆରମ୍ଭ କରିବେ।\n\n" +
            "Ticket: " + number + "\n\n" +
            "ସେ ଆପଣଙ୍କ ଦ୍ୱାରରେ ପହଞ୍ଚିଲା ପରେ ହିଁ ଏହା ଦିଅନ୍ତୁ।",

        otpClose: (code, number) =>
            "*" + code + "* ହେଉଛି କାମ ସରିଛି ବୋଲି ନିଶ୍ଚିତ କରିବାର code।\n\n" +
            "Ticket: " + number + "\n\n" +
            "କାମରେ ସନ୍ତୁଷ୍ଟ ହେଲା ପରେ ହିଁ ଏହା ଦିଅନ୍ତୁ।",

        rescheduled: (number, date, who, phone) =>
            "ଆପଣଙ୍କ service visit ଟି ଆଗକୁ ବଢ଼ାଯାଇଛି।\n\n" +
            "Ticket: " + number + "\n" +
            "ନୂଆ ତାରିଖ: " + date + "\n" +
            "Technician: " + who + " (" + phone + ")\n\n" +
            "ନୂଆ ସମୟ ଠିକ୍ ନ ହେଲେ ଏହି message ର reply କରନ୍ତୁ।",

        visitChargeBill: (invoice, number, total) =>
            "*VISIT CHARGE " + invoice + "*\n" +
            "Ticket: " + number + "\n\n" +
            "ଆମର technician ଆସି ସମସ୍ୟା ଦେଖିସାରିଛନ୍ତି। ଆପଣ କାମ ଆଗକୁ ନ କରାଇବାକୁ ସ୍ଥିର " +
            "କରିଥିବାରୁ କେବଳ visit charge ଲାଗିବ।\n\n" +
            "*Total: Rs " + total + "*\n\n" +
            "ଏହା technician ଙ୍କୁ cash ରେ ଦେଇଦିଅନ୍ତୁ।",

        visitChargePaid: (total, invoice, number) =>
            "Visit charge ମିଳିଗଲା। Rs " + total + "\n" +
            "Invoice: " + invoice + "\n\n" +
            "ଆପଣଙ୍କ ସମୟ ପାଇଁ ଧନ୍ୟବାଦ। Ticket " + number + " ବନ୍ଦ ହୋଇଗଲା। " +
            "ମନ ବଦଳିଲେ ଯେକୌଣସି ସମୟରେ message କରନ୍ତୁ।",

        paymentDone: (total, invoice, number, split) =>
            "Payment ମିଳିଗଲା। Rs " + total + "\n" +
            (split ? split + "\n" : "") +
            "Invoice: " + invoice + "\n\n" +
            "Cosmosgen ବାଛିଥିବାରୁ ଧନ୍ୟବାଦ। Ticket " + number + " ବନ୍ଦ ହୋଇଗଲା।",

        bookYes: "ହଁ, book କରନ୍ତୁ",
        bookNo: "ଏବେ ନୁହେଁ",

        ownWords: "ଠିକ ଅଛି ଆଜ୍ଞା - ଦୟାକରି ନିଜ ଭାଷାରେ କୁହନ୍ତୁ କଣ ହେଉଛି।",
        aiUnavailable: "କ୍ଷମା କରିବେ, ଏବେ ମୁଁ ଏହା process କରିପାରିଲି ନାହିଁ। ଦୟାକରି ଟିକେ ପରେ ଆଉ ଥରେ ଚେଷ୍ଟା କରନ୍ତୁ।",
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
        addressButton: 20, addressSection: 24,

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

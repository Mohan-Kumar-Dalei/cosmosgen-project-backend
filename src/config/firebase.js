const { initializeApp, getApps, getApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const isConfigured = () =>
    Boolean(
        process.env.FIREBASE_PROJECT_ID &&
        process.env.FIREBASE_CLIENT_EMAIL &&
        process.env.FIREBASE_PRIVATE_KEY
    );

const getFirebaseApp = () => {
    if (!isConfigured()) {
        throw new Error("Firebase credentials missing in .env");
    }

    // Avoid re-initializing on hot-reload
    if (getApps().length > 0) return getApp();

    return initializeApp({
        credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            // The key is stored with literal \n sequences in .env
            // They must be converted back to real newlines
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
    });
};

/**
 * Returns the phone number Firebase itself verified, or null.
 *
 * The client sends an ID token, never a "verified" flag - a flag can be
 * typed into a curl command, a signed token cannot.
 */
const verifyPhoneToken = async (idToken) => {
    if (!idToken) return null;

    try {
        const app = getFirebaseApp();
        const decoded = await getAuth(app).verifyIdToken(idToken);

        if (!decoded.phone_number) {
            console.warn("Firebase token has no phone_number claim");
            return null;
        }

        // Firebase returns E.164 (+919876543210). The rest of the system
        // stores plain 10-digit Indian numbers.
        const digits = String(decoded.phone_number).replace(/\D/g, "");
        const local = digits.length > 10 ? digits.slice(-10) : digits;

        return { phone: local, uid: decoded.uid };
    } catch (error) {
        console.error("Firebase token verification failed:", error.message);
        return null;
    }
};

module.exports = { isConfigured, verifyPhoneToken };
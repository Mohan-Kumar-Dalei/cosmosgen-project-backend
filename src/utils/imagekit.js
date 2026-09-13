const imagekit = require('imagekit');
const keyring = require("../services/keyring.service");

/**
 * Built on first use, not when this file is loaded.
 *
 * The client used to be constructed at import time, and its constructor
 * throws the moment a key is missing - so a server started without the
 * ImageKit variables did not fail to upload a picture, it failed to start at
 * all, with "Missing publicKey during ImageKit initialization" as the only
 * clue. On a laptop that is a puzzle; on a fresh box it is an hour, because
 * the message names a library nobody was thinking about.
 *
 * Deferred, a missing key costs exactly what it should: pictures do not
 * upload, and everything else - bookings, calls, payments - carries on.
 */
let client = null;

const Imagekit = () => {
    if (client) return client;

    const publicKey = process.env.IMAGEKIT_PUBLIC_KEY;
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;

    if (!publicKey || !privateKey || !urlEndpoint) {
        throw new Error(
            "ImageKit is not configured. Set IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY and IMAGEKIT_URL_ENDPOINT."
        );
    }

    client = new imagekit({ publicKey, privateKey, urlEndpoint });
    return client;
};

// The folder is a parameter with the old value as its default, so every
// existing caller keeps writing where it always did while the catalogue can
// keep its pictures somewhere of its own.
const uploadImage = async (fileBuffer, fileName, folder = 'TechnicianProfiles') => {
    keyring.count("imagekit");

    const response = await Imagekit().upload({
        file: fileBuffer.toString('base64'), // Convert buffer to base64 for ImageKit
        fileName: fileName,
        folder,
    });
    return response;
}

module.exports = uploadImage;
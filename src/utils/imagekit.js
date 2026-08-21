const imagekit = require('imagekit');

const Imagekit = new imagekit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

const uploadImage = async (fileBuffer, fileName) => {
    const response = await Imagekit.upload({
        file: fileBuffer.toString('base64'), // Convert buffer to base64 for ImageKit
        fileName: fileName,
        folder: 'TechnicianProfiles' 
    });
    return response;
}

module.exports = uploadImage;
const multer = require("multer");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 3 * 1024 * 1024, // 3 MB - memoryStorage hai, RAM bachana zaroori hai
        files: 1,
    },
    fileFilter: (req, file, cb) => {
        const allowed = ["image/jpeg", "image/png", "image/webp"];
        if (!allowed.includes(file.mimetype)) {
            return cb(new Error("Only JPEG, PNG or WebP images are allowed"));
        }
        cb(null, true);
    },
});

module.exports = upload;
const multer = require('multer');

// Store file in memory to easily pass the buffer to ImageKit
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

module.exports = upload;
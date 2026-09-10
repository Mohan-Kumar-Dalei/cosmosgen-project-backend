const express = require("express");
const trackController = require("../controllers/track.controller");

const router = express.Router();

// Public. The token in the path is the credential - see track.controller.
router.get("/:token", trackController.getTracking);

module.exports = router;

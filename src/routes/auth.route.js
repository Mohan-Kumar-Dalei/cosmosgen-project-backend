const express = require("express");
const router = express.Router();

const { registerUser, getUserDetails, logoutUser } = require("../controllers/auth.controller");
const { isAuthenticated } = require("../middlewares/auth.middleware");


router.post("/register", registerUser);
router.get("/user", isAuthenticated, getUserDetails);
router.post("/logout", logoutUser);


module.exports = router;
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const adminModel = require("../models/admin.model");

const run = async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    const email = "admin@cosmosgen.com";
    const plainPassword = "Admin@12345"; // Login ke baad turant badalna

    const exists = await adminModel.findOne({ email });
    if (exists) {
        console.log("Admin already exists:", email);
        return process.exit(0);
    }

    await adminModel.create({
        name: "Backoffice Admin",
        email,
        password: await bcrypt.hash(plainPassword, 10),
        role: "superadmin",
    });

    console.log("Admin created!");
    console.log("Email:", email);
    console.log("Password:", plainPassword);
    process.exit(0);
};

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
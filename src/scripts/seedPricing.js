require("dotenv").config();
const mongoose = require("mongoose");
const ServicePricing = require("../src/models/servicePricing.model");

// Saare price PAISE mein. 350 rupees = 35000
const PRICING = [
    // AC & Appliance
    { serviceKey: "AC_APPLIANCE", code: "AC_LABOUR", name: "Service Charge", type: "labour", pricePaise: 35000, isDefault: true },
    { serviceKey: "AC_APPLIANCE", code: "AC_GAS", name: "Gas Refill", type: "gas", pricePaise: 150000 },
    { serviceKey: "AC_APPLIANCE", code: "AC_CAPACITOR", name: "Capacitor", type: "part", pricePaise: 45000 },
    { serviceKey: "AC_APPLIANCE", code: "AC_PCB", name: "PCB Board", type: "part", pricePaise: 220000 },
    { serviceKey: "AC_APPLIANCE", code: "AC_FAN_MOTOR", name: "Fan Motor", type: "part", pricePaise: 180000 },
    { serviceKey: "AC_APPLIANCE", code: "AC_FILTER", name: "Air Filter", type: "part", pricePaise: 30000 },

    // Electrical
    { serviceKey: "ELECTRICAL", code: "EL_LABOUR", name: "Service Charge", type: "labour", pricePaise: 30000, isDefault: true },
    { serviceKey: "ELECTRICAL", code: "EL_SWITCH", name: "Switch / Socket", type: "part", pricePaise: 15000 },
    { serviceKey: "ELECTRICAL", code: "EL_MCB", name: "MCB", type: "part", pricePaise: 45000 },
    { serviceKey: "ELECTRICAL", code: "EL_WIRE", name: "Wiring (per meter)", type: "part", pricePaise: 3500 },

    // Plumbing
    { serviceKey: "PLUMBING", code: "PL_LABOUR", name: "Service Charge", type: "labour", pricePaise: 30000, isDefault: true },
    { serviceKey: "PLUMBING", code: "PL_TAP", name: "Tap / Faucet", type: "part", pricePaise: 55000 },
    { serviceKey: "PLUMBING", code: "PL_PIPE", name: "Pipe (per meter)", type: "part", pricePaise: 12000 },

    // Home Cleaning
    { serviceKey: "HOME_CLEANING", code: "HC_LABOUR", name: "Cleaning Charge", type: "labour", pricePaise: 80000, isDefault: true },
    { serviceKey: "HOME_CLEANING", code: "HC_SOFA", name: "Sofa Cleaning", type: "part", pricePaise: 60000 },
];

const run = async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    for (const item of PRICING) {
        // upsert - dobara chalane par duplicate nahi banega, price update ho jayega
        await ServicePricing.findOneAndUpdate(
            { code: item.code },
            { $set: item },
            { upsert: true, new: true }
        );
        console.log(`${item.code} - Rs ${item.pricePaise / 100}`);
    }

    console.log(`\n${PRICING.length} pricing items seeded.`);
    process.exit(0);
};

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
const mongoose = require("mongoose");
const connectDB = async()=>{
    try{
        await mongoose.connect(process.env.MONGODB_URI)
        .then(()=>{
            console.log("MongoDB connected successfully");
        })
        .catch((err)=>{
            console.log(err.message);
        })
    }
    catch(err){
        console.log(err.message);
    }
}

module.exports = connectDB;
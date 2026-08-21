const express = require('express');
const app = express();
const authRoutes = require('./routes/auth.route');
const technicianRoutes = require('./routes/technician.routes');
const mapRoutes = require('./routes/map.routes');
const cookieParser = require('cookie-parser');
const cors = require('cors');
//middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"], 
    methods: ["GET", "POST","PUT", "DELETE","PATCH","UPDATE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));


//routes
app.use('*',(req,res)=>{
    res.send(200).json({
        "message":"server is working fine"
    })
})
app.use('/api/auth', authRoutes);
app.use('/api/technician', technicianRoutes);
app.use('/api/map', mapRoutes);






module.exports = app;
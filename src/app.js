const express = require('express');
const app = express();
const authRoutes = require('./routes/auth.route');
const technicianRoutes = require('./routes/technician.routes');
const mapRoutes = require('./routes/map.routes');
const cookieParser = require('cookie-parser');
const cors = require('cors');

// middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173", "https://cosmosgen-frontend.netlify.app"], 
    methods: ["GET", "POST","PUT", "DELETE","PATCH","UPDATE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));

// 1. Health check Route (Base URL ke liye)
app.get('/', (req, res) => {
    res.status(200).json({
        message: "Server is working fine"
    });
});

// 2. Main API routes
app.use('/api/auth', authRoutes);
app.use('/api/technician', technicianRoutes);
app.use('/api/map', mapRoutes);

// 3. Catch-all Route
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "Route not found"
    });
});

module.exports = app;
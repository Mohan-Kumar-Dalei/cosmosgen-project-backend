require("dotenv").config();
//express
const app = require("./src/app");
const port = process.env.PORT || 3000;
//db
const connectDB = require("./src/config/db");
//socket server
const {createServer} = require('http');
const { Server } = require('socket.io');
const initSocketServer = require("./src/sockets/socketManager");
const httpServer = createServer(app);
initSocketServer(httpServer);
connectDB();











httpServer.listen(port,()=>{
    console.log(`Server is running on port ${port}`);
    console.log(`socket.io is running on port ${port}`);

})


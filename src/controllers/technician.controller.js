const technicianModel = require('../models/technician.model');
const ticketModel = require('../models/ticket.model');
const uploadImage = require('../utils/imagekit');
const socketManager = require('../sockets/socketManager');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');





const registerTechnician = async (req, res) => {
    try {
        const { name, phone, password, pincode,state, skills, hasVehicle, area } = req.body;

        // 1. Basic validation
        if (!name || !phone || !password || !pincode || !state || !skills || !area) {
            console.error("Registration failed: Missing required fields");
            return res.status(400).json({ success: false, message: "Please provide all required details" });
        }

        // 2. Check if technician already exists
        const existingTech = await technicianModel.findOne({ phone });
        if (existingTech) {
            console.error("Registration failed: Phone number already registered -", phone);
            return res.status(400).json({ success: false, message: "Phone number already registered" });
        }

        // 3. 🔒 Hash the password using bcrypt
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // 4. Create the new technician profile with the hashed password
        const newTech = await technicianModel.create({
            name,
            phone,
            password: hashedPassword, // Saving encrypted password
            pincode,
            skills: Array.isArray(skills) ? skills : [skills],
            hasVehicle,
            area,
            state,
            location: {
                type: 'Point',
                coordinates: [0, 0]
            }
        });

        // 5. 🔑 Generate JWT Token for authentication
        const token = jwt.sign(
            { techId: newTech._id, role: 'technician' },
            process.env.JWT_SECRET, // Make sure this is in your .env file
            { expiresIn: '7d' } // Token valid for 7 days
        );

        // 6. Set token in HTTP-only cookie for secure session management
        res.cookie('techToken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
        });

        console.log("Secure technician registration successful. Tech ID:", newTech._id);

        // 7. Send success response (excluding password)
        res.status(201).json({
            success: true,
            message: "Registration successful",
            data: {
                _id: newTech._id,
                name: newTech.name,
                phone: newTech.phone,
                skills: newTech.skills,
                area: newTech.area,
                pincode: newTech.pincode
            }
        });
    } catch (error) {
        console.error("Error during secure technician registration:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};
// Fetch technician profile (secured route)
const getTechProfile = async (req, res) => {
    try {
        // Data is now coming directly from the database!
        res.status(200).json({ success: true, data: req.technician });
    } catch (error) {
        console.error("Error fetching tech profile:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// Login technician and issue JWT token
const loginTechnician = async (req, res) => {
    try {
        const { phone, password } = req.body;

        const technician = await technicianModel.findOne({ phone });
        if (!technician) {
            console.error("Login failed: Technician not found");
            return res.status(401).json({ success: false, message: "Invalid phone number or password" });
        }

        const isPasswordValid = await bcrypt.compare(password, technician.password);
        if (!isPasswordValid) {
            console.error("Login failed: Incorrect password");
            return res.status(401).json({ success: false, message: "Invalid phone number or password" });
        }

        const token = jwt.sign(
            { techId: technician._id, role: 'technician' },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.cookie('techToken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000 
        });

        console.log("Technician logged in successfully:", technician._id);
        res.status(200).json({ success: true, message: "Login successful", data: technician });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// Update technician profile (secured route)
const updateTechProfile = async (req, res) => {
    try {
        const techId = req.technician._id;
        const { name, phone, state, area, pincode } = req.body;
        
        // Prepare update object
        let updateData = { name, phone, state, area, pincode };

        // Check if an image file was uploaded
        if (req.file) {
            console.log(`Uploading new profile image for Tech: ${techId}`);
            const fileName = `tech_${techId}_${Date.now()}`;
            const uploadResult = await uploadImage(req.file.buffer, fileName);
            updateData.profileImage = uploadResult.url; // Save ImageKit URL
        }

        const updatedTech = await technicianModel.findByIdAndUpdate(
            techId,
            updateData,
            { new: true, runValidators: true }
        ).select("-password");

        console.log("Profile updated successfully for tech:", techId);
        res.status(200).json({ success: true, message: "Profile updated successfully", data: updatedTech });
    } catch (error) {
        console.error("Profile update error:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// Delete technician profile (secured route)
const deleteTechProfile = async (req, res) => {
    try {
        const techId = req.technician._id;

        await technicianModel.findByIdAndDelete(techId);
        
        // Clear the cookie so the user is logged out
        res.clearCookie('techToken');

        console.log("Technician account deleted permanently:", techId);
        res.status(200).json({ success: true, message: "Account deleted successfully" });
    } catch (error) {
        console.error("Account deletion error:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// Logout technician by clearing the JWT cookie
const logoutTechnician = (req, res) => {
    res.clearCookie('techToken');
    res.status(200).json({ success: true, message: "Logged out successfully" });
};

// Toggle Online/Offline and Available/Busy status
const updateStatus = async (req, res) => {
    try {
        const { isOnline, isAvailable } = req.body;
        const techId = req.technician._id;
        const updatedTech = await technicianModel.findByIdAndUpdate(
            techId,
            { isAvailable: isAvailable },
            { new: true }
        ).select("-password");

        console.log(`Status updated for Tech ${techId}: Available=${isAvailable}`);
        res.status(200).json({ success: true, data: updatedTech });
    } catch (error) {
        console.error("Error updating tech status:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// Update technician's live location and availability
const updateLocation = async (req, res) => {
    try {
        const { techId, lat, lon, isAvailable } = req.body;

        const updatedTech = await technicianModel.findByIdAndUpdate(
            techId,
            {
                location: {
                    type: 'Point',
                    coordinates: [lon, lat] // MongoDB expects [longitude, latitude]
                },
                isAvailable: isAvailable
            },
            { new: true }
        );

        if (!updatedTech) {
            console.error("Technician not found for location update:", techId);
            return res.status(404).json({ success: false, message: "Technician not found" });
        }

        console.log(`Location updated for tech ${techId} at coordinates [${lon}, ${lat}]`);
        res.status(200).json({ success: true, data: updatedTech });
    } catch (error) {
        console.error("Error updating location:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// Fetch open tickets for available technicians
const getOpenTickets = async (req, res) => {
    try {
        // Fetch tickets with 'Open' status
        const openTickets = await ticketModel.find({ status: 'Open' })
            .populate('customer', 'name phone address location') // Populate user details
            .sort({ createdAt: -1 });

        res.status(200).json({ success: true, data: openTickets });
    } catch (error) {
        console.error("Error fetching open tickets:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};


const getMyAssignedTicket = async (req, res) => {
    try {
        const techId = req.technician._id;

        // 👇 Yahan status array mein saare active statuses hone chahiye
        const activeTicket = await ticketModel.findOne({ 
            technician: techId, 
            status: { $in: ['Assigned', 'In-Progress', 'Payment-Pending'] } 
        })
        .populate('customer', 'name phone address lat lon area state') 
        .sort({ createdAt: -1 });

        if (!activeTicket) {
            // Agar active ticket nahi hai, toh gracefully null return karo
            return res.status(200).json({ success: true, message: "No active ticket", data: null });
        }

        res.status(200).json({ success: true, data: activeTicket });
    } catch (error) {
        console.error("🚨 Error fetching assigned ticket:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// Accept a ticket and assign it to the technician
const acceptTicket = async (req, res) => {
    try {
        const { ticketId, techId } = req.body;

        // 1. Verify if the ticket is still open
        const ticket = await ticketModel.findById(ticketId);
        if (!ticket || ticket.status !== 'Open') {
            console.error("Ticket is no longer available:", ticketId);
            return res.status(400).json({ success: false, message: "Ticket already assigned or closed" });
        }

        // 2. Assign ticket to technician and change status to 'Assigned'
        ticket.technician = techId;
        ticket.status = 'Assigned';
        await ticket.save();

        // 3. Mark technician as unavailable and link the active ticket
        await technicianModel.findByIdAndUpdate(techId, {
            isAvailable: false,
            activeTicket: ticketId
        });

        console.log(`Ticket ${ticketId} successfully assigned to Technician ${techId}`);
        res.status(200).json({ success: true, message: "Ticket accepted successfully", data: ticket });
    } catch (error) {
        console.error("Error accepting ticket:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

//MARK TICKET AS COMPLETED & UPDATE PERFORMANCE IN DB
const completeTicket = async (req, res) => {
    try {
        const { ticketId } = req.body;
        const techId = req.technician._id;

        // 1. Update the Ticket status to 'Closed'
        const ticket = await Ticket.findOneAndUpdate(
            { _id: ticketId, technician: techId },
            { status: 'Closed' },
            { new: true }
        );

        if (!ticket) {
            console.error("Complete Ticket Error: Ticket not found or not assigned to this tech.");
            return res.status(404).json({ success: false, message: "Ticket not found" });
        }

        // 2. Fetch the technician to update their stats
        const technician = await Technician.findById(techId);

        // 3. Increment the completed jobs count
        technician.completedJobs += 1;

        // 4. Recalculate Performance Level based on real DB values
        const rating = technician.rating || 5.0;
        
        if (technician.completedJobs >= 20 && rating >= 4.5) {
            technician.performanceLevel = 'EXPERT';
        } else if (technician.completedJobs >= 5 && rating >= 4.0) {
            technician.performanceLevel = 'PRO';
        }

        // Make technician available for new jobs again
        technician.isAvailable = true;
        technician.activeTicket = null;

        // 5. SAVE PERMANENTLY TO DATABASE
        await technician.save();

        console.log(`Job completed! Tech ${techId} stats updated permanently in DB. Total Jobs: ${technician.completedJobs}, Level: ${technician.performanceLevel}`);
        
        res.status(200).json({ 
            success: true, 
            message: "Job marked as completed and profile updated", 
            data: technician 
        });
    } catch (error) {
        console.error("Error completing ticket:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};


const generateBill = async (req, res) => {
    try {
        const { ticketId, partsUsed, gasFilled, totalAmount, additionalNotes } = req.body;
        const techId = req.technician._id;

        const ticket = await ticketModel.findOneAndUpdate(
            { _id: ticketId, technician: techId },
            { 
                status: 'Payment-Pending',
                serviceProvided: { partsUsed, gasFilled, additionalNotes },
                totalAmount: totalAmount 
            },
            { returnDocument: 'after' } // 👈 Mongoose Warning Fix
        ).populate('customer');

        // 👇 Socket.io se User ko Bill bhejenge
        const io = socketManager.getIo(); 
        const billMessage = `📝 *SERVICE INVOICE*\n\n🔧 Parts Used: ${partsUsed.join(', ') || 'None'}\n💨 Gas Filled: ${gasFilled ? 'Yes' : 'No'}\n💰 Total Amount: ₹${totalAmount}\n\n[PAYMENT_LINK_₹${totalAmount}]`;
        
        io.to(`user_${ticket.customer._id}`).emit('ai-response', {
            content: billMessage,
            sender: 'system',
            type: 'bill'
        });

        res.status(200).json({ success: true, message: "Bill sent to customer", data: ticket });
    } catch (error) {
        console.error("Generate Bill Error:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};


// User completes payment, system verifies and closes ticket
const verifyPaymentAndClose = async (req, res) => {
    try {
        const { ticketId } = req.body;
        const techId = req.technician._id;
        const techName = req.technician.name; // 👈 Token se tech ka naam nikal liya

        // 1. Ticket status update karein aur Technician ki details (History ke liye) save karein
        const ticket = await ticketModel.findOneAndUpdate(
            { _id: ticketId, technician: techId },
            { 
                status: 'Closed', 
                paymentStatus: 'Completed',
                technicianId: techId,        // 👈 Ticket history mein Tech ID save
                technicianName: techName     // 👈 Ticket history mein Tech Name save
            },
            { returnDocument: 'after' }
        ).populate('customer');

        if (!ticket) {
            return res.status(404).json({ success: false, message: "Ticket not found or not assigned to this tech" });
        }

        // 2. Tech ko available karein, activeTicket free karein aur jobs increment karein
        // ✅ FIX: Dono alag-alag update queries ko ek hi single query mein merge kar diya
        await technicianModel.findByIdAndUpdate(techId, {
            isAvailable: true,
            activeTicket: null,
            $inc: { completedJobs: 1 } 
        });

        // 3. Socket message safe emit karein
        try {
            const io = socketManager.getIo();
            if (ticket.customer?._id) {
                io.emit('ai-response', {
                    content: "✅ Payment received successfully! Thank you for choosing Cosmosgen. Have a great day!\n[DISCONNECT]",
                    sender: 'system'
                });
            }
        } catch (socketErr) {
            console.error("Socket emit warning in verifyPaymentAndClose:", socketErr.message);
        }

        res.status(200).json({ success: true, message: "Payment verified, job closed, and history saved!" });
    } catch (error) {
        console.error("Verify & Close Error:", error);
        res.status(500).json({ success: false, message: error.message || "Internal Server Error" });
    }
};


const getCompletedTickets = async (req, res) => {
    try {
        const techId = req.technician._id;
        const history = await ticketModel.find({ technician: techId, status: 'Closed' })
            .populate('customer', 'name address area state')
            .sort({ updatedAt: -1 }); // Naye wale upar
            
        res.status(200).json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

module.exports = {
    registerTechnician,
    getTechProfile,
    loginTechnician,
    updateTechProfile,
    deleteTechProfile,
    logoutTechnician,
    updateStatus,
    updateLocation,
    getOpenTickets,
    getMyAssignedTicket,
    acceptTicket,
    completeTicket,
    generateBill,
    verifyPaymentAndClose,
    getCompletedTickets
};
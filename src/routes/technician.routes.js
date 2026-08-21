const express = require('express');
const router = express.Router();
const upload = require('../middlewares/multer');
const {
    registerTechnician,
    updateLocation,
    loginTechnician,
    updateTechProfile,
    deleteTechProfile,
    logoutTechnician,
    getOpenTickets,
    acceptTicket,
    completeTicket,
    getTechProfile,
    getMyAssignedTicket,
    updateStatus,
    generateBill,
    verifyPaymentAndClose,
    getCompletedTickets
} = require('../controllers/technician.controller');
const { isTechAuthenticated } = require('../middlewares/techAuth.middleware');
// Create a new technician
router.post('/register', registerTechnician);

// Get the profile of the authenticated technician
router.get('/me', isTechAuthenticated, getTechProfile);

// Login technician and issue JWT token
router.post('/login', loginTechnician);

// Logout technician and clear JWT token
router.post('/logout', logoutTechnician);

// Update technician profile
router.put('/profile/update', isTechAuthenticated,upload.single('profileImage'), updateTechProfile);

// Delete technician profile
router.delete('/profile/delete', isTechAuthenticated, deleteTechProfile);

// Update technician's availability status
router.put('/status', isTechAuthenticated, updateStatus);

// Update live location and status
router.post('/update-location', isTechAuthenticated, updateLocation);

// Get list of all unassigned 'Open' tickets
router.get('/tickets/open', isTechAuthenticated, getOpenTickets);


router.get('/my-ticket', isTechAuthenticated, getMyAssignedTicket);

// Accept a specific ticket
router.post('/tickets/accept', isTechAuthenticated, acceptTicket);

// Mark a specific ticket as completed and update technician's performance
router.post('/tickets/complete', isTechAuthenticated, completeTicket);

router.post('/tickets/verify-close', isTechAuthenticated, verifyPaymentAndClose);

router.post('/tickets/generateBill', isTechAuthenticated, generateBill);

router.get('/tickets/history', isTechAuthenticated, getCompletedTickets);

module.exports = router;
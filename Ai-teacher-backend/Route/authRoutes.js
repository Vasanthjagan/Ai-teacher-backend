const express = require('express');
const router = express.Router();

// Hardcoded users (Email -> { password: "..." })
// We use lowercase keys for case-insensitive lookup.
// Names are now dynamic and provided during login.
const HARDCODED_USERS = {
    'tutor@skymeet.com': { password: 'tutorpassword' },
    'sara@skymeet.com': { password: 'sarapassword' }
};

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        let { email, password, name } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Robust check: trim and lowercase
        const cleanEmail = email.trim().toLowerCase();
        const user = HARDCODED_USERS[cleanEmail];

        if (!user || user.password !== password) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Return success with the provided name (dynamic)
        res.json({ success: true, teacherName: name || 'Teacher' });
    } catch (err) {
        console.error('❌ LOGIN ERROR:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

module.exports = router;

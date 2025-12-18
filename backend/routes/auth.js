const express = require('express');
const { isAuthenticated, getUser, supabaseAdmin } = require('../auth');

const router = express.Router();

router.get('/auth/user', isAuthenticated, async (req, res) => {
  try {
    if (req.user) {
      return res.json(req.user);
    }

    const userId = req.user?.claims?.sub || req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const user = await getUser(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ message: 'Failed to fetch user' });
  }
});

// Alias that simply returns the authenticated user
router.get('/auth/me', isAuthenticated, (req, res) => {
  return res.json(req.user);
});

// Promote an existing user to admin (requires caller to already be admin)
router.post('/auth/admin', isAuthenticated, async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({ message: 'Supabase admin client not configured' });
    }

    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      app_metadata: { role: 'admin' },
    });

    if (error) {
      return res.status(500).json({ message: error.message });
    }

    return res.json({ success: true, user: data.user });
  } catch (error) {
    console.error('Error promoting user to admin:', error);
    return res.status(500).json({ message: 'Failed to promote user' });
  }
});

module.exports = router;

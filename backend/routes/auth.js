const express = require('express');
const { isAuthenticated, getUser, login, signup, logout } = require('../auth');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

router.post('/auth/login', login);
router.post('/auth/signup', signup);
router.post('/auth/logout', logout);

router.get('/auth/user', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    
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

// Dev-only endpoint to create/approve a user
// Also allow enabling in production-like environments via ENABLE_DEV_AUTH_SEED=true
if (process.env.NODE_ENV !== 'production' || String(process.env.ENABLE_DEV_AUTH_SEED).toLowerCase() === 'true') {
  router.post('/auth/dev-create-user', async (req, res) => {
    try {
      const { email, password, firstName = null, lastName = null, role = 'owner' } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
      }
      if (password.length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long' });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      // Check if user exists
      const existing = await db.query(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );

      let userId;
      if (existing.rows.length === 0) {
        // Create new approved user
        const insert = await db.query(
          `INSERT INTO users (id, email, first_name, last_name, password_hash, status, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'approved', NOW(), NOW())
           RETURNING id, email, first_name, last_name, status, created_at, updated_at`,
          [email, firstName, lastName, passwordHash]
        );
        userId = insert.rows[0].id;
      } else {
        // Update existing user: set hash and approve
        userId = existing.rows[0].id;
        await db.query(
          `UPDATE users SET password_hash = $1, status = 'approved', updated_at = NOW() WHERE id = $2`,
          [passwordHash, userId]
        );
      }

      // Assign role (upsert)
      await db.query(
        `INSERT INTO user_roles (id, user_id, role, created_at)
         VALUES (gen_random_uuid(), $1, $2, NOW())
         ON CONFLICT DO NOTHING`,
        [userId, role]
      );

      const userResult = await db.query(
        `SELECT id, email, first_name, last_name, status, created_at, updated_at FROM users WHERE id = $1`,
        [userId]
      );

      return res.json({
        success: true,
        message: 'User created/updated and approved for login',
        user: userResult.rows[0],
        assignedRole: role
      });
    } catch (err) {
      console.error('dev-create-user error:', err);
      return res.status(500).json({ message: 'Failed to create dev user' });
    }
  });
}

// NEW: Bootstrap admin endpoint to create the first Owner (admin) account
router.post('/auth/bootstrap-admin', async (req, res) => {
  try {
    const allowBeyondFirst = String(process.env.ENABLE_ADMIN_BOOTSTRAP || '').toLowerCase() === 'true';

    // Check how many users exist
    const countRes = await db.query('SELECT COUNT(*)::int AS count FROM users');
    const existingCount = countRes.rows[0]?.count ?? 0;

    if (existingCount > 0 && !allowBeyondFirst) {
      return res.status(403).json({
        message: 'Admin bootstrap is disabled because users already exist. Set ENABLE_ADMIN_BOOTSTRAP=true to allow.'
      });
    }

    const { email, password, firstName = null, lastName = null } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Upsert user as approved
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);

    let userId;
    if (existing.rows.length === 0) {
      const insert = await db.query(
        `INSERT INTO users (id, email, first_name, last_name, password_hash, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'approved', NOW(), NOW())
         RETURNING id, email, first_name, last_name, status, created_at, updated_at`,
        [email, firstName, lastName, passwordHash]
      );
      userId = insert.rows[0].id;
    } else {
      userId = existing.rows[0].id;
      await db.query(
        `UPDATE users 
         SET password_hash = $1, status = 'approved', updated_at = NOW() 
         WHERE id = $2`,
        [passwordHash, userId]
      );
    }

    // Ensure Owner role
    await db.query(
      `INSERT INTO user_roles (id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, 'owner', NOW())
       ON CONFLICT DO NOTHING`,
      [userId]
    );

    const userResult = await db.query(
      `SELECT id, email, first_name, last_name, status, created_at, updated_at FROM users WHERE id = $1`,
      [userId]
    );

    return res.json({
      success: true,
      message: 'Owner (admin) account is ready. You can sign in now.',
      user: userResult.rows[0],
      assignedRole: 'owner'
    });
  } catch (err) {
    console.error('bootstrap-admin error:', err);
    return res.status(500).json({ message: 'Failed to bootstrap admin' });
  }
});

module.exports = router;
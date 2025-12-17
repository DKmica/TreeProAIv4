const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const session = require('express-session');
const connectPg = require('connect-pg-simple');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { logLogin } = require('./src/modules/core/auth');

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

// Ensure core auth schema exists in a fresh DB
async function ensureCoreAuthSchema() {
  // Enable UUID generation
  await db.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

  // Users table
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      profile_image_url TEXT,
      password_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Trigger function to auto-update updated_at
  await db.query(`
    CREATE OR REPLACE FUNCTION public.set_updated_at()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$;
  `);

  await db.query(`DROP TRIGGER IF EXISTS trg_users_updated_at ON public.users;`);
  await db.query(`
    CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();
  `);

  // User roles table
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.user_roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Ensure (user_id, role) is unique
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'user_roles_user_id_role_key'
      ) THEN
        ALTER TABLE public.user_roles
        ADD CONSTRAINT user_roles_user_id_role_key UNIQUE (user_id, role);
      END IF;
    END $$;
  `);
}

function getSession() {
  const PgStore = connectPg(session);
  const sessionSecret = process.env.SESSION_SECRET || 'insecure-dev-secret-change-me';

  if (!process.env.SESSION_SECRET) {
    console.warn(
      '⚠️  SESSION_SECRET is not set. Using a fallback development secret. Please set SESSION_SECRET in production.'
    );
  }

  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
  const sessionOptions = {
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL
    }
  };

  if (hasDatabaseUrl) {
    sessionOptions.store = new PgStore({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true, // allow store to bootstrap the sessions table
      ttl: SESSION_TTL,
      tableName: 'sessions'
    });
  } else {
    console.warn(
      '⚠️  DATABASE_URL is not set. Falling back to in-memory sessions. Sessions will reset on restart.'
    );
  }

  return session(sessionOptions);
}

async function findUserByEmail(email) {
  const result = await db.query(
    'SELECT id, email, first_name, last_name, profile_image_url, password_hash, created_at, updated_at FROM users WHERE email = $1',
    [email]
  );
  return result.rows[0] || null;
}

async function getUser(userId) {
  const result = await db.query(
    'SELECT id, email, first_name, last_name, profile_image_url, status, created_at, updated_at FROM users WHERE id = $1',
    [userId]
  );
  
  if (!result.rows[0]) {
    return null;
  }
  
  const user = result.rows[0];
  
  const rolesResult = await db.query(
    'SELECT role FROM user_roles WHERE user_id = $1',
    [userId]
  );
  
  user.roles = rolesResult.rows.map(r => r.role);
  
  return user;
}

async function hasOwnerRole() {
  const ownerRole = await db.query(
    `SELECT 1 FROM user_roles WHERE role = 'owner' LIMIT 1`
  );

  return ownerRole.rows.length > 0;
}

async function hasApprovedOwner() {
  const ownerRole = await db.query(
    `SELECT 1
     FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     WHERE ur.role = 'owner' AND u.status = 'approved'
     LIMIT 1`
  );

  return ownerRole.rows.length > 0;
}

async function assignDefaultRole(userId, email, { forceOwner = false } = {}) {
  // Copy any pre-registered roles for matching email
  if (email) {
    const preRegistered = await db.query(
      'SELECT ur.role FROM user_roles ur JOIN users u ON ur.user_id = u.id WHERE u.email = $1 AND u.id != $2',
      [email, userId]
    );

    if (preRegistered.rows.length > 0) {
      for (const row of preRegistered.rows) {
        await db.query(
          `INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [userId, row.role]
        );
      }
      await db.query('DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = $1 AND id != $2)', [email, userId]);
      await db.query('DELETE FROM users WHERE email = $1 AND id != $2', [email, userId]);
      return;
    }
  }

  const hasOwner = forceOwner ? false : await hasOwnerRole();
  const defaultRole = hasOwner ? 'crew_member' : 'owner';
  await db.query(
    `INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, defaultRole]
  );
}

async function createUser({ email, password, firstName, lastName }) {
  const passwordHash = await bcrypt.hash(password, 12);

  // Check if this is the first user (auto-approve as owner)
  const existingUsers = await db.query('SELECT COUNT(*) as count FROM users');
  const isFirstUser = existingUsers.rows[0].count === '0';
  const approvedOwnerExists = await hasApprovedOwner();
  const shouldAutoApprove = isFirstUser || !approvedOwnerExists;
  const status = shouldAutoApprove ? 'approved' : 'pending';
  
  const result = await db.query(
    `INSERT INTO users (id, email, first_name, last_name, password_hash, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING id, email, first_name, last_name, profile_image_url, status, created_at, updated_at`,
    [email, firstName || null, lastName || null, passwordHash, status]
  );

  const user = result.rows[0];
  
  // Only assign role if user is auto-approved (first user or no approved owners)
  if (shouldAutoApprove) {
    await assignDefaultRole(user.id, user.email, { forceOwner: !approvedOwnerExists });
  }
  
  return user;
}

async function setupAuth(app) {
  // Ensure essential tables exist before sessions and auth run
  await ensureCoreAuthSchema();

  app.set('trust proxy', 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  passport.serializeUser((user, cb) => cb(null, { id: user.id }));
  passport.deserializeUser(async (sessionUser, cb) => {
    try {
      const user = await getUser(sessionUser.id);
      cb(null, user || false);
    } catch (err) {
      cb(err);
    }
  });

  passport.use(
    new LocalStrategy({ usernameField: 'email', passwordField: 'password' }, async (email, password, done) => {
      try {
        const user = await findUserByEmail(email);
        if (!user || !user.password_hash) {
          return done(null, false, { message: 'Invalid credentials' });
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
          return done(null, false, { message: 'Invalid credentials' });
        }

        // Check if user is approved
        if (user.status === 'pending') {
          return done(null, false, { message: 'Your account is pending approval. Please wait for an administrator to approve your account.' });
        }
        
        if (user.status === 'rejected') {
          return done(null, false, { message: 'Your account has been rejected. Please contact an administrator.' });
        }

        const { password_hash, ...safeUser } = user;
        return done(null, safeUser);
      } catch (err) {
        return done(err);
      }
    })
  );
}

function validateCredentials(email, password) {
  if (!email || !password) {
    return 'Email and password are required';
  }
  if (password.length < 8) {
    return 'Password must be at least 8 characters long';
  }
  return null;
}

async function signup(req, res, next) {
  try {
    const { email, password, firstName, lastName } = req.body;
    const validationError = validateCredentials(email, password);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const user = await createUser({ email, password, firstName, lastName });

    // If user is pending approval, don't log them in
    if (user.status === 'pending') {
      return res.status(201).json({ 
        message: 'Account created successfully! Your account is pending approval by an administrator. You will receive access once approved.',
        pendingApproval: true,
        user: { email: user.email, firstName: user.first_name, lastName: user.last_name }
      });
    }

    // Auto-approved users (first user) get logged in immediately
    req.login(user, async (err) => {
      if (err) return next(err);
      await logLogin({ userId: user.id, method: 'local', metadata: { email } });
      const fullUser = await getUser(user.id);
      return res.json(fullUser);
    });
  } catch (err) {
    console.error('Signup error:', err);
    next(err);
  }
}

async function login(req, res, next) {
  passport.authenticate('local', async (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      return res.status(401).json({ message: info?.message || 'Invalid credentials' });
    }

    req.login(user, async (loginErr) => {
      if (loginErr) return next(loginErr);
      await logLogin({ userId: user.id, method: 'local', metadata: { email: user.email } });
      
      const fullUser = await getUser(user.id);
      res.json(fullUser);
    });
  })(req, res, next);
}

function logout(req, res) {
  req.logout(() => {
    req.session?.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  });
}

const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  return res.status(401).json({ message: 'Unauthorized' });
};

module.exports = {
  setupAuth,
  isAuthenticated,
  getUser,
  signup,
  login,
  logout,
  getSession
};
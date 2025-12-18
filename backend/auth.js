const { createClient } = require('@supabase/supabase-js');

const defaultUser = {
  id: 'local-admin',
  email: process.env.ADMIN_EMAIL || 'owner@treepro.ai',
  first_name: process.env.ADMIN_FIRST_NAME || 'TreePro',
  last_name: process.env.ADMIN_LAST_NAME || 'Owner',
  profile_image_url: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  role: 'admin',
};

const authenticatedUser = {
  ...defaultUser,
  claims: { sub: defaultUser.id },
};

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey)
  : null;

if (!supabaseAdmin) {
  console.warn('Supabase admin client not configured. JWT validation will fall back to AUTH_TOKEN or dev mode.');
}

function mapSupabaseUser(user) {
  if (!user) return null;

  const meta = user.user_metadata || {};
  const appMeta = user.app_metadata || {};

  return {
    id: user.id,
    email: user.email,
    first_name: meta.first_name || meta.firstName || null,
    last_name: meta.last_name || meta.lastName || null,
    profile_image_url: meta.avatar_url || null,
    created_at: user.created_at,
    updated_at: user.updated_at || user.created_at,
    role: appMeta.role || meta.role || 'user',
    claims: { sub: user.id },
  };
}

function getRequestToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const apiKey = req.headers['x-api-key'];
  return typeof apiKey === 'string' ? apiKey.trim() : null;
}

async function validateSupabaseToken(token) {
  if (!supabaseAdmin || !token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return null;
    }
    return mapSupabaseUser(data.user);
  } catch (err) {
    console.error('Error validating Supabase token:', err.message);
    return null;
  }
}

async function setupAuth(app) {
  app.use(async (req, _res, next) => {
    try {
      const requiredToken = process.env.AUTH_TOKEN;
      const providedToken = getRequestToken(req);

      const supabaseUser = await validateSupabaseToken(providedToken);
      if (supabaseUser) {
        req.user = supabaseUser;
        req.isAuthenticated = () => true;
        return next();
      }

      if (!requiredToken) {
        req.user = authenticatedUser;
        req.isAuthenticated = () => true;
        return next();
      }

      if (providedToken && providedToken === requiredToken) {
        req.user = authenticatedUser;
        req.isAuthenticated = () => true;
        return next();
      }

      req.user = null;
      req.isAuthenticated = () => false;
      return next();
    } catch (err) {
      console.error('Authentication middleware error:', err);
      req.user = null;
      req.isAuthenticated = () => false;
      return next();
    }
  });

  app.get('/api/login', (_req, res) => {
    res.status(200).json({
      message: 'Use Supabase email/password to authenticate. If AUTH_TOKEN is set, supply it as Bearer token or x-api-key header.',
    });
  });

  app.get('/api/logout', (_req, res) => {
    res.status(200).json({ message: 'Logged out' });
  });
}

async function getUser(userId) {
  if (userId === defaultUser.id) return defaultUser;

  if (supabaseAdmin && userId) {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      return mapSupabaseUser(data.user);
    } catch (err) {
      console.error('Error fetching user from Supabase:', err.message);
      return null;
    }
  }

  return null;
}

const isAuthenticated = async (req, res, next) => {
  try {
    const requiredToken = process.env.AUTH_TOKEN;
    const providedToken = getRequestToken(req);

    const supabaseUser = await validateSupabaseToken(providedToken);
    if (supabaseUser) {
      req.user = supabaseUser;
      return next();
    }

    if (!requiredToken) {
      req.user = authenticatedUser;
      return next();
    }

    if (providedToken && providedToken === requiredToken) {
      req.user = authenticatedUser;
      return next();
    }

    return res.status(401).json({ message: 'Unauthorized' });
  } catch (err) {
    console.error('Authorization check failed:', err);
    return res.status(401).json({ message: 'Unauthorized' });
  }
};

module.exports = { setupAuth, isAuthenticated, getUser, supabaseAdmin };

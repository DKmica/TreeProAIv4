const { Pool } = require('pg');
require('dotenv').config();

// Use the connection string from Supabase (Transaction Pooler is best for Vercel - port 6543)
// Example: postgres://[user]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Supabase connections
  }
});

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Connected to Supabase Postgres');
    release();
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
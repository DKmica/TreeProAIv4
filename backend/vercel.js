// Vercel serverless entrypoint - lazily initializes the Express app without starting a listener.
// The server only auto-starts when backend/server.js is run directly (see require.main check there).
const { app, initializeApp } = require('./server');

let initialized = false;
let initializing = null;

async function ensureInitialized() {
  if (initialized) return;
  if (!initializing) {
    initializing = initializeApp({ includeStatic: false })
      .then(() => {
        initialized = true;
      })
      .catch((err) => {
        initializing = null;
        throw err;
      });
  }
  await initializing;
}

module.exports = async (req, res) => {
  await ensureInitialized();
  return app(req, res);
};

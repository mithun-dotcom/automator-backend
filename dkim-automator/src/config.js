const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  DATA_DIR,
  // Used to encrypt stored credentials/session cookies. Set it in Render; a random
  // fallback means stored secrets become unreadable after a restart.
  SECRET_KEY: process.env.SECRET_KEY || crypto.randomBytes(32).toString('hex'),
  APP_PASSWORD: process.env.APP_PASSWORD || '',
  CHROME_PATH: process.env.CHROME_PATH || '/usr/bin/chromium',
  HEADLESS: process.env.HEADLESS !== 'false',
  // Parallel browser workers. Each tenant is still processed one domain at a time.
  WORKERS: Math.max(1, Number(process.env.WORKERS) || 1),
  MAX_ATTEMPTS: Number(process.env.MAX_ATTEMPTS) || 4,
  DNS_POLL_SECONDS: Number(process.env.DNS_POLL_SECONDS) || 60,
  DNS_WAIT_HOURS: Number(process.env.DNS_WAIT_HOURS) || 6,
  // Google may refuse DKIM for 24-72h on brand-new Gmail tenants; keep retrying this long.
  GOOGLE_WAIT_HOURS: Number(process.env.GOOGLE_WAIT_HOURS) || 72,
  GOOGLE_WAIT_RETRY_MINUTES: Number(process.env.GOOGLE_WAIT_RETRY_MINUTES) || 60,
  BROWSER_IDLE_CLOSE_MS: 120000,
};

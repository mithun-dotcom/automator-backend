// Mithmill's Cloudflare account: clients' domains are added to it as zones,
// and the zone's nameservers are what the registrar gets switched to.
// The account ID and API token are set by the owner (Settings) and stored in
// the settings table, the token encrypted. They're never sent to the browser.
const { query } = require('./db');
const onboarding = require('./onboarding');

const API = (process.env.CLOUDFLARE_API_URL || 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');

// email is set when the key is the Global API Key (sent as X-Auth-Email /
// X-Auth-Key); without it the key is an API token (sent as a Bearer token).
async function config() {
  const { rows } = await query("SELECT key, value FROM settings WHERE key IN ('cf_account_id', 'cf_api_token', 'cf_email')");
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let token = '';
  try { token = v.cf_api_token ? onboarding.decrypt(Buffer.from(v.cf_api_token, 'base64')) : ''; } catch { token = ''; }
  return { accountId: v.cf_account_id || '', token, email: v.cf_email || '' };
}

// A Global API Key is 37 hex characters; API tokens are longer and mixed.
const looksGlobal = (key) => /^[0-9a-f]{37}$/i.test(key || '');

async function save({ accountId, token, email = '' }) {
  await query("INSERT INTO settings (key, value) VALUES ('cf_account_id', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [accountId]);
  await query("INSERT INTO settings (key, value) VALUES ('cf_email', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [email]);
  if (token) {
    await query("INSERT INTO settings (key, value) VALUES ('cf_api_token', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [onboarding.encrypt(token).toString('base64')]);
  }
}

class CfError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function call(cfg, method, path, body) {
  if (!cfg.accountId || !cfg.token) throw new CfError('Cloudflare isn\'t connected yet. The owner sets it up under Settings → Cloudflare.');
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(cfg.email ? { 'X-Auth-Email': cfg.email, 'X-Auth-Key': cfg.token } : { Authorization: `Bearer ${cfg.token}` }),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new CfError(`Couldn't reach Cloudflare (${err.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const e = (data.errors || [])[0] || {};
    console.warn(`[cloudflare] ${method} ${path.split('?')[0]} -> ${res.status} ${JSON.stringify((data.errors || []).map((x) => [x.code, x.message]))}`);
    throw new CfError(e.message ? `Cloudflare: ${e.message}` : `Cloudflare answered ${res.status}`, e.code);
  }
  return data.result;
}

// Checks the token is valid and can manage zones in the account: what adding
// clients' domains needs. Works with user tokens (My Profile → API Tokens) and
// account tokens (account → API Tokens). -> { account: name or ID }
async function test(cfg) {
  const c = cfg || await config();
  if (!c.accountId || !c.token) throw new CfError('Enter the Account ID and API token');
  if (looksGlobal(c.token) && !c.email) throw new CfError('This looks like the Global API Key: also enter the email you log in to Cloudflare with');
  // 1. Is the key valid at all?
  let valid = false;
  let why = '';
  const checks = c.email ? ['/user'] : ['/user/tokens/verify', `/accounts/${encodeURIComponent(c.accountId)}/tokens/verify`];
  for (const path of checks) {
    try { await call(c, 'GET', path); valid = true; break; } catch (err) { why = why || err.message.replace(/^Cloudflare: /, ''); }
  }
  if (!valid) {
    throw new CfError(c.email
      ? `Cloudflare didn't accept this email + Global API Key (${why})`
      : `Cloudflare says this API token isn't valid (${why}). If it's your Global API Key, also enter your Cloudflare login email`);
  }
  // 2. Can it see zones in this account? (Needs Zone permissions on this account.)
  let zones;
  try {
    zones = await call(c, 'GET', `/zones?account.id=${encodeURIComponent(c.accountId)}&per_page=5`);
  } catch (err) {
    throw new CfError(`The token is valid, but it can't list zones in account ${c.accountId} (${err.message.replace(/^Cloudflare: /, '')}). Check the Account ID, and that the token has Zone → Zone → Edit and Zone → DNS → Edit with "All zones from" this account`);
  }
  // The account's name, when the token may read it (optional).
  let name = (zones && zones[0] && zones[0].account && zones[0].account.name) || '';
  if (!name) {
    try { name = (await call(c, 'GET', `/accounts/${encodeURIComponent(c.accountId)}`)).name; } catch { name = ''; }
  }
  return { account: name || `account ${c.accountId.slice(0, 6)}…`, zones: (zones || []).length };
}

const zoneInfo = (z) => ({ id: z.id, status: z.status, nameservers: z.name_servers || [] });

// Adds the domain as a zone (copying its current DNS records, so email keeps
// working), or finds it if it's already in the account. -> { id, status, nameservers }
async function addZone(domain) {
  const cfg = await config();
  try {
    return zoneInfo(await call(cfg, 'POST', '/zones', { name: domain, account: { id: cfg.accountId }, type: 'full', jump_start: true }));
  } catch (err) {
    // 1061: already exists (in this account, or another one).
    if (err.code !== 1061) throw err;
    const found = await call(cfg, 'GET', `/zones?name=${encodeURIComponent(domain)}&account.id=${encodeURIComponent(cfg.accountId)}`);
    if (found && found[0]) return zoneInfo(found[0]);
    throw new CfError(`${domain} is already on another Cloudflare account. It has to be removed there first.`, 1061);
  }
}

async function getZone(id) {
  return zoneInfo(await call(await config(), 'GET', `/zones/${encodeURIComponent(id)}`));
}

// Asks Cloudflare to look for the new nameservers now rather than on its own schedule.
async function activationCheck(id) {
  try { await call(await config(), 'PUT', `/zones/${encodeURIComponent(id)}/activation_check`); } catch { /* rate-limited or already active */ }
}

module.exports = { config, save, test, addZone, getZone, activationCheck, looksGlobal, CfError };

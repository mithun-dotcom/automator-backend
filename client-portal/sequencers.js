// Cold-email sequencers a client connects, so their Google Workspace and
// Microsoft 365 mailboxes (uploaded by us) are added to the sequencer with one
// click. Mailboxes connect with the sequencer's own Google / Microsoft
// sign-in (OAuth), done in the background by a headless browser (signin.js):
// - Instantly: its API gives a sign-in link per mailbox and confirms the
//   result (developer.instantly.ai → OAuth connection flow).
// - PlusVibe (beta): its partner API gives the sign-in link.
// - Smartlead (beta): no API for this, so the browser logs in to Smartlead
//   and uses its "connect Google / Microsoft" button; the API confirms it.
// - Anything else: a CSV to import.
const signin = require('./signin');

class SeqError extends Error {
  constructor(message, diag) { super(message); this.diag = diag; }
}

async function http(method, url, { headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new SeqError(`Couldn't reach the sequencer (${err.message})`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { ok: res.ok, status: res.status, data, text };
}
const errOf = (r) => {
  const d = r.data || {};
  const m = d.message || d.error || d.detail || (d.errors && JSON.stringify(d.errors)) || (r.text || '').slice(0, 200);
  return (typeof m === 'string' && m) || `HTTP ${r.status}`;
};
const must = (r, what) => {
  if (!r.ok) throw new SeqError(`${what}: ${errOf(r)}`);
  return r;
};
// The first sign-in link anywhere in an API answer.
function findAuthUrl(data) {
  if (typeof data === 'string') return /^https:\/\/(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com)\//.test(data) ? data : null;
  if (data && typeof data === 'object') for (const v of Object.values(data)) { const u = findAuthUrl(v); if (u) return u; }
  return null;
}

const PROVIDERS = {
  instantly: {
    name: 'Instantly',
    fields: [{ key: 'api_key', label: 'API key (V2)', secret: true }],
    help: 'Instantly → Settings → Integrations → API Keys → Create API Key, with the "all:all" scope (or accounts:create + accounts:read).',
    headers: (c) => ({ Authorization: `Bearer ${c.api_key}` }),
    async test(c) { must(await http('GET', 'https://api.instantly.ai/api/v2/accounts?limit=1', { headers: this.headers(c) }), 'Instantly rejected the key'); },
    async connect({ creds, mailbox, page, step }) {
      step('Instantly: start sign-in session');
      const init = must(await http('POST', `https://api.instantly.ai/api/v2/oauth/${mailbox.provider}/init`, { headers: this.headers(creds), body: {} }), 'Instantly');
      const { auth_url: authUrl, session_id: sessionId } = init.data || {};
      if (!authUrl || !sessionId) throw new SeqError(`Instantly didn't return a sign-in link (${(init.text || '').slice(0, 150)})`);
      await signin.completeSignIn(page, authUrl, mailbox.provider, mailbox.email, mailbox.password, step);
      step('Instantly: confirm');
      for (let i = 0; i < 20; i += 1) {
        const r = await http('GET', `https://api.instantly.ai/api/v2/oauth/session/status/${encodeURIComponent(sessionId)}`, { headers: this.headers(creds) });
        const st = r.data && r.data.status;
        if (r.ok && st === 'success') return { note: r.data.email ? `Connected as ${r.data.email}` : 'Connected' };
        if (!r.ok || st === 'error' || st === 'expired') throw new SeqError(`Instantly: ${st === 'expired' ? 'the sign-in session expired' : errOf(r)}`, await signin.diag(page));
        await signin.sleep(3000);
      }
      throw new SeqError('Instantly didn\'t confirm the connection within a minute', await signin.diag(page));
    },
  },
  smartlead: {
    name: 'Smartlead (beta)',
    fields: [
      { key: 'api_key', label: 'API key', secret: true },
      { key: 'login_email', label: 'Smartlead login email' },
      { key: 'login_password', label: 'Smartlead password', secret: true },
    ],
    help: 'Smartlead has no API for Google / Microsoft sign-in, so we log in to your Smartlead (in the background) to add each mailbox, and use the API key to confirm it. Smartlead → Settings → API Key. The login must not use 2FA.',
    async test(c) {
      must(await http('GET', `https://server.smartlead.ai/api/v1/email-accounts/?offset=0&limit=1&api_key=${encodeURIComponent(c.api_key)}`), 'Smartlead rejected the API key');
    },
    async has(c, email) {
      for (let offset = 0; offset < 2000; offset += 100) {
        const r = await http('GET', `https://server.smartlead.ai/api/v1/email-accounts/?offset=${offset}&limit=100&api_key=${encodeURIComponent(c.api_key)}`);
        if (!r.ok || !Array.isArray(r.data)) return false;
        if (r.data.some((a) => String(a.from_email || a.email || '').toLowerCase() === email.toLowerCase())) return true;
        if (r.data.length < 100) return false;
      }
      return false;
    },
    async connect({ creds, mailbox, page, step }) {
      if (await this.has(creds, mailbox.email)) return { note: 'Already in Smartlead' };
      step('Smartlead: log in');
      await page.goto('https://app.smartlead.ai/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.locator('input[type="email"], input[name="email"]').first().fill(creds.login_email, { timeout: 25000 })
        .catch(async () => { throw new SeqError('Smartlead: the login page didn\'t show an email field', await signin.diag(page)); });
      await page.locator('input[type="password"]').first().fill(creds.login_password);
      await signin.clickFirst(page, ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Login")', 'button:has-text("Sign in")']);
      await page.waitForURL((u) => !/\/login/.test(String(u)), { timeout: 30000 })
        .catch(async () => { throw new SeqError('Smartlead: couldn\'t log in with this email and password (or it asks for 2FA)', await signin.diag(page)); });

      step('Smartlead: add mailbox');
      await page.goto('https://app.smartlead.ai/app/email-accounts', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      if (!(await signin.clickFirst(page, ['button:has-text("Add Account")', 'button:has-text("Connect Mailbox")', 'button:has-text("Add Email Account")', 'button:has-text("Add Mailbox")', 'text=/^\\+?\\s*Add (Account|Mailbox)/']))) {
        throw new SeqError('Smartlead: couldn\'t find the "Add Account" button', await signin.diag(page));
      }
      await signin.sleep(1500);
      // Smartlead's own (shared) infrastructure, when asked.
      await signin.clickFirst(page, ['text=/Smartlead.s Infrastructure|Smartlead Infra|One.?click/i']);
      const google = mailbox.provider === 'google';
      if (!(await signin.clickFirst(page, google
        ? ['text=/^(Google|Gmail|G ?Suite|Google Workspace)/i', 'button:has-text("Google")', '[alt*="Google" i]']
        : ['text=/^(Microsoft|Outlook|Office ?365|Microsoft 365)/i', 'button:has-text("Microsoft")', 'button:has-text("Outlook")', '[alt*="Microsoft" i]', '[alt*="Outlook" i]']))) {
        throw new SeqError(`Smartlead: couldn't find the ${google ? 'Google' : 'Microsoft'} option`, await signin.diag(page));
      }
      await signin.sleep(1200);
      // The sign-in may open in a popup or in the same tab.
      const popup = page.context().waitForEvent('page', { timeout: 20000 }).catch(() => null);
      await signin.clickFirst(page, ['button:has-text("Connect")', 'button:has-text("Login")', 'button:has-text("Sign in")', 'button:has-text("Continue")', 'text=/(Connect|Sign in|Login) with/i']);
      const target = (await Promise.race([popup, page.waitForURL(/accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com/, { timeout: 20000 }).then(() => page).catch(() => null)])) || null;
      if (!target) throw new SeqError('Smartlead: the Google / Microsoft sign-in didn\'t open', await signin.diag(page));
      if (google) await signin.google(target, mailbox.email, mailbox.password, step);
      else await signin.microsoft(target, mailbox.email, mailbox.password, step);

      step('Smartlead: confirm');
      for (let i = 0; i < 8; i += 1) {
        await signin.sleep(4000);
        if (await this.has(creds, mailbox.email)) return { note: 'Connected' };
      }
      throw new SeqError('Smartlead: signed in, but the mailbox didn\'t appear in Smartlead', await signin.diag(target));
    },
  },
  plusvibe: {
    name: 'PlusVibe (beta)',
    fields: [{ key: 'api_key', label: 'API key', secret: true }, { key: 'username', label: 'PlusVibe login email' }],
    help: 'PlusVibe → Settings → API (Business plan). Uses PlusVibe\'s partner sign-in API; if your plan doesn\'t include it, PlusVibe returns an error and you can use the CSV instead.',
    async test(c) { if (!c.api_key) throw new SeqError('Enter the API key'); },
    async connect({ creds, mailbox, page, step }) {
      step('PlusVibe: get sign-in link');
      const path = mailbox.provider === 'google' ? 'partner-google-oauth-url' : 'partner-microsoft-oauth-url';
      const r = must(await http('POST', `https://api.plusvibe.ai/api/v1/webhook/${path}`, {
        headers: { 'x-api-key': creds.api_key }, body: { flow: mailbox.provider, pipl_username: creds.username },
      }), 'PlusVibe');
      const url = findAuthUrl(r.data) || findAuthUrl(r.text);
      if (!url) throw new SeqError(`PlusVibe didn't return a sign-in link (${(r.text || '').slice(0, 150)})`);
      const end = await signin.completeSignIn(page, url, mailbox.provider, mailbox.email, mailbox.password, step);
      if (/error|failed|denied/i.test(end.text) && !/success/i.test(end.text)) throw new SeqError(`PlusVibe: ${end.text.slice(0, 150)}`, await signin.diag(page));
      return { note: 'Signed in; PlusVibe adds it to your account' };
    },
  },
  other: {
    name: 'Other sequencer (CSV)',
    fields: [{ key: 'name', label: 'Sequencer name (e.g. SendKit)' }],
    csvOnly: true,
    help: 'For sequencers without a connection here: download your mailboxes as a CSV (email, password, provider, IMAP / SMTP settings) and use the sequencer\'s bulk import.',
    async test() {},
  },
};

const publicList = () => Object.entries(PROVIDERS).map(([key, p]) => ({
  key, name: p.name, help: p.help, csvOnly: Boolean(p.csvOnly),
  fields: p.fields.map((f) => ({ key: f.key, label: f.label, secret: Boolean(f.secret) })),
}));

function cleanCreds(provider, input) {
  const p = PROVIDERS[provider];
  if (!p) throw new SeqError('Choose a sequencer');
  const out = {};
  for (const f of p.fields) {
    const v = String((input || {})[f.key] || '').trim().slice(0, 500);
    if (!v) throw new SeqError(`Enter the ${f.label}`);
    out[f.key] = v;
  }
  return out;
}

const SERVERS = {
  google: ['imap.gmail.com', 993, 'smtp.gmail.com', 587],
  microsoft: ['outlook.office365.com', 993, 'smtp.office365.com', 587],
};
const CSV_HEADER = ['Email', 'Password', 'Provider', 'First Name', 'Last Name', 'IMAP Host', 'IMAP Port', 'SMTP Host', 'SMTP Port'];
function csvRow(m) {
  const local = m.email.split('@')[0].replace(/[._-]+/g, ' ').trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  const s = SERVERS[m.provider] || ['', '', '', ''];
  return [m.email, m.password, m.provider === 'google' ? 'Google Workspace' : m.provider === 'microsoft' ? 'Microsoft 365' : '', local[0] || '', local.slice(1).join(' '), ...s];
}

module.exports = { PROVIDERS, publicList, cleanCreds, csvRow, CSV_HEADER, SeqError, findAuthUrl };

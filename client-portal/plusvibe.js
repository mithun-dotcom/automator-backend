// PlusVibe partner API: only documented endpoints (https://developer.plusvibe.ai/llms.txt).
// No browser automation. PlusVibe's only documented way to add a Google / Microsoft mailbox is a
// consent link (partner-google-oauth-url / partner-microsoft-oauth-url); a person opens it, signs
// in as the mailbox and clicks Allow. We then confirm the mailbox with GET /account/list.
//
// Auth: `x-api-key` (the client's PlusVibe API key, Business plan) + our partner provider_id.
// Base URL: the endpoint specs say https://api.plusvibe.ai/api/v1; the Email Infra Provider Guide
// says https://api.plusvibe.ai/v1. Default is the spec value; set PLUSVIBE_API_BASE to change it.
// Rate limit: 10 requests/second per account.

class PlusVibeError extends Error {
  constructor(code, message, status = 0) { super(message); this.code = code; this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = () => (process.env.PLUSVIBE_API_BASE || 'https://api.plusvibe.ai/api/v1').replace(/\/$/, '');

function providerId() {
  const id = (process.env.PLUSVIBE_PROVIDER_ID || '').trim();
  if (!/^[a-f0-9]{24}$/.test(id)) throw new PlusVibeError('PROVIDER_NOT_CONFIGURED', 'PlusVibe partner ID (PLUSVIBE_PROVIDER_ID) is not set on the server');
  return id;
}

// Live only for these clients while it's being tested; everyone else sees "Coming soon".
function allowedFor(email) {
  const list = (process.env.PLUSVIBE_ALLOWED_EMAILS || 'mithun@mithmill.com').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return Boolean(email) && list.includes(String(email).trim().toLowerCase());
}

async function request(apiKey, method, path, { query, body } = {}) {
  const url = new URL(base() + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      const init = { method, headers: { 'x-api-key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) };
      if (method === 'POST') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body || {}); }
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= 3) throw new PlusVibeError('NETWORK_ERROR', `Couldn't reach PlusVibe (${err.message})`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text.slice(0, 200) }; }
    if (res.ok) return json;
    if (res.status === 401 || res.status === 403) throw new PlusVibeError('INVALID_API_KEY', 'PlusVibe rejected the API key', res.status);
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    throw new PlusVibeError(res.status === 429 ? 'RATE_LIMITED' : `HTTP_${res.status}`,
      `PlusVibe: ${json.message || json.error || `HTTP ${res.status}`}`, res.status);
  }
}

// Partner answers are { code: 1 | 0, message, data }.
function unwrap(json, what) {
  if (json && json.code === 1) return json.data;
  const m = (json && json.message) || 'unknown error';
  throw new PlusVibeError(/^[A-Z_]+$/.test(m) ? m : 'PLUSVIBE_REJECTED', `PlusVibe ${what}: ${m === 'MAX_ALLOWED_ACCOUNTS_REACHED' ? 'your PlusVibe plan has no free email-account slots' : m}`);
}

// POST /webhook/partner-list-workspace — also proves the key + our provider ID work.
async function listWorkspaces(apiKey) {
  const data = unwrap(await request(apiKey, 'POST', '/webhook/partner-list-workspace', { body: { flow: 'app_user', provider_id: providerId() } }), 'workspaces');
  return (data || []).map((w) => ({ id: w.workspace_id, name: w.workspace_name || w.workspace_id, status: w.workspace_status || '' }));
}

// GET /webhook/partner-check-email-account → { existed_in_other_ws, current, max_allowed }
async function checkEmail(apiKey, workspaceId, email) {
  return unwrap(await request(apiKey, 'GET', '/webhook/partner-check-email-account', {
    query: { workspace_id: workspaceId, provider_id: providerId(), email },
  }), 'email check');
}

// POST /webhook/partner-{google|microsoft}-oauth-url → the consent URL for adding one mailbox.
async function consentUrl(apiKey, workspaceId, kind) {
  const path = kind === 'microsoft' ? '/webhook/partner-microsoft-oauth-url' : '/webhook/partner-google-oauth-url';
  const data = unwrap(await request(apiKey, 'POST', path, { body: { flow: 'app_user', workspace_id: workspaceId, provider_id: providerId() } }), 'sign-in link');
  if (!data || !data.redirect_url) throw new PlusVibeError('NO_REDIRECT_URL', 'PlusVibe returned no sign-in link');
  return data.redirect_url;
}

// GET /account/list?email= → the account or null.
async function findAccount(apiKey, workspaceId, email) {
  const json = await request(apiKey, 'GET', '/account/list', { query: { workspace_id: workspaceId, email } });
  return (json.accounts || []).find((a) => String(a.email).toLowerCase() === email.toLowerCase()) || null;
}

// GET /account/list?domain= (cursor paging) → every account on a domain.
async function listDomain(apiKey, workspaceId, domain) {
  const all = [];
  let cursor = '';
  for (let page = 0; page < 200; page += 1) {
    const json = await request(apiKey, 'GET', '/account/list', { query: { workspace_id: workspaceId, domain, limit: 100, starting_after: cursor } });
    all.push(...(json.accounts || []));
    if (!json.has_more || !json.next_starting_after) break;
    cursor = json.next_starting_after;
  }
  return all;
}

const isActive = (a) => Boolean(a) && String(a.status).toUpperCase() === 'ACTIVE';

module.exports = { PlusVibeError, allowedFor, listWorkspaces, checkEmail, consentUrl, findAccount, listDomain, isActive };

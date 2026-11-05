const { Resolver } = require('dns').promises;

const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);

const norm = s => String(s || '').replace(/["\s]/g, '');

// Returns the DKIM TXT value currently visible in public DNS, or null.
async function lookupDkim(domain, selector) {
  try {
    const recs = await resolver.resolveTxt(`${selector}._domainkey.${domain}`);
    return recs.map(r => r.join('')).find(t => t.includes('DKIM1') || t.includes('p=')) || null;
  } catch {
    return null;
  }
}

async function isPublished(domain, selector, txtValue) {
  const found = await lookupDkim(domain, selector);
  return { found, match: !!found && norm(found) === norm(txtValue) };
}

// ── Cloudflare ──────────────────────────────────────────────────────────────
const CF = 'https://api.cloudflare.com/client/v4';

async function cf(token, method, path, body) {
  const r = await fetch(CF + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const msg = (j.errors || []).map(e => e.message).join('; ') || `HTTP ${r.status}`;
    const err = new Error(`Cloudflare: ${msg}`);
    err.permanent = r.status === 401 || r.status === 403;
    throw err;
  }
  return j.result;
}

async function findZone(token, domain) {
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts.slice(i).join('.');
    const zones = await cf(token, 'GET', `/zones?name=${encodeURIComponent(name)}`);
    if (zones.length) return zones[0];
  }
  const err = new Error(`Cloudflare: no zone found for ${domain} with this token`);
  err.permanent = true;
  throw err;
}

// Create or update the TXT record. Returns { action, recordId }.
async function cloudflareUpsertTxt(token, domain, selector, txtValue) {
  const zone = await findZone(token, domain);
  const name = `${selector}._domainkey.${domain}`;
  const existing = await cf(token, 'GET', `/zones/${zone.id}/dns_records?type=TXT&name=${encodeURIComponent(name)}`);
  const body = { type: 'TXT', name, content: txtValue, ttl: 300, comment: 'Google Workspace DKIM (dkim-automator)' };
  const same = existing.find(r => norm(r.content) === norm(txtValue));
  if (same) return { action: 'unchanged', recordId: same.id };
  if (existing.length) {
    const r = await cf(token, 'PUT', `/zones/${zone.id}/dns_records/${existing[0].id}`, body);
    for (const extra of existing.slice(1)) await cf(token, 'DELETE', `/zones/${zone.id}/dns_records/${extra.id}`);
    return { action: 'updated', recordId: r.id };
  }
  const r = await cf(token, 'POST', `/zones/${zone.id}/dns_records`, body);
  return { action: 'created', recordId: r.id };
}

// Works for both user and account tokens: list one zone.
async function cloudflareVerifyToken(token) {
  const zones = await cf(token, 'GET', '/zones?per_page=1');
  return Array.isArray(zones);
}

module.exports = { lookupDkim, isPublished, cloudflareUpsertTxt, cloudflareVerifyToken, norm };

// Pre-warmed inbox stock: the automatic stage moves and domain expiry dates.
//   warming  -> available  after 14 days warming
//   available -> premium   after 30 days available and unsold
// Expiry dates come from RDAP (the registries' public lookup, via rdap.org).
const { query } = require('./db');

const WARMUP_DAYS = 14;
const PREMIUM_AFTER_DAYS = 30;

// Inboxes that are already in a client's Mailboxes are that client's: tag
// them sold to the client who got them first.
async function syncSold() {
  const r = await query(`UPDATE prewarmed p SET status = 'sold', sold_from = p.status, status_since = m.created_at,
      sold_to = m.user_id, sold_at = m.created_at
    FROM (SELECT DISTINCT ON (lower(email)) lower(email) AS e, user_id, created_at FROM mailboxes ORDER BY lower(email), created_at) m
    WHERE p.status <> 'sold' AND lower(p.email) = m.e`);
  if (r.rowCount) console.log(`[prewarmed] tagged ${r.rowCount} inbox(es) sold: already in a client's Mailboxes`);
  return r.rowCount;
}

// Moves every inbox whose time is up; returns how many moved.
async function advance() {
  await syncSold();
  let moved = 0;
  // A loop, so one that's overdue by more than a stage moves through both.
  for (let i = 0; i < 3; i++) {
    const a = await query(`UPDATE prewarmed SET status = 'available', status_since = status_since + interval '${WARMUP_DAYS} days'
      WHERE status = 'warming' AND status_since + interval '${WARMUP_DAYS} days' <= now()`);
    const b = await query(`UPDATE prewarmed SET status = 'premium', status_since = status_since + interval '${PREMIUM_AFTER_DAYS} days'
      WHERE status = 'available' AND status_since + interval '${PREMIUM_AFTER_DAYS} days' <= now()`);
    moved += a.rowCount + b.rowCount;
    if (!a.rowCount && !b.rowCount) break;
  }
  if (moved) console.log(`[prewarmed] moved ${moved} inbox(es) to the next stage`);
  return moved;
}

// RDAP: each TLD's registry runs its own server, listed by IANA (the
// "bootstrap" file). We ask the registry directly, falling back to rdap.org.
const UA = 'MithmillPortal/1.0 (+https://client.mithmill.com)';
const FALLBACK = (process.env.RDAP_URL || 'https://rdap.org/domain/').replace(/\/?$/, '/');
let bootstrap = null;
let bootstrapAt = 0;
async function registryFor(tld) {
  if (process.env.RDAP_URL) return null;
  if (!bootstrap || Date.now() - bootstrapAt > 7 * 86400000) {
    try {
      const res = await fetch('https://data.iana.org/rdap/dns.json', { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const data = await res.json();
        bootstrap = new Map();
        for (const [tlds, urls] of data.services || []) {
          const url = (urls || []).find((u) => u.startsWith('https://')) || (urls || [])[0];
          for (const t of tlds) bootstrap.set(t.toLowerCase(), url.replace(/\/?$/, '/'));
        }
        bootstrapAt = Date.now();
      }
    } catch (err) { console.warn('[prewarmed] RDAP bootstrap failed:', err.message); }
  }
  return bootstrap ? bootstrap.get(tld) || null : null;
}
// Registries limit how fast we may ask (the .co one answers 429 quickly), so
// lookups to each registry are paced, slowed further after a 429.
const pace = new Map(); // host -> { gap ms, next timestamp }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitTurn(host) {
  const p = pace.get(host) || { gap: 700, next: 0 };
  pace.set(host, p);
  const wait = p.next - Date.now();
  if (wait > 0) await sleep(wait);
  p.next = Date.now() + p.gap;
  return p;
}
async function rdap(url) {
  const host = new URL(url).host;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = await waitTurn(host);
    const res = await fetch(url, {
      headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      // Slow down for this registry and wait as asked (or 20 s), then retry.
      p.gap = Math.min(p.gap * 2, 15000);
      const after = Number(res.headers.get('retry-after'));
      await sleep(Math.min(60000, (Number.isFinite(after) && after > 0 ? after * 1000 : 20000)));
      continue;
    }
    if (res.status === 404) { const e = new Error('Not found in the registry'); e.final = true; throw e; }
    if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
    p.gap = Math.max(700, Math.round(p.gap * 0.9));
    return res.json();
  }
  const e = new Error('Rate limited by the registry, retrying soon');
  e.rateLimited = true;
  throw e;
}

// WHOIS (port 43), the older lookup, as a fallback: the TLD's WHOIS server
// comes from IANA, then "Registry Expiry Date:" from the registry's answer.
const whoisServers = new Map();
function whoisQuery(server, q) {
  return new Promise((resolve, reject) => {
    const sock = require('net').connect(43, server);
    let out = '';
    sock.setTimeout(15000, () => { sock.destroy(); reject(new Error('WHOIS timed out')); });
    sock.on('connect', () => sock.write(`${q}\r\n`));
    sock.on('data', (d) => { out += d; if (out.length > 200000) sock.destroy(); });
    sock.on('end', () => resolve(out));
    sock.on('close', () => resolve(out));
    sock.on('error', reject);
  });
}
async function whois(domain) {
  const tld = domain.split('.').pop().toLowerCase();
  if (!whoisServers.has(tld)) {
    const iana = await whoisQuery('whois.iana.org', tld);
    whoisServers.set(tld, ((iana.match(/^whois:\s*(\S+)/mi) || [])[1]) || null);
  }
  const server = whoisServers.get(tld);
  if (!server) throw new Error('No WHOIS server for this TLD');
  await waitTurn(`whois:${server}`);
  const text = await whoisQuery(server, domain);
  if (/no match|not found|no data found|no entries found/i.test(text)) { const e = new Error('Not found in the registry'); e.final = true; throw e; }
  const m = text.match(/(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiration Date|Expiry Date|paid-till|expires?)\s*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
  if (!m) throw new Error('WHOIS has no expiry date for this domain');
  const reg = text.match(/^\s*Registrar:\s*(.+)$/mi);
  return { expires_on: m[1], registrar: reg ? reg[1].trim().slice(0, 120) : '' };
}

async function lookup(domain) {
  const tld = domain.split('.').pop().toLowerCase();
  const base = await registryFor(tld);
  let data;
  let firstErr = null;
  for (const url of [base && `${base}domain/${encodeURIComponent(domain)}`, `${FALLBACK}${encodeURIComponent(domain)}`].filter(Boolean)) {
    try { data = await rdap(url); break; } catch (err) { firstErr = firstErr || err; if (err.final) throw err; }
  }
  if (!data) {
    if (process.env.RDAP_URL) throw firstErr || new Error('Lookup failed');
    try { return await whois(domain); } catch (err) { if (err.final) throw err; throw firstErr && firstErr.rateLimited ? firstErr : err; }
  }
  const ev = (data.events || []).find((e) => /expir/i.test(e.eventAction || ''));
  const reg = (data.entities || []).find((e) => (e.roles || []).includes('registrar'));
  const name = reg && reg.vcardArray && (reg.vcardArray[1] || []).find((v) => v[0] === 'fn');
  if (!ev || !ev.eventDate) {
    try { return await whois(domain); } catch { throw new Error('The registry doesn\'t publish an expiry date for this domain'); }
  }
  return { expires_on: String(ev.eventDate).slice(0, 10), registrar: name ? String(name[3]).slice(0, 120) : '' };
}

// Checks domains never checked, those checked over a week ago, failed ones
// after 6 hours (rate-limited ones after 15 minutes), and daily those
// expiring within 45 days. force: these domains now. One run at a time.
let running = null;
async function checkExpiry({ force = [] } = {}) {
  if (running) return running;
  running = runCheck(force).finally(() => { running = null; });
  return running;
}
async function runCheck(force) {
  const { rows } = force.length
    ? { rows: force.map((d) => ({ domain: d })) }
    : await query(`SELECT DISTINCT p.domain FROM prewarmed p LEFT JOIN domain_expiry x ON x.domain = p.domain
        WHERE x.domain IS NULL OR x.checked_at IS NULL
           OR x.checked_at < now() - interval '7 days'
           OR (x.expires_on IS NULL AND x.error LIKE 'Rate limited%' AND x.checked_at < now() - interval '15 minutes')
           OR (x.expires_on IS NULL AND x.checked_at < now() - interval '6 hours')
           OR (x.expires_on IS NOT NULL AND x.expires_on < current_date + 45 AND x.checked_at < now() - interval '1 day')
        LIMIT 1000`);
  let ok = 0;
  const limitedTlds = new Set();
  for (const { domain } of rows) {
    const tld = domain.split('.').pop();
    if (limitedTlds.has(tld)) continue; // that registry wants us to stop for now
    try {
      const r = await lookup(domain);
      await query(`INSERT INTO domain_expiry (domain, expires_on, registrar, checked_at, error) VALUES ($1, $2, $3, now(), '')
        ON CONFLICT (domain) DO UPDATE SET expires_on = EXCLUDED.expires_on, registrar = EXCLUDED.registrar, checked_at = now(), error = ''`,
      [domain, r.expires_on, r.registrar]);
      ok += 1;
    } catch (err) {
      if (err.rateLimited) limitedTlds.add(tld);
      await query(`INSERT INTO domain_expiry (domain, checked_at, error) VALUES ($1, now(), $2)
        ON CONFLICT (domain) DO UPDATE SET checked_at = now(), error = EXCLUDED.error`, [domain, String(err.message).slice(0, 200)]);
    }
  }
  if (rows.length) console.log(`[prewarmed] expiry checked for ${ok}/${rows.length} domain(s)${limitedTlds.size ? `; rate-limited: .${[...limitedTlds].join(', .')}` : ''}`);
  return { checked: rows.length, ok };
}

module.exports = { advance, syncSold, checkExpiry, WARMUP_DAYS, PREMIUM_AFTER_DAYS };

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
async function rdap(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) { const e = new Error('Not found in the registry'); e.final = true; throw e; }
  if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
  return res.json();
}
async function lookup(domain) {
  const tld = domain.split('.').pop().toLowerCase();
  const base = await registryFor(tld);
  let data;
  let firstErr = null;
  for (const url of [base && `${base}domain/${encodeURIComponent(domain)}`, `${FALLBACK}${encodeURIComponent(domain)}`].filter(Boolean)) {
    try { data = await rdap(url); break; } catch (err) { firstErr = firstErr || err; if (err.final) throw err; }
  }
  if (!data) throw firstErr || new Error('Lookup failed');
  const ev = (data.events || []).find((e) => /expir/i.test(e.eventAction || ''));
  const reg = (data.entities || []).find((e) => (e.roles || []).includes('registrar'));
  const name = reg && reg.vcardArray && (reg.vcardArray[1] || []).find((v) => v[0] === 'fn');
  if (!ev || !ev.eventDate) throw new Error('The registry doesn\'t publish an expiry date for this domain');
  return { expires_on: String(ev.eventDate).slice(0, 10), registrar: name ? String(name[3]).slice(0, 120) : '' };
}

// Checks domains never checked, those checked over a week ago, and daily
// those expiring within 45 days. force: these domains now.
async function checkExpiry({ force = [] } = {}) {
  const { rows } = force.length
    ? { rows: force.map((d) => ({ domain: d })) }
    : await query(`SELECT DISTINCT p.domain FROM prewarmed p LEFT JOIN domain_expiry x ON x.domain = p.domain
        WHERE x.domain IS NULL OR x.checked_at IS NULL
           OR x.checked_at < now() - interval '7 days'
           OR (x.expires_on IS NULL AND x.checked_at < now() - interval '6 hours')
           OR (x.expires_on IS NOT NULL AND x.expires_on < current_date + 45 AND x.checked_at < now() - interval '1 day')
        LIMIT 200`);
  let ok = 0;
  for (const { domain } of rows) {
    try {
      const r = await lookup(domain);
      await query(`INSERT INTO domain_expiry (domain, expires_on, registrar, checked_at, error) VALUES ($1, $2, $3, now(), '')
        ON CONFLICT (domain) DO UPDATE SET expires_on = EXCLUDED.expires_on, registrar = EXCLUDED.registrar, checked_at = now(), error = ''`,
      [domain, r.expires_on, r.registrar]);
      ok += 1;
    } catch (err) {
      await query(`INSERT INTO domain_expiry (domain, checked_at, error) VALUES ($1, now(), $2)
        ON CONFLICT (domain) DO UPDATE SET checked_at = now(), error = EXCLUDED.error`, [domain, String(err.message).slice(0, 200)]);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (rows.length) console.log(`[prewarmed] expiry checked for ${ok}/${rows.length} domain(s)`);
  return { checked: rows.length, ok };
}

module.exports = { advance, syncSold, checkExpiry, WARMUP_DAYS, PREMIUM_AFTER_DAYS };

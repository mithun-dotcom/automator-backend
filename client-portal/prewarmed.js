// Pre-warmed inbox stock: the automatic stage moves and domain expiry dates.
//   warming  -> available  after 14 days warming
//   available -> premium   after 30 days available and unsold
// Expiry dates come from RDAP (the registries' public lookup, via rdap.org).
const { query } = require('./db');

const WARMUP_DAYS = 14;
const PREMIUM_AFTER_DAYS = 30;

// Moves every inbox whose time is up; returns how many moved.
async function advance() {
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

const RDAP = (process.env.RDAP_URL || 'https://rdap.org/domain/').replace(/\/?$/, '/');
async function lookup(domain) {
  const res = await fetch(`${RDAP}${encodeURIComponent(domain)}`, {
    headers: { Accept: 'application/rdap+json, application/json' }, redirect: 'follow', signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) throw new Error('Not found in the registry');
  if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
  const data = await res.json();
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

module.exports = { advance, checkExpiry, WARMUP_DAYS, PREMIUM_AFTER_DAYS };

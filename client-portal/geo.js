// Approximate location (city, region, country) of clients and resellers when
// they accept an invite or log in, looked up from their IP address. The
// lookup runs in the background so it never slows down logging in.
const { query } = require('./db');

// {ip} is replaced by the address. ipwho.is is free and needs no key.
const LOOKUP_URL = process.env.GEO_LOOKUP_URL || 'https://ipwho.is/{ip}';
const cache = new Map();

const isPrivate = (ip) => !ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80)/i.test(ip);
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

async function lookup(ip) {
  if (isPrivate(ip)) return null;
  if (cache.has(ip)) return cache.get(ip);
  try {
    const res = await fetch(LOOKUP_URL.replace('{ip}', encodeURIComponent(ip)), { signal: AbortSignal.timeout(4000) });
    const d = await res.json();
    if (d.success === false) return null;
    const loc = {
      city: String(d.city || '').slice(0, 100),
      region: String(d.region || '').slice(0, 100),
      country: String(d.country || '').slice(0, 100),
      country_code: String(d.country_code || '').slice(0, 2).toUpperCase(),
    };
    cache.set(ip, loc);
    return loc;
  } catch (err) {
    console.warn(`[geo] lookup failed for ${ip}: ${err.message}`);
    return null;
  }
}

// Logs an invite acceptance / login / password reset, then fills in where it
// came from and updates the person's last known location.
function record(userId, ip, kind, userAgent) {
  const addr = cleanIp(ip);
  (async () => {
    const { rows: [ev] } = await query(
      'INSERT INTO login_events (user_id, ip, kind, user_agent) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, addr, kind, String(userAgent || '').slice(0, 300)]);
    const loc = await lookup(addr);
    if (!loc) return;
    await query('UPDATE login_events SET city = $1, region = $2, country = $3, country_code = $4 WHERE id = $5',
      [loc.city, loc.region, loc.country, loc.country_code, ev.id]);
    // Last known location = the most recent event that has one (lookups can finish out of order).
    await query(
      `UPDATE users u SET city = e.city, region = e.region, country = e.country, country_code = e.country_code
         FROM (SELECT city, region, country, country_code FROM login_events
                WHERE user_id = $1 AND country <> '' ORDER BY created_at DESC, id DESC LIMIT 1) e
        WHERE u.id = $1`, [userId]);
  })().catch((err) => console.error('[geo] record failed:', err.message));
}

module.exports = { record, lookup };

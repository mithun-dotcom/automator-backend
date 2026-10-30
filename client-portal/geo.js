// Approximate location (city, region, country) of clients and resellers when
// they accept an invite or log in, looked up from their IP address. The
// lookup runs in the background so it never slows down logging in.
const net = require('net');
const { query } = require('./db');

// {ip} is replaced by the address. ipwho.is is free and needs no key.
const LOOKUP_URL = process.env.GEO_LOOKUP_URL || 'https://ipwho.is/{ip}';
const cache = new Map();

const isPrivate = (ip) => !ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80)/i.test(ip);
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

// client.mithmill.com sits behind Cloudflare, so the address the app sees is a
// Cloudflare server's (e.g. Portland, USA), not the visitor's. Cloudflare puts
// the visitor's real address in CF-Connecting-IP; it's only trusted when the
// request really came through Cloudflare. Ranges: https://www.cloudflare.com/ips/
const CLOUDFLARE = new net.BlockList();
['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'].forEach((c) => { const [a, p] = c.split('/'); CLOUDFLARE.addSubnet(a, Number(p), 'ipv4'); });
['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32']
  .forEach((c) => { const [a, p] = c.split('/'); CLOUDFLARE.addSubnet(a, Number(p), 'ipv6'); });
const isCloudflare = (ip) => {
  const v = net.isIP(ip);
  return v ? CLOUDFLARE.check(ip, v === 4 ? 'ipv4' : 'ipv6') : false;
};

// The visitor's real address for a request.
function clientIp(req) {
  const ip = cleanIp(req.ip);
  if (isCloudflare(ip)) {
    const real = cleanIp(String(req.get('cf-connecting-ip') || '').trim());
    if (net.isIP(real)) return real;
  }
  return ip;
}

// Locations recorded before this fix are Cloudflare's, not the visitor's:
// forget them, so nobody shows up in the wrong country.
async function forgetCloudflareLocations() {
  const { rows } = await query("SELECT DISTINCT ip FROM login_events WHERE ip <> ''");
  const bad = rows.map((r) => r.ip).filter(isCloudflare);
  if (!bad.length) return 0;
  // Users whose location came from one of these, before the events are wiped.
  const { rows: affected } = await query('SELECT DISTINCT user_id FROM login_events WHERE ip = ANY($1)', [bad]);
  await query("UPDATE login_events SET ip = '', city = '', region = '', country = '', country_code = '' WHERE ip = ANY($1)", [bad]);
  const { rowCount } = await query(
    `UPDATE users u SET city = COALESCE(e.city, ''), region = COALESCE(e.region, ''), country = COALESCE(e.country, ''), country_code = COALESCE(e.country_code, '')
       FROM users x LEFT JOIN LATERAL (SELECT city, region, country, country_code FROM login_events
              WHERE user_id = x.id AND country <> '' AND kind <> 'vpn_blocked' ORDER BY created_at DESC, id DESC LIMIT 1) e ON true
      WHERE u.id = x.id AND u.id = ANY($1)`, [affected.map((r) => r.user_id)]);
  return rowCount;
}

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

// VPN / proxy detection for the people the owner has set to "Block VPN".
// proxycheck.io answers without a key (about 1,000 checks a day); set
// PROXYCHECK_KEY for more. If the check can't be done, the person is let in.
const VPN_URL = process.env.VPN_CHECK_URL || 'https://proxycheck.io/v2/{ip}?vpn=1';
const vpnCache = new Map(); // ip -> { at, result }
const VPN_TTL = 6 * 3600 * 1000;

// -> { vpn: true|false, type } or null when unknown.
async function vpnCheck(ip) {
  const addr = cleanIp(ip);
  if (isPrivate(addr)) return { vpn: false, type: 'private' };
  const hit = vpnCache.get(addr);
  if (hit && Date.now() - hit.at < VPN_TTL) return hit.result;
  try {
    let url = VPN_URL.replace('{ip}', encodeURIComponent(addr));
    if (process.env.PROXYCHECK_KEY) url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(process.env.PROXYCHECK_KEY)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const d = await res.json();
    const info = d[addr];
    if (!info || !['ok', 'warning'].includes(d.status)) throw new Error(d.message || d.status || 'no answer');
    const result = { vpn: info.proxy === 'yes', type: String(info.type || '').slice(0, 40) };
    vpnCache.set(addr, { at: Date.now(), result });
    if (vpnCache.size > 5000) vpnCache.delete(vpnCache.keys().next().value);
    return result;
  } catch (err) {
    console.warn(`[geo] VPN check failed for ${addr}: ${err.message}`);
    return null;
  }
}

// Logs an invite acceptance / login / password reset, then fills in where it
// came from and updates the person's last known location.
// vpn: the VPN check's answer (true/false) for people with "Block VPN" on.
// A blocked attempt (kind 'vpn_blocked') doesn't change their last location.
function record(userId, ip, kind, userAgent, vpn = null) {
  const addr = cleanIp(ip);
  (async () => {
    const { rows: [ev] } = await query(
      'INSERT INTO login_events (user_id, ip, kind, user_agent, vpn) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [userId, addr, kind, String(userAgent || '').slice(0, 300), vpn]);
    const loc = await lookup(addr);
    if (!loc) return;
    await query('UPDATE login_events SET city = $1, region = $2, country = $3, country_code = $4 WHERE id = $5',
      [loc.city, loc.region, loc.country, loc.country_code, ev.id]);
    if (kind === 'vpn_blocked') return;
    // Last known location = the most recent event that has one (lookups can finish out of order).
    await query(
      `UPDATE users u SET city = e.city, region = e.region, country = e.country, country_code = e.country_code
         FROM (SELECT city, region, country, country_code FROM login_events
                WHERE user_id = $1 AND country <> '' AND kind <> 'vpn_blocked' ORDER BY created_at DESC, id DESC LIMIT 1) e
        WHERE u.id = $1`, [userId]);
  })().catch((err) => console.error('[geo] record failed:', err.message));
}

module.exports = { record, lookup, vpnCheck, clientIp, isCloudflare, forgetCloudflareLocations };

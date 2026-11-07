// Logos for domain hosts and sequencers, served at /brand-logo/<key>.
// Brands with an official mark in Simple Icons ship as SVGs in public/brands.
// The others are fetched once from the brand's own website (its
// apple-touch-icon or largest favicon) and kept in the settings table, so
// they're the real thing and survive restarts. Until that works, a lettered
// tile in the brand's colour stands in.
const fs = require('fs');
const path = require('path');
const { query } = require('./db');

const STATIC_DIR = path.join(__dirname, 'public', 'brands');
const SITES = {
  instantly: { site: 'instantly.ai', name: 'Instantly', color: '#3f6bff' },
  smartlead: { site: 'smartlead.ai', name: 'Smartlead', color: '#6a5cff' },
  plusvibe: { site: 'plusvibe.ai', name: 'PlusVibe', color: '#7c3aed' },
  dynadot: { site: 'www.dynadot.com', name: 'Dynadot', color: '#0a7ad8' },
  namecom: { site: 'www.name.com', name: 'Name.com', color: '#2c9b5d' },
};
const GENERIC = {
  other: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  manual: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
};
const RETRY_MS = 6 * 3600 * 1000;
const cache = new Map(); // key -> { type, body } (a fetched logo)
const tried = new Map(); // key -> last failed attempt

const monogram = (key) => {
  const s = SITES[key];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="${s.color}"/><text x="20" y="27" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="19" font-weight="700" fill="#fff">${s.name[0]}</text></svg>`;
};

const UA = 'Mozilla/5.0 (compatible; MithmillPortal/1.0; +https://client.mithmill.com)';
async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res;
}
async function image(url) {
  const res = await get(url);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  const body = Buffer.from(await res.arrayBuffer());
  const looksSvg = /svg/.test(type) || /^\s*(<\?xml|<svg)/.test(body.slice(0, 100).toString());
  if (!(type.startsWith('image/') || looksSvg) || body.length < 100 || body.length > 600000) throw new Error('not an image');
  return { type: looksSvg ? 'image/svg+xml' : type, body };
}

// The site's own icons, best first: apple-touch-icon, then the largest icon.
async function fromSite(site) {
  const base = `https://${site}/`;
  const urls = [];
  try {
    const html = (await (await get(base)).text()).slice(0, 300000);
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    const attr = (tag, a) => ((tag.match(new RegExp(`${a}\\s*=\\s*["']([^"']+)["']`, 'i')) || [])[1] || '');
    const icons = links.filter((t) => /icon/i.test(attr(t, 'rel')) && attr(t, 'href')).map((t) => {
      const sizes = attr(t, 'sizes');
      const n = Math.max(0, ...sizes.split(/\s+/).map((x) => Number(x.split('x')[0]) || 0));
      const rank = (/apple-touch/i.test(attr(t, 'rel')) ? 1000 : 0) + (/\.svg/i.test(attr(t, 'href')) ? 500 : 0) + n;
      return { href: new URL(attr(t, 'href'), base).href, rank };
    }).sort((a, b) => b.rank - a.rank);
    urls.push(...icons.map((i) => i.href));
  } catch { /* fall through to the usual paths */ }
  urls.push(`${base}apple-touch-icon.png`, `${base}favicon.svg`, `${base}favicon.png`, `${base}favicon.ico`,
    `https://www.google.com/s2/favicons?domain=${site}&sz=128`);
  for (const u of [...new Set(urls)]) {
    try { return await image(u); } catch { /* next */ }
  }
  throw new Error('no icon found');
}

async function load(key) {
  if (cache.has(key)) return cache.get(key);
  const { rows: [r] } = await query('SELECT value FROM settings WHERE key = $1', [`brand_logo:${key}`]);
  if (r) {
    try { const v = JSON.parse(r.value); const hit = { type: v.type, body: Buffer.from(v.b64, 'base64') }; cache.set(key, hit); return hit; } catch { /* refetch */ }
  }
  if (Date.now() - (tried.get(key) || 0) < RETRY_MS) return null;
  tried.set(key, Date.now());
  try {
    const hit = await fromSite(SITES[key].site);
    cache.set(key, hit);
    await query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [`brand_logo:${key}`, JSON.stringify({ type: hit.type, b64: hit.body.toString('base64') })]);
    console.log(`[logos] ${key}: fetched from ${SITES[key].site} (${hit.type}, ${hit.body.length} bytes)`);
    return hit;
  } catch (err) {
    console.warn(`[logos] ${key}: ${err.message}`);
    return null;
  }
}

async function handler(req, res) {
  const key = String(req.params.key || '').replace(/\.svg$/, '');
  res.set('Cache-Control', 'public, max-age=86400');
  if (/^[a-z]+$/.test(key) && fs.existsSync(path.join(STATIC_DIR, `${key}.svg`))) {
    return res.type('image/svg+xml').sendFile(path.join(STATIC_DIR, `${key}.svg`));
  }
  if (GENERIC[key]) return res.type('image/svg+xml').send(GENERIC[key]);
  if (!SITES[key]) return res.status(404).end();
  const hit = await load(key).catch(() => null);
  if (hit) return res.type(hit.type).send(hit.body);
  res.set('Cache-Control', 'public, max-age=600');
  return res.type('image/svg+xml').send(monogram(key));
}

// Fetch them all in the background at boot, so the first visitor sees them.
function warm() { for (const k of Object.keys(SITES)) load(k).catch(() => {}); }

module.exports = { handler, warm };

const path = require('path');
const fs = require('fs');
const express = require('express');
const crypto = require('crypto');
const C = require('./config');
const store = require('./store');
const queue = require('./queue');
const dns = require('./dns');
const google = require('./google');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ── Basic auth for everything else ──────────────────────────────────────────
app.use((req, res, next) => {
  if (!C.APP_PASSWORD) return next();
  const [type, b64] = (req.headers.authorization || '').split(' ');
  const pass = type === 'Basic' && b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(pass), b = Buffer.from(C.APP_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="DKIM Automator"').status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function parseDomains(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const out = [], invalid = [];
  for (let d of list) {
    d = String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^@/, '');
    if (!d) continue;
    (DOMAIN_RE.test(d) ? out : invalid).push(d);
  }
  return { domains: [...new Set(out)], invalid };
}

// ── API ─────────────────────────────────────────────────────────────────────
app.post('/api/jobs', async (req, res) => {
  const b = req.body || {};
  const { domains, invalid } = parseDomains(b.domains);
  const selector = String(b.selector || 'google').trim().toLowerCase();
  const keyLength = Number(b.keyLength) === 1024 ? 1024 : 2048;
  const dnsProvider = b.dnsProvider === 'manual' ? 'manual' : 'cloudflare';
  const simulate = !!b.simulate;
  const executor = b.executor === 'server' ? 'server' : 'extension';

  if (!b.adminEmail || !/@/.test(b.adminEmail)) return res.status(400).json({ error: 'Google Admin email is required' });
  if (!b.adminPassword && !simulate && executor === 'server') return res.status(400).json({ error: 'Google Admin password is required' });
  if (!domains.length) return res.status(400).json({ error: 'Add at least one valid domain', invalid });
  if (domains.length > 1000) return res.status(400).json({ error: 'Max 1000 domains per job' });
  if (!/^[a-z0-9-]{1,63}$/.test(selector)) return res.status(400).json({ error: 'Selector may only contain letters, digits and hyphens' });
  if (dnsProvider === 'cloudflare' && !simulate) {
    if (!b.cloudflareToken) return res.status(400).json({ error: 'Cloudflare API token is required (or choose Manual DNS)' });
    try { await dns.cloudflareVerifyToken(b.cloudflareToken); }
    catch (e) { return res.status(400).json({ error: `Cloudflare token check failed: ${e.message}` }); }
  }

  const { job, skipped } = queue.createJob({
    adminEmail: b.adminEmail.trim(), adminPassword: b.adminPassword || '', domains,
    dnsProvider, cloudflareToken: b.cloudflareToken, selector, keyLength, regenerate: b.regenerate, simulate, executor,
    recoveryEmail: b.recoveryEmail,
  });
  if (!job.tasks.length) return res.status(409).json({ error: 'All these domains already have an active DKIM job', skipped });
  res.json({ ok: true, job: queue.publicJob(job), skipped, invalid });
});

// Bulk: one line per domain → "admin@x.com, password, domain.com" (password may be empty if
// that account is already signed in to the Chrome running the extension). Grouped per admin.
app.post('/api/jobs/bulk', async (req, res) => {
  const b = req.body || {};
  const groups = new Map(), bad = [];
  String(b.rows || '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const cols = line.split(/[,\t;]/).map(c => c.trim());
    if (cols.length < 2) return bad.push(`line ${i + 1}: expected email, password, domain`);
    const email = cols[0].toLowerCase();
    const domainCols = cols.length === 2 ? [cols[1]] : cols.slice(2);
    const password = cols.length === 2 ? '' : cols[1];
    const { domains, invalid } = parseDomains(domainCols.join(' '));
    if (!/@/.test(email)) return bad.push(`line ${i + 1}: invalid admin email`);
    if (!domains.length) return bad.push(`line ${i + 1}: no valid domain${invalid.length ? ` (${invalid.join(', ')})` : ''}`);
    const g = groups.get(email) || { password: '', domains: [] };
    if (password) g.password = password;
    g.domains.push(...domains);
    groups.set(email, g);
  });
  if (!groups.size) return res.status(400).json({ error: 'No valid rows', bad });
  const selector = String(b.selector || 'google').trim().toLowerCase();
  const keyLength = Number(b.keyLength) === 1024 ? 1024 : 2048;
  const dnsProvider = b.dnsProvider === 'manual' ? 'manual' : 'cloudflare';
  if (!/^[a-z0-9-]{1,63}$/.test(selector)) return res.status(400).json({ error: 'Invalid selector' });
  if (b.recoveryEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.recoveryEmail)) return res.status(400).json({ error: 'Recovery email looks invalid' });
  if (dnsProvider === 'cloudflare' && !b.simulate) {
    if (!b.cloudflareToken) return res.status(400).json({ error: 'Cloudflare API token is required (or choose Manual DNS)' });
    try { await dns.cloudflareVerifyToken(b.cloudflareToken); }
    catch (e) { return res.status(400).json({ error: `Cloudflare token check failed: ${e.message}` }); }
  }
  const created = [], skipped = [];
  for (const [email, g] of groups) {
    const r = queue.createJob({
      adminEmail: email, adminPassword: g.password, domains: [...new Set(g.domains)], dnsProvider,
      cloudflareToken: b.cloudflareToken, selector, keyLength, regenerate: b.regenerate, simulate: !!b.simulate, executor: 'extension',
      recoveryEmail: b.recoveryEmail,
    });
    skipped.push(...r.skipped);
    if (r.job.tasks.length) created.push({ id: r.job.id, tenant: email, domains: r.job.tasks.length });
  }
  res.json({ ok: true, jobs: created, skipped, bad });
});

app.get('/api/jobs', (req, res) => res.json(store.all().map(j => queue.publicJob(j))));

app.get('/api/jobs/:id', (req, res) => {
  const j = store.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  res.json(queue.publicJob(j, true));
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const j = store.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  // optional: update credentials when retrying after an auth problem
  if (req.body && req.body.adminPassword) {
    const { encrypt } = require('./secure');
    j.creds = encrypt(JSON.stringify({ email: j.tenant, password: req.body.adminPassword }));
    google.clearSession(j.tenant);
  }
  res.json({ ok: true, retried: queue.retry(j, req.body && req.body.domain) });
});

// ── Chrome extension agent API ──────────────────────────────────────────────
const MIN_EXTENSION_VERSION = '1.3.0';
const vnum = v => String(v || '0').split('.').map(Number).reduce((a, n) => a * 1000 + (n || 0), 0);

app.post('/api/agent/claim', (req, res) => {
  const { agentId, version } = req.body || {};
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  if (vnum(version) < vnum(MIN_EXTENSION_VERSION)) {
    queue.noteOutdatedAgent(String(agentId).slice(0, 64), version);
    return res.status(426).json({ error: `Outdated extension v${version || '?'}: remove it in chrome://extensions and install the new download from the dashboard` });
  }
  res.json({ item: queue.claim(String(agentId).slice(0, 64), version) });
});

app.post('/api/agent/report', (req, res) => {
  const b = req.body || {};
  if (!b.agentId) return res.status(400).json({ error: 'agentId required' });
  res.json(queue.report(String(b.agentId).slice(0, 64), b));
});

app.get('/api/agent/status', (req, res) => res.json(queue.agentStatus()));

// Extension download, pre-configured with this server's URL and access key
app.get('/extension.zip', (req, res) => {
  const dir = path.join(__dirname, '..', 'extension');
  const files = fs.readdirSync(dir).filter(f => f !== 'config.js').map(f => ({ name: `dkim-automator-extension/${f}`, data: fs.readFileSync(path.join(dir, f)) }));
  const origin = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const cfg = `self.DKIM_DEFAULTS = ${JSON.stringify({ serverUrl: origin, key: C.APP_PASSWORD })};\n`;
  files.push({ name: 'dkim-automator-extension/config.js', data: Buffer.from(cfg) });
  res.type('application/zip').attachment('dkim-automator-extension.zip').send(zip(files));
});

// Minimal ZIP writer (stored, no compression)
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), crc = crc32(f.data), size = f.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 8); cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(size, 20); cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + size;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

// ── Paused Google sign-in (CAPTCHA / verification code / method choice) ─────
app.get('/api/jobs/:id/challenge.png', async (req, res) => {
  const j = store.get(req.params.id);
  if (!j) return res.status(404).end();
  const img = await google.challengeImage(j.tenant);
  if (!img) return res.status(404).end();
  res.set('Cache-Control', 'no-store').type('png').send(img);
});

app.post('/api/jobs/:id/challenge', async (req, res) => {
  const j = store.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  try {
    res.json(await queue.answerChallenge(j, (req.body || {}).answer));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const j = store.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  queue.cancel(j);
  res.json({ ok: true });
});

app.delete('/api/jobs/:id', (req, res) => {
  const j = store.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  queue.cancel(j);
  store.remove(j.id);
  res.json({ ok: true });
});

app.get('/api/jobs/:id/export.csv', (req, res) => {
  const j = store.get(req.params.id);
  if (!j) return res.status(404).send('Not found');
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['domain', 'state', 'type', 'host', 'value', 'error'].join(',')]
    .concat(j.tasks.map(t => [t.domain, t.state, 'TXT', t.hostname, t.txtValue, t.error].map(q).join(',')));
  res.type('text/csv').attachment(`dkim-${j.id}.csv`).send(rows.join('\n'));
});

app.get('/api/dns-check', async (req, res) => {
  const { domains } = parseDomains(req.query.domain);
  if (!domains.length) return res.status(400).json({ error: 'domain required' });
  const selector = String(req.query.selector || 'google');
  const found = await dns.lookupDkim(domains[0], selector);
  res.json({ domain: domains[0], host: `${selector}._domainkey.${domains[0]}`, published: !!found, value: found });
});

app.get('/api/stats', (req, res) => res.json(queue.stats()));

app.get('/api/debug/:file', (req, res) => {
  const f = path.basename(req.params.file);
  const p = path.join(google.DEBUG_DIR, f);
  if (!fs.existsSync(p)) return res.status(404).send('Not found');
  res.sendFile(p);
});

// Prometheus-style metrics
app.get('/metrics', (req, res) => {
  const s = queue.stats();
  const lines = [`dkim_tasks_total ${s.total}`, `dkim_steps_total ${s.steps}`, `dkim_step_failures_total ${s.failures}`, `dkim_running ${s.running}`];
  for (const [k, v] of Object.entries(s.counts)) lines.push(`dkim_tasks{state="${k}"} ${v}`);
  res.type('text/plain').send(lines.join('\n') + '\n');
});

process.on('unhandledRejection', e => console.error('unhandledRejection', e));
process.on('SIGTERM', () => { try { store.flush(); } catch {} process.exit(0); });

queue.start();
app.listen(C.PORT, () => console.log(`DKIM Automator listening on :${C.PORT} (workers=${C.WORKERS})`));

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

  if (!b.adminEmail || !/@/.test(b.adminEmail)) return res.status(400).json({ error: 'Google Admin email is required' });
  if (!b.adminPassword && !simulate) return res.status(400).json({ error: 'Google Admin password is required' });
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
    dnsProvider, cloudflareToken: b.cloudflareToken, selector, keyLength, regenerate: b.regenerate, simulate,
  });
  if (!job.tasks.length) return res.status(409).json({ error: 'All these domains already have an active DKIM job', skipped });
  res.json({ ok: true, job: queue.publicJob(job), skipped, invalid });
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
  }
  res.json({ ok: true, retried: queue.retry(j, req.body && req.body.domain) });
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

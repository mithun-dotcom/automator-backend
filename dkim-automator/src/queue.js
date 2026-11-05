// Durable DKIM job queue.
// Per-domain state machine:
//   queued → (generate in Google) → record_ready → (publish DNS) → waiting_dns
//   → (record visible publicly) → activating → (Start authentication) → active
// Terminal: active, failed, needs_action (auth challenge / manual DNS timeout), cancelled
const crypto = require('crypto');
const store = require('./store');
const google = require('./google');
const dns = require('./dns');
const { encrypt, decrypt } = require('./secure');
const C = require('./config');

const TERMINAL = new Set(['active', 'failed', 'needs_action', 'cancelled']);
const RUNNABLE = new Set(['queued', 'record_ready', 'waiting_dns', 'activating']);
const running = new Set();          // task keys currently executing
const busyTenants = new Set();      // one browser action per tenant at a time
const metrics = { started: Date.now(), steps: 0, failures: 0, activated: 0, durationsMs: [] };

const now = () => Date.now();
const tkey = (job, t) => `${job.id}:${t.domain}`;

function log(job, t, msg, level = 'info') {
  t.log = t.log || [];
  t.log.push({ at: new Date().toISOString(), level, msg });
  if (t.log.length > 60) t.log.splice(0, t.log.length - 60);
  t.updatedAt = now();
  console.log(`[${job.tenant}] ${t.domain}: ${msg}`);
  store.save();
}

function setState(job, t, state, extra = {}) {
  Object.assign(t, extra, { state, updatedAt: now() });
  if (state === 'active') {
    metrics.activated++;
    metrics.durationsMs.push(now() - job.createdAt);
    if (metrics.durationsMs.length > 500) metrics.durationsMs.shift();
  }
  store.save();
}

function activeDomains() {
  const set = new Set();
  for (const j of store.all()) for (const t of j.tasks) if (!TERMINAL.has(t.state)) set.add(t.domain);
  return set;
}

// ── Create ──────────────────────────────────────────────────────────────────
function createJob({ adminEmail, adminPassword, domains, dnsProvider, cloudflareToken, selector, keyLength, regenerate, simulate, executor, recoveryEmail }) {
  const busy = activeDomains();
  const skipped = domains.filter(d => busy.has(d));
  const fresh = domains.filter(d => !busy.has(d));
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    createdAt: now(),
    tenant: adminEmail.toLowerCase(),
    creds: encrypt(JSON.stringify({ email: adminEmail, password: adminPassword || '' })),
    dns: { provider: dnsProvider, token: cloudflareToken ? encrypt(cloudflareToken) : null },
    options: { selector, keyLength, regenerate: !!regenerate, simulate: !!simulate, executor: executor === 'server' ? 'server' : 'extension',
      recoveryEmail: recoveryEmail ? String(recoveryEmail).trim().toLowerCase() : '' },
    cancelled: false,
    tasks: fresh.map(domain => ({
      domain, state: 'queued', attempts: 0, nextRunAt: 0, selector,
      hostname: `${selector}._domainkey.${domain}`, txtValue: null, error: null,
      createdAt: now(), updatedAt: now(), log: [],
    })),
  };
  if (job.tasks.length) store.add(job);
  return { job, skipped };
}

// ── Step execution ──────────────────────────────────────────────────────────
function creds(job) {
  const c = JSON.parse(decrypt(job.creds) || 'null');
  if (!c) throw Object.assign(new Error('Stored credentials can no longer be decrypted (SECRET_KEY changed). Create a new job.'), { kind: 'fatal' });
  return c;
}
const api = job => (job.options.simulate ? google.sim : google);

async function stepGenerate(job, t) {
  setState(job, t, 'queued', { phase: 'generating' });
  const L = m => log(job, t, m);
  const r = await api(job).generate(creds(job), t.domain, job.options, L);
  applyGenerate(job, t, r);
}

function applyGenerate(job, t, r) {
  if (!r.preserved && !/v=DKIM1;.*p=[A-Za-z0-9+/=]{100,}/.test(r.txtValue || '') && !job.options.simulate)
    throw new Error('Did not get a valid DKIM TXT value from Google' + (r.txtValue ? `: ${String(r.txtValue).slice(0, 80)}` : ''));
  const selector = r.selector || job.options.selector;
  Object.assign(t, { txtValue: r.txtValue, selector, hostname: `${selector}._domainkey.${t.domain}`, googleStatus: r.status });
  if (r.preserved) {
    log(job, t, 'DKIM already authenticating in Google — kept existing configuration');
    return setState(job, t, 'active', { phase: null });
  }
  log(job, t, `Record ready: ${t.hostname}`);
  setState(job, t, 'record_ready', { phase: null, attempts: 0 });
}

async function stepPublish(job, t) {
  if (job.options.simulate) {
    log(job, t, '[simulate] DNS publish skipped');
  } else if (job.dns.provider === 'cloudflare') {
    const token = decrypt(job.dns.token);
    if (!token) throw Object.assign(new Error('Cloudflare token unavailable'), { kind: 'fatal' });
    const r = await dns.cloudflareUpsertTxt(token, t.domain, t.selector, t.txtValue);
    log(job, t, `Cloudflare TXT record ${r.action}`);
  } else {
    log(job, t, 'Manual DNS: add the TXT record shown, waiting for it to appear');
  }
  setState(job, t, 'waiting_dns', { dnsSince: now(), nextRunAt: now() + 5000, attempts: 0 });
}

async function stepWaitDns(job, t) {
  if (job.options.simulate) {
    t.simPolls = (t.simPolls || 0) + 1;
    if (t.simPolls < 2) { t.nextRunAt = now() + 4000; return log(job, t, '[simulate] DNS not visible yet'); }
  } else {
    // TEST_DNS_ALWAYS_OK is only for automated tests (never set it in production)
    const r = process.env.TEST_DNS_ALWAYS_OK === '1' ? { match: true } : await dns.isPublished(t.domain, t.selector, t.txtValue);
    if (!r.match) {
      const waited = now() - (t.dnsSince || now());
      if (waited > C.DNS_WAIT_HOURS * 3600e3) {
        return setState(job, t, 'needs_action', { error: `TXT record not visible in public DNS after ${C.DNS_WAIT_HOURS}h${r.found ? ' (a different DKIM value is published)' : ''}` });
      }
      t.nextRunAt = now() + C.DNS_POLL_SECONDS * 1000;
      t.dnsChecks = (t.dnsChecks || 0) + 1;
      if (t.dnsChecks % 5 === 1) log(job, t, r.found ? 'Public DNS shows a different DKIM value, waiting for propagation' : 'TXT record not visible yet');
      return store.save();
    }
  }
  log(job, t, 'TXT record verified in public DNS');
  setState(job, t, 'activating', { nextRunAt: 0, attempts: 0, activationSince: now() });
}

async function stepActivate(job, t) {
  const r = await api(job).startAuthentication(creds(job), t.domain, m => log(job, t, m));
  applyActivate(job, t, r);
}

function applyActivate(job, t, r) {
  if (r.status === 'authenticating') {
    log(job, t, '✓ DKIM authentication started — Google is signing mail');
    return setState(job, t, 'active', { error: null });
  }
  throw Object.assign(new Error('Status did not change to authenticating'), { kind: 'activation' });
}

const usesExtension = job => job.options.executor === 'extension' && !job.options.simulate;

const STEPS = { queued: stepGenerate, record_ready: stepPublish, waiting_dns: stepWaitDns, activating: stepActivate };
const needsBrowser = s => s === 'queued' || s === 'activating';

function handleError(job, t, e) {
  metrics.failures++;
  t.attempts = (t.attempts || 0) + 1;
  t.phase = null;
  const msg = e.message || String(e);
  log(job, t, msg, 'error');
  if (e.kind === 'auth') {
    // stop every pending task of this tenant: they would hit the same challenge
    for (const other of job.tasks) if (!TERMINAL.has(other.state) && (other.state === 'queued' || other.state === 'activating'))
      setState(job, other, 'needs_action', { error: msg, resumeState: other.state });
    return;
  }
  if (e.kind === 'fatal' || e.permanent) return setState(job, t, 'failed', { error: msg, resumeState: t.state });
  if (e.kind === 'wait' || (e.kind === 'activation' && t.state === 'activating')) {
    const since = t.activationSince || t.createdAt;
    if (now() - since > C.GOOGLE_WAIT_HOURS * 3600e3) return setState(job, t, 'failed', { error: msg, resumeState: t.state });
    t.error = msg;
    t.nextRunAt = now() + C.GOOGLE_WAIT_RETRY_MINUTES * 60e3;
    return store.save();
  }
  if (t.attempts >= C.MAX_ATTEMPTS) return setState(job, t, 'failed', { error: msg, resumeState: t.state });
  t.error = msg;
  t.nextRunAt = now() + Math.min(30e3 * 2 ** (t.attempts - 1), 10 * 60e3); // 30s, 60s, 120s ... max 10m
  store.save();
}

async function run(job, t) {
  const key = tkey(job, t);
  const browserStep = needsBrowser(t.state);
  running.add(key);
  if (browserStep) busyTenants.add(job.tenant);
  const started = now();
  try {
    metrics.steps++;
    await STEPS[t.state](job, t);
    if (t.state !== 'waiting_dns') t.error = null;
  } catch (e) {
    handleError(job, t, e);
  } finally {
    running.delete(key);
    if (browserStep) busyTenants.delete(job.tenant);
    t.lastStepMs = now() - started;
    store.save();
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────
function tick() {
  let slots = C.WORKERS;
  // count browser steps in flight
  let inflight = 0;
  for (const j of store.all()) for (const t of j.tasks) if (running.has(tkey(j, t)) && needsBrowser(t.state)) inflight++;
  slots -= inflight;

  // oldest jobs first
  const jobs = [...store.all()].sort((a, b) => a.createdAt - b.createdAt);
  for (const job of jobs) {
    if (job.cancelled) continue;
    for (const t of job.tasks) {
      if (t.lease && t.lease.until < now()) {
        const step = t.state;
        t.lease = null;
        handleError(job, t, new Error(`Chrome extension stopped responding during ${step === 'queued' ? 'key generation' : 'activation'}`));
      }
      if (!RUNNABLE.has(t.state) || running.has(tkey(job, t)) || (t.nextRunAt || 0) > now()) continue;
      if (needsBrowser(t.state) && usesExtension(job)) continue;
      if (needsBrowser(t.state)) {
        if (slots <= 0 || busyTenants.has(job.tenant)) continue;
        slots--;
        busyTenants.add(job.tenant); // reserve immediately
      }
      run(job, t);
    }
  }
}

function start() {
  // Recovery: nothing is "running" after a restart; phases are cleared and tasks re-run their step.
  for (const j of store.all()) for (const t of j.tasks) { t.phase = null; }
  store.save();
  setInterval(tick, 1500);
}

// ── Controls ────────────────────────────────────────────────────────────────
function retry(job, domain) {
  let n = 0;
  for (const t of job.tasks) {
    if (domain && t.domain !== domain) continue;
    if (!['failed', 'needs_action', 'cancelled'].includes(t.state) && !(t.error && RUNNABLE.has(t.state))) continue;
    let s = t.resumeState && RUNNABLE.has(t.resumeState) ? t.resumeState : (t.txtValue ? 'record_ready' : 'queued');
    if (t.state === 'needs_action' && s === 'waiting_dns') t.dnsSince = now();
    if (s === 'activating') t.activationSince = now();
    Object.assign(t, { state: s, attempts: 0, nextRunAt: 0, error: null, lease: null });
    n++;
  }
  if (n) google.resetChallenge(job.tenant);
  job.cancelled = false;
  store.save();
  return n;
}

function cancel(job) {
  job.cancelled = true;
  for (const t of job.tasks) if (!TERMINAL.has(t.state)) Object.assign(t, { resumeState: t.state, state: 'cancelled', lease: null });
  store.save();
}

function publicJob(job, withLogs = false) {
  const counts = {};
  for (const t of job.tasks) counts[t.state] = (counts[t.state] || 0) + 1;
  return {
    id: job.id, createdAt: job.createdAt, tenant: job.tenant, dnsProvider: job.dns.provider,
    options: job.options, cancelled: job.cancelled, counts, total: job.tasks.length,
    tasks: job.tasks.map(t => ({
      domain: t.domain, state: t.state,
      phase: t.lease ? 'working in Chrome' : t.phase || (running.has(tkey(job, t)) ? 'working'
        : (usesExtension(job) && needsBrowser(t.state) && !agentOnline() ? 'waiting for Chrome extension' : null)),
      hostname: t.hostname, selector: t.selector, txtValue: t.txtValue, error: t.error, attempts: t.attempts,
      nextRunAt: t.nextRunAt, updatedAt: t.updatedAt, ...(withLogs ? { log: t.log } : {}),
    })),
    challenge: job.options.simulate || !job.tasks.some(t => t.state === 'needs_action') ? null : google.challengeState(job.tenant),
  };
}

function stats() {
  const counts = {};
  let total = 0;
  for (const j of store.all()) for (const t of j.tasks) { counts[t.state] = (counts[t.state] || 0) + 1; total++; }
  const d = metrics.durationsMs;
  const avg = d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length / 1000) : null;
  const done = (counts.active || 0) + (counts.failed || 0) + (counts.needs_action || 0);
  return {
    total, counts, workers: C.WORKERS, running: running.size,
    successRate: done ? Math.round(((counts.active || 0) / done) * 100) : null,
    avgSecondsToActive: avg, steps: metrics.steps, failures: metrics.failures,
    uptimeSeconds: Math.round((now() - metrics.started) / 1000),
  };
}

// ── Chrome extension agent ──────────────────────────────────────────────────
// The extension polls /api/agent/claim, performs one Google Admin step in the user's own
// signed-in Chrome, and posts the outcome to /api/agent/report.
const LEASE_MS = 7 * 60 * 1000; // covers waiting up to ~4 min for the admin to finish a Google check
const agents = new Map(); // agentId -> { lastSeen, version, current }

function touchAgent(agentId, version) {
  const a = agents.get(agentId) || {};
  agents.set(agentId, { ...a, lastSeen: now(), version });
}
function agentOnline() {
  return [...agents.values()].some(a => now() - a.lastSeen < 90e3);
}
const outdated = new Map(); // agentId -> { lastSeen, version }
function noteOutdatedAgent(agentId, version) { outdated.set(agentId, { lastSeen: now(), version }); }
function agentStatus() {
  const list = [...agents.entries()].map(([id, a]) => ({ id, ...a, online: now() - a.lastSeen < 90e3 }));
  const old = [...outdated.values()].filter(a => now() - a.lastSeen < 120e3).map(a => a.version || '?');
  return { connected: list.some(a => a.online), agents: list, outdated: old };
}

function claim(agentId, version) {
  touchAgent(agentId, version);
  const jobs = [...store.all()].sort((a, b) => a.createdAt - b.createdAt);
  // one Google action per tenant at a time
  const leasedTenants = new Set();
  for (const j of jobs) for (const t of j.tasks) if (t.lease && t.lease.until > now()) leasedTenants.add(j.tenant);
  for (const job of jobs) {
    if (job.cancelled || !usesExtension(job) || leasedTenants.has(job.tenant)) continue;
    for (const t of job.tasks) {
      if (!needsBrowser(t.state) || (t.nextRunAt || 0) > now() || (t.lease && t.lease.until > now())) continue;
      const action = t.state === 'queued' ? 'generate' : 'activate';
      t.lease = { agentId, until: now() + LEASE_MS, action };
      let password = '';
      try { password = (JSON.parse(decrypt(job.creds) || '{}').password) || ''; } catch {}
      // sign out afterwards only if nothing else for this Google account is ready right now
      const more = jobs.some(j2 => j2.tenant === job.tenant && !j2.cancelled && j2.tasks.some(t2 =>
        t2 !== t && needsBrowser(t2.state) && (t2.nextRunAt || 0) <= now() + 60e3));
      log(job, t, action === 'generate' ? 'Chrome extension: generating DKIM key' : 'Chrome extension: starting authentication');
      agents.get(agentId).current = `${action} ${t.domain}`;
      return {
        jobId: job.id, domain: t.domain, action, tenant: job.tenant,
        selector: job.options.selector, keyLength: job.options.keyLength, regenerate: job.options.regenerate,
        password, signOutAfter: !more, recoveryEmail: job.options.recoveryEmail || '',
      };
    }
  }
  agents.get(agentId).current = null;
  return null;
}

function report(agentId, b) {
  touchAgent(agentId);
  const job = store.get(b.jobId);
  const t = job && job.tasks.find(x => x.domain === b.domain);
  if (!t || !t.lease || t.lease.agentId !== agentId) return { ok: false, error: 'No matching claimed task (it may have expired)' };
  const expected = t.state === 'queued' ? 'generate' : 'activate';
  t.lease = null;
  if (b.action !== expected) return { ok: false, error: 'Task state changed' };
  if (Array.isArray(b.log)) for (const m of b.log.slice(0, 20)) log(job, t, `Chrome: ${String(m).slice(0, 300)}`);
  if (b.ok) {
    try {
      if (b.action === 'generate') applyGenerate(job, t, b.result || {});
      else applyActivate(job, t, b.result || {});
      t.error = null;
      metrics.steps++;
    } catch (e) { handleError(job, t, e); }
  } else {
    let msg = String(b.error || 'Chrome extension step failed');
    if (b.debug) {
      log(job, t, `Page debug: ${JSON.stringify(b.debug).slice(0, 1500)}`, 'error');
    }
    const err = Object.assign(new Error(msg), { kind: b.kind || undefined });
    if (err.kind === 'auth' && /wrong password/i.test(msg)) err.message += ' — press Retry and enter the correct password';
    else if (err.kind === 'auth') err.message += /sign in|retry/i.test(msg) ? (/retry/i.test(msg) ? '' : ', then press Retry') : ' — sign in to admin.google.com with this account in the Chrome running the extension, then press Retry';
    handleError(job, t, err);
  }
  store.save();
  return { ok: true, state: t.state };
}

// Admin answered a paused Google sign-in (CAPTCHA / code / choice).
async function answerChallenge(job, answer) {
  const c = creds(job);
  const L = m => console.log(`[${job.tenant}] sign-in: ${m}`);
  try {
    await google.answerChallenge(c, answer, L);
  } catch (e) {
    if (e.challenge) return { loggedIn: false, challenge: google.challengeState(job.tenant) || e.challenge };
    throw e;
  }
  // signed in: resume every task of this tenant that was stopped for sign-in
  let resumed = 0;
  for (const j of store.all()) {
    if (j.tenant !== job.tenant) continue;
    for (const t of j.tasks) {
      if (t.state !== 'needs_action' || !t.resumeState || !['queued', 'activating'].includes(t.resumeState)) continue;
      Object.assign(t, { state: t.resumeState, attempts: 0, nextRunAt: 0, error: null });
      log(j, t, 'Google sign-in completed by admin, resuming');
      resumed++;
    }
  }
  store.save();
  return { loggedIn: true, resumed };
}

module.exports = { createJob, start, retry, cancel, publicJob, stats, answerChallenge, claim, report, agentStatus, noteOutdatedAgent, TERMINAL };

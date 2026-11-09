// Background queue that connects mailboxes to sequencers, one at a time (a
// headless browser uses a few hundred MB, so never two at once). Each job's
// outcome goes on mailbox_connections (what the client sees) and on the job
// itself (with the step and on-screen details of a failure, for fixing).
const { query } = require('./db');
const onboarding = require('./onboarding');
const signin = require('./signin');
const sequencers = require('./sequencers');
const dnscheck = require('./dnscheck');

const JOB_TIMEOUT = 4 * 60 * 1000;
let busy = false;
let timer = null;

// consentUrl: for consent-based sequencers (PlusVibe), the sign-in link the
// client opens; stored encrypted and cleared on any other status.
const setConn = (mailboxId, sequencerId, status, error = '', consentUrl = null) => query(
  `INSERT INTO mailbox_connections (mailbox_id, sequencer_id, status, error, updated_at, consent_url, consent_at)
   VALUES ($1, $2, $3, $4, now(), $5, CASE WHEN $5::bytea IS NULL THEN NULL ELSE now() END)
   ON CONFLICT (mailbox_id, sequencer_id) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, updated_at = now(),
     consent_url = EXCLUDED.consent_url, consent_at = EXCLUDED.consent_at`,
  [mailboxId, sequencerId, status, String(error).slice(0, 500), consentUrl ? onboarding.encrypt(consentUrl) : null]);

// Google or Microsoft: what the domain's MX records say (that's where the
// mailbox really lives), else the mailbox's type.
async function providerOf(m) {
  const { rows: [d] } = await query("SELECT dns->>'detected' AS detected FROM domains WHERE user_id = $1 AND domain = lower(split_part($2, '@', 2))", [m.user_id, m.email]);
  if (d && ['google', 'microsoft'].includes(d.detected)) return d.detected;
  return m.inbox_type ? dnscheck.providerOf({ inbox_type: m.inbox_type, label: m.inbox_label }) : null;
}

// Adds jobs for these mailboxes (skipping ones already connected or waiting).
async function enqueue(userId, sequencerId, mailboxIds, { retry = false } = {}) {
  let added = 0;
  for (const id of mailboxIds) {
    const { rows: [c] } = await query('SELECT status FROM mailbox_connections WHERE mailbox_id = $1 AND sequencer_id = $2', [id, sequencerId]);
    if (c && ['queued', 'running'].includes(c.status)) continue;
    if (c && c.status === 'authorize' && !retry) continue;
    if (c && c.status === 'connected' && !retry) continue;
    await query('INSERT INTO connect_jobs (user_id, sequencer_id, mailbox_id) VALUES ($1, $2, $3)', [userId, sequencerId, id]);
    await setConn(id, sequencerId, 'queued');
    added += 1;
  }
  kick();
  return added;
}

async function runJob(job) {
  const step = (s) => { job.step = s; query('UPDATE connect_jobs SET step = $2 WHERE id = $1', [job.id, s]).catch(() => {}); };
  const { rows: [seq] } = await query('SELECT * FROM sequencer_accounts WHERE id = $1', [job.sequencer_id]);
  const { rows: [m] } = await query(
    'SELECT m.*, p.label AS inbox_label FROM mailboxes m LEFT JOIN pricing p ON p.inbox_type = m.inbox_type WHERE m.id = $1', [job.mailbox_id]);
  if (!seq || !m) throw new sequencers.SeqError('The sequencer or mailbox was removed');
  const provider = sequencers.PROVIDERS[seq.provider];
  if (!provider || (!provider.connect && !provider.consent)) throw new sequencers.SeqError('This sequencer is CSV-only');
  const kind = await providerOf(m);
  if (!kind) throw new sequencers.SeqError('Unknown mailbox type: set it to a Google or Microsoft type (Mailboxes → type) and retry');
  const creds = JSON.parse(onboarding.decrypt(seq.creds));
  if (provider.consent) {
    // API only: no browser, no mailbox password. Returns { authorizeUrl } or { note } when already connected.
    if (provider.restricted && !(await allowedUser(seq.user_id, seq.provider))) throw new sequencers.SeqError('Coming soon for this account');
    return provider.startConsent({ creds, mailbox: { email: m.email, provider: kind }, step });
  }
  const mailbox = { email: m.email, password: onboarding.decrypt(m.password), provider: kind };

  step('Starting browser');
  const browser = await signin.launch();
  let page;
  try {
    page = await signin.newPage(browser);
    const work = provider.connect({ creds, mailbox, page, step });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new sequencers.SeqError(`Timed out at "${job.step}"`)), JOB_TIMEOUT));
    return await Promise.race([work, timeout]);
  } catch (err) {
    if (!err.diag && page) err.diag = await signin.diag(page);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const { rows: [job] } = await query(
        `UPDATE connect_jobs SET status = 'running', started_at = now(), attempts = attempts + 1
          WHERE id = (SELECT id FROM connect_jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`);
      if (!job) { await verifyConsents(); break; }
      await setConn(job.mailbox_id, job.sequencer_id, 'running');
      try {
        const result = await runJob(job) || {};
        if (result.authorizeUrl) {
          // Waiting for the client to open the link and click Allow; verifyConsents() confirms it.
          await query("UPDATE connect_jobs SET status = 'done', step = $2, error = $3, finished_at = now() WHERE id = $1", [job.id, job.step || '', 'Sign-in link ready; waiting for approval']);
          await setConn(job.mailbox_id, job.sequencer_id, 'authorize', result.note || '', result.authorizeUrl);
          continue;
        }
        await query("UPDATE connect_jobs SET status = 'done', step = $2, error = $3, finished_at = now() WHERE id = $1", [job.id, job.step || '', result.note || '']);
        await setConn(job.mailbox_id, job.sequencer_id, 'connected', result.note || '');
        await query('UPDATE sequencer_accounts SET last_ok_at = now() WHERE id = $1', [job.sequencer_id]);
      } catch (err) {
        const msg = String(err.message || err).slice(0, 500);
        console.warn(`[connect] job ${job.id} failed at "${job.step || ''}": ${msg}`);
        await query("UPDATE connect_jobs SET status = 'failed', step = $2, error = $3, diag = $4, finished_at = now() WHERE id = $1",
          [job.id, job.step || '', msg, err.diag ? JSON.stringify(err.diag) : null]);
        await setConn(job.mailbox_id, job.sequencer_id, 'failed', msg);
      }
    }
  } catch (err) {
    console.error('[connect] queue error:', err);
  } finally {
    busy = false;
  }
}

async function allowedUser(userId, providerKey) {
  const { rows: [u] } = await query('SELECT email FROM users WHERE id = $1', [userId]);
  return Boolean(u) && sequencers.allowed(providerKey, u.email);
}

// Mailboxes waiting for the client's approval: ask the sequencer (one call per
// domain) and mark them connected only when it reports the mailbox ACTIVE.
// Links not used within LINK_TTL fail with "Retry for a new link".
const LINK_TTL_MS = 24 * 3600 * 1000;
const VERIFY_EVERY_MS = 10000;
let lastVerify = 0;
async function verifyConsents({ force = false } = {}) {
  if (!force && Date.now() - lastVerify < VERIFY_EVERY_MS) return;
  lastVerify = Date.now();
  const { rows } = await query(
    `SELECT c.mailbox_id, c.sequencer_id, c.consent_at, lower(m.email) AS email, s.provider, s.creds
       FROM mailbox_connections c JOIN mailboxes m ON m.id = c.mailbox_id JOIN sequencer_accounts s ON s.id = c.sequencer_id
      WHERE c.status = 'authorize'`);
  const bySeq = new Map();
  for (const r of rows) bySeq.set(r.sequencer_id, [...(bySeq.get(r.sequencer_id) || []), r]);
  for (const [seqId, list] of bySeq) {
    const provider = sequencers.PROVIDERS[list[0].provider];
    if (!provider || !provider.verify) continue;
    let accounts;
    try {
      accounts = await provider.verify(JSON.parse(onboarding.decrypt(list[0].creds)), list.map((r) => r.email));
    } catch (err) {
      console.warn(`[connect] verify sequencer ${seqId} failed: ${err.message}`);
      continue; // keep waiting; the next check tries again
    }
    for (const r of list) {
      const acc = accounts.get(r.email);
      if (acc && String(acc.status).toUpperCase() === 'ACTIVE') {
        await setConn(r.mailbox_id, seqId, 'connected', acc.id ? `Connected (${provider.name.replace(/ \(beta\)$/, '')} id ${acc.id})` : 'Connected');
        await query('UPDATE sequencer_accounts SET last_ok_at = now() WHERE id = $1', [seqId]);
      } else if (r.consent_at && Date.now() - new Date(r.consent_at).getTime() > LINK_TTL_MS) {
        await setConn(r.mailbox_id, seqId, 'failed', 'The sign-in link wasn\'t approved within 24 hours. Retry for a new link');
      } else if (acc) {
        await query('UPDATE mailbox_connections SET error = $3 WHERE mailbox_id = $1 AND sequencer_id = $2 AND status = \'authorize\'',
          [r.mailbox_id, seqId, `${provider.name.replace(/ \(beta\)$/, '')} shows it as ${acc.status}. Authorize again if it stays like this`]);
      }
    }
  }
}

function kick() { setImmediate(() => { tick(); }); }

// Jobs interrupted by a restart go back in the queue (twice at most).
async function start() {
  if (process.env.CONNECT_WORKER === 'off') return;
  await query("UPDATE connect_jobs SET status = 'queued' WHERE status = 'running' AND attempts < 2");
  const { rows } = await query("UPDATE connect_jobs SET status = 'failed', error = 'Interrupted by a server restart', finished_at = now() WHERE status = 'running' RETURNING mailbox_id, sequencer_id");
  for (const r of rows) await setConn(r.mailbox_id, r.sequencer_id, 'failed', 'Interrupted by a server restart. Retry');
  await query("UPDATE mailbox_connections c SET status = 'queued' FROM connect_jobs j WHERE j.mailbox_id = c.mailbox_id AND j.sequencer_id = c.sequencer_id AND j.status = 'queued'");
  timer = setInterval(tick, 15000);
  kick();
}

module.exports = { enqueue, start, kick, verifyConsents, timer: () => timer };

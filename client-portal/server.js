const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool, query, migrate } = require('./db');
const { sendMail, enabled: mailEnabled } = require('./mailer');
const billing = require('./billing');
const onboarding = require('./onboarding');
const audit = require('./audit');
const emailTemplate = require('./emailTemplate');
const brands = require('./brands');
const policy = require('./reseller-policy');
const agreementPdf = require('./agreementPdf');
const geo = require('./geo');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET;
const IS_PROD = process.env.NODE_ENV === 'production';
const INVITE_DAYS = 7;

if (!SESSION_SECRET) {
  console.error('SESSION_SECRET is not set');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
// Large enough for an onboarding CSV of a few thousand mailboxes.
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// ---------------------------------------------------------------- helpers

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const str = (v, max = 5000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const baseUrl = (req) => APP_URL || `${req.protocol}://${req.get('host')}`;

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, SESSION_SECRET, { expiresIn: '14d' });
  res.cookie('session', token, {
    httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 14 * 86400000,
  });
}

const auth = asyncRoute(async (req, res, next) => {
  if (req.user) return next();
  let uid;
  try {
    uid = jwt.verify(req.cookies.session || '', SESSION_SECRET).uid;
  } catch {
    throw new HttpError(401, 'Please log in');
  }
  const { rows: [user] } = await query(
    'SELECT id, email, name, company, role, separated, block_vpn FROM users WHERE id = $1', [uid],
  );
  if (!user) throw new HttpError(401, 'Please log in');
  if (user.role === 'reseller') await assertResellerActive(user.id);
  if (user.block_vpn) await assertNoVpn(req);
  delete user.block_vpn;
  req.user = user;
  next();
});

// "Block VPN" (set by the owner per person on the Locations page or when
// inviting): over a VPN or proxy they can't accept an invite, log in or use the
// portal, so their real location is recorded. Returns the check's answer.
const VPN_MESSAGE = 'VPN detected. Please turn off your VPN or proxy to connect, then try again.';
async function assertNoVpn(req, userId) {
  const check = await geo.vpnCheck(req.ip);
  if (check && check.vpn) {
    if (userId) geo.record(userId, req.ip, 'vpn_blocked', req.get('user-agent'), true);
    throw new HttpError(403, VPN_MESSAGE, 'vpn');
  }
  return check ? false : null;
}

// The owner can turn a reseller's access off; they can't log in or use the portal then.
async function assertResellerActive(id) {
  const { rows: [r] } = await query('SELECT active FROM resellers WHERE user_id = $1', [id]);
  if (!r || !r.active) throw new HttpError(403, 'Your reseller access is turned off. Please contact MithMill.');
}

// Team members ("staff") use the admin panel; the owner ("admin") also
// manages the team and settings.
const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'staff') return next(new HttpError(403, 'Admins only'));
  next();
};
const ownerOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Only the account owner can do this'));
  next();
};

// Only JSON bodies are accepted for writes. Combined with SameSite=Lax cookies
// this blocks cross-site form posts.
app.use('/api', (req, res, next) => {
  const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && hasBody && !req.is('application/json')) {
    return next(new HttpError(415, 'JSON required'));
  }
  next();
});

// Basic brute-force protection for login: 10 attempts per email+IP per 15 min.
const loginAttempts = new Map();
function checkLoginRate(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.start > 15 * 60000) {
    loginAttempts.set(key, { start: now, count: 1 });
    return;
  }
  entry.count += 1;
  if (entry.count > 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
}

// ---------------------------------------------------------------- auth

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  checkLoginRate(`${email}|${req.ip}`);
  const { rows: [user] } = await query('SELECT * FROM users WHERE email = $1', [email]);
  if (!user || !user.password_set || !(await bcrypt.compare(password, user.password_hash))) {
    throw new HttpError(401, 'Wrong email or password');
  }
  loginAttempts.delete(`${email}|${req.ip}`);
  if (user.role === 'reseller') await assertResellerActive(user.id);
  const vpn = user.block_vpn ? await assertNoVpn(req, user.id) : null;
  setSession(res, user);
  geo.record(user.id, req.ip, 'login', req.get('user-agent'), vpn);
  res.json({ ok: true, role: user.role });
}));

// "Forgot password?": emails a reset link (valid for 1 hour) to anyone with a
// working login. The answer is the same whether or not the email has an
// account, so it can't be used to find out who's a client.
const RESET_MINUTES = 60;
const lastReset = new Map();
app.post('/api/auth/forgot', asyncRoute(async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  checkLoginRate(`forgot|${req.ip}`);
  const done = () => res.json({ ok: true });
  // At most one reset email per address every 2 minutes.
  if (Date.now() - (lastReset.get(email) || 0) < 2 * 60000) return done();
  const { rows: [user] } = await query('SELECT id, email, name, role, password_set FROM users WHERE email = $1', [email]);
  // Not-yet-joined clients (and resellers' clients, who don't log in) need an invite, not a reset.
  if (!user || !user.password_set) return done();
  if (user.role === 'reseller') {
    const { rows: [r] } = await query('SELECT active FROM resellers WHERE user_id = $1', [user.id]);
    if (!r || !r.active) return done();
  }
  lastReset.set(email, Date.now());
  const token = crypto.randomBytes(24).toString('base64url');
  await query('DELETE FROM invites WHERE email = $1 AND accepted_at IS NULL', [email]);
  await query(
    `INSERT INTO invites (email, name, company, token, expires_at, role)
     VALUES ($1, $2, '', $3, now() + interval '${RESET_MINUTES} minutes', $4)`,
    [email, user.name || '', token, user.role]);
  const link = `${baseUrl(req)}/#/invite/${token}`;
  await sendMail({
    to: email,
    subject: 'Reset your MithMill portal password',
    text: `Hi ${user.name || 'there'},\n\nWe received a request to reset the password for your MithMill portal account.\n\n` +
      `Set a new password here (the link works for ${RESET_MINUTES} minutes):\n\n${link}\n\n` +
      'If you didn\'t ask for this, you can ignore this email. Your password stays the same.\n\nMithmill',
    heading: 'Reset your password',
    cta: { label: 'Set a new password', url: link },
    reason: 'You receive this because someone asked to reset the password for this email on the MithMill portal.',
  });
  done();
}));

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

app.post('/api/auth/password', auth, asyncRoute(async (req, res) => {
  const current = typeof req.body.current === 'string' ? req.body.current : '';
  const next = typeof req.body.password === 'string' ? req.body.password : '';
  checkLoginRate(`pw|${req.user.id}`);
  if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
  const { rows: [user] } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(current, user.password_hash))) throw new HttpError(400, 'Current password is wrong');
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(next, 10), req.user.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- invites

async function findInvite(token) {
  const { rows: [invite] } = await query(
    'SELECT * FROM invites WHERE token = $1 AND accepted_at IS NULL AND expires_at > now()',
    [str(token, 100)],
  );
  if (!invite) throw new HttpError(404, 'This link is invalid or has expired. Use "Forgot password?" on the login page to get a new one, or ask Mithmill.');
  return invite;
}

app.get('/api/invites/:token', asyncRoute(async (req, res) => {
  const invite = await findInvite(req.params.token);
  const { rows: [existing] } = await query('SELECT password_set FROM users WHERE email = $1', [invite.email]);
  res.json({ email: invite.email, name: invite.name, company: invite.company, reset: Boolean(existing && existing.password_set) });
}));

app.post('/api/invites/:token/accept', asyncRoute(async (req, res) => {
  const invite = await findInvite(req.params.token);
  const { rows: [before] } = await query('SELECT id, password_set, block_vpn FROM users WHERE email = $1', [invite.email]);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const blockVpn = invite.block_vpn || Boolean(before && before.block_vpn);
  const vpn = blockVpn ? await assertNoVpn(req, before && before.id) : null;
  const name = str(req.body.name, 200) || invite.name;
  const hash = await bcrypt.hash(password, 10);

  const { rows: [user] } = await query(
    `INSERT INTO users (email, name, company, password_hash, role, sold_by, added_by, separated, block_vpn) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_set = true,
       block_vpn = users.block_vpn OR EXCLUDED.block_vpn,
       name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE users.name END,
       sold_by = CASE WHEN users.sold_by = '' THEN EXCLUDED.sold_by ELSE users.sold_by END,
       added_by = COALESCE(users.added_by, EXCLUDED.added_by)
     RETURNING *`,
    [invite.email, name, invite.company, hash, ['staff', 'reseller'].includes(invite.role) ? invite.role : 'client', invite.sold_by || '',
      invite.role === 'client' ? invite.added_by : null, invite.role === 'staff' && invite.separated, blockVpn],
  );
  await query('UPDATE invites SET accepted_at = now() WHERE id = $1', [invite.id]);
  geo.record(user.id, req.ip, before && before.password_set ? 'reset' : 'invite', req.get('user-agent'), vpn);
  setSession(res, user);
  res.json({ ok: true, role: user.role });
}));

// ---------------------------------------------------------------- client

// Standard prices with this client's overrides applied.
const CLIENT_PRICING_SQL = `
  SELECT p.inbox_type, p.label, p.description, p.active, p.needs_domains, COALESCE(cp.price_per_mailbox, p.price_per_mailbox) AS price_per_mailbox
    FROM pricing p
    LEFT JOIN client_pricing cp ON cp.inbox_type = p.inbox_type AND cp.user_id = $1`;

const ORDER_COLUMNS = `o.id, o.inbox_type, p.label AS inbox_label, o.quantity, o.price_per_mailbox,
  o.domains, o.usernames, o.domain_access_method, o.registrar, o.registrar_email, o.domain_access_notes,
  o.sequencer, o.sequencer_workspace, o.sequencer_email, o.sequencer_notes, o.notes, o.status,
  o.activated_at, o.next_billing_date, o.created_at, o.batch_name, o.billing_months, o.domain_invited, o.sequencer_invited`;

app.get('/api/dashboard', auth, asyncRoute(async (req, res) => {
  const uid = req.user.id;
  const settings = await getSettings();
  const [orders, invoices, notifications, pricing] = await Promise.all([
    query(`SELECT ${ORDER_COLUMNS}, (SELECT row_count FROM order_files f WHERE f.order_id = o.id) AS csv_rows
           FROM orders o JOIN pricing p ON p.inbox_type = o.inbox_type
           WHERE o.user_id = $1 ORDER BY o.created_at DESC`, [uid]),
    query(`SELECT id, order_id, description, amount, issue_date, due_date, status, paid_at, created_at
           FROM invoices WHERE user_id = $1 AND status <> 'void' ORDER BY COALESCE(issue_date, created_at::date) DESC, id DESC`, [uid]),
    query(`SELECT id, title, body, read_at, created_at FROM notifications
           WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [uid]),
    query(`${CLIENT_PRICING_SQL} WHERE p.inbox_type <> 'other' AND p.active ORDER BY p.sort_order`, [uid]),
  ]);

  const active = orders.rows.filter((o) => o.status === 'active');
  const pending = orders.rows.filter((o) => o.status === 'pending' || o.status === 'in_progress');
  const unpaid = invoices.rows.filter((i) => i.status === 'unpaid');
  const nextRenewal = active.map((o) => o.next_billing_date).filter(Boolean).sort()[0] || null;

  res.json({
    user: req.user,
    stats: {
      activeMailboxes: active.reduce((n, o) => n + (o.inbox_type === 'other' ? 0 : o.quantity), 0),
      pendingMailboxes: pending.reduce((n, o) => n + o.quantity, 0),
      activeBatches: active.length,
      monthlyBilling: active.reduce((n, o) => n + o.quantity * o.price_per_mailbox, 0),
      outstanding: unpaid.reduce((n, i) => n + i.amount, 0),
      unpaidInvoices: unpaid.length,
      nextRenewal,
    },
    orders: orders.rows,
    invoices: invoices.rows,
    notifications: notifications.rows,
    pricing: pricing.rows,
    paymentNote: billing.PAYMENT_NOTE,
    today: billing.today(),
    csvRequiredMin: Number(settings.csv_required_min),
    cancelNote: settings.cancel_note,
    supportEmail: settings.support_email,
    appUrl: baseUrl(req),
  });
}));

// ---------------------------------------------------------------- settings

const SETTING_DEFAULTS = {
  order_notify_emails: process.env.ORDER_NOTIFY_EMAILS || ADMIN_EMAIL,
  activity_emails: '',
  overdue_alert_emails: process.env.OVERDUE_ALERT_EMAILS || 'mithun@mithmill.com',
  website_url: 'https://mithmill.com',
  privacy_url: 'https://mithmill.com/privacy-policy',
  terms_url: 'https://mithmill.com/terms',
  csv_required_min: '10',
  support_email: (process.env.SUPPORT_EMAIL || 'support@mithmill.com').toLowerCase(),
  cancel_note: `To cancel a subscription, email us at ${(process.env.SUPPORT_EMAIL || 'support@mithmill.com').toLowerCase()} or send us a message ` +
    'wherever you are connected with us (WhatsApp, Telegram, Slack, Skype…). Subscriptions can\'t be cancelled from the portal.',
};

// Email footer links/contact follow Settings.
async function syncEmailBrand() {
  const st = await getSettings();
  emailTemplate.setBrand({ website: st.website_url, privacyUrl: st.privacy_url, termsUrl: st.terms_url, supportEmail: st.support_email });
}

async function getSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in out) out[r.key] = r.value;
  return out;
}

const emailList = (v) => String(v || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(isEmail);

app.get('/api/onboarding-template.csv', (req, res) => {
  res.attachment('mithmill-onboarding-template.csv').type('text/csv').send(onboarding.TEMPLATE);
});

const ACCESS_METHODS = ['delegate', 'registrar_login', 'client_dns'];
const SEQUENCERS = ['Instantly', 'Smartlead', 'Lemlist', 'Reply.io', 'Other', 'None'];

app.post('/api/orders', auth, asyncRoute(async (req, res) => {
  if (req.user.role !== 'client') throw new HttpError(403, 'Only clients place orders here');
  const b = req.body;
  const { rows: [price] } = await query(`${CLIENT_PRICING_SQL} WHERE p.inbox_type = $2`,
    [req.user.id, str(b.inbox_type, 50)]);
  if (!price || price.inbox_type === 'other' || !price.active) throw new HttpError(400, 'Choose an inbox type');

  // Onboarding sheet: optional, required for big orders, and the source of
  // domains/usernames when those fields are left empty.
  const settings = await getSettings();
  // Pre-warmed types come on our own domains: no domains, usernames, CSV or domain access to ask for.
  const ownDomains = price.needs_domains !== false;
  let sheet = null;
  if (ownDomains && b.onboarding_csv) {
    try {
      sheet = onboarding.validate(b.onboarding_csv);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }
  const quantity = Number.parseInt(b.quantity, 10) || (sheet ? sheet.users : NaN);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
    throw new HttpError(400, 'Number of mailboxes must be between 1 and 10000');
  }
  if (sheet && quantity !== sheet.users) {
    throw new HttpError(400, `Your CSV has ${sheet.users} users but the order is for ${quantity} mailboxes. Make them match (one CSV row per mailbox).`);
  }
  const csvMin = Number(settings.csv_required_min);
  if (ownDomains && csvMin > 0 && quantity >= csvMin && !sheet) {
    throw new HttpError(400, `Orders of ${csvMin} or more mailboxes need the onboarding CSV. Download the sample, fill it in and upload it.`);
  }
  const domains = str(b.domains, 20000) || (sheet ? sheet.domains.join('\n') : '');
  const usernames = str(b.usernames, 20000) ||
    (sheet ? sheet.rows.map((r) => `${r['Full name']} - ${r.Username}@${r['Domain name']}`).join('\n').slice(0, 20000) : '');
  if (ownDomains && !domains) throw new HttpError(400, 'Add at least one domain');
  if (ownDomains && !usernames) throw new HttpError(400, 'Add at least one username');
  // "I've sent the invitation": the client invited our support address to
  // their DNS and/or sequencer, so the access details aren't needed.
  const domainInvited = b.domain_invited === true;
  const sequencerInvited = b.sequencer_invited === true;
  const accessMethod = !ownDomains ? '' : domainInvited ? 'delegate' : str(b.domain_access_method, 50);
  if (ownDomains && !ACCESS_METHODS.includes(accessMethod)) throw new HttpError(400, 'Choose how we get domain access');
  const sequencer = str(b.sequencer, 50);
  if (!SEQUENCERS.includes(sequencer)) throw new HttpError(400, 'Choose your sequencer');
  const sequencerOther = str(b.sequencer_other, 100);
  if (sequencer === 'Other' && !sequencerOther) throw new HttpError(400, 'Tell us which sequencer you use');
  if (sequencerInvited && !str(b.sequencer_workspace, 200)) throw new HttpError(400, 'Add your sequencer workspace name');
  const sequencerNotes = [sequencer === 'Other' ? `Sequencer: ${sequencerOther}` : '', str(b.sequencer_notes)].filter(Boolean).join('\n');
  const registrarEmail = str(b.registrar_email, 200);
  const sequencerEmail = str(b.sequencer_email, 200);
  if (registrarEmail && !isEmail(registrarEmail)) throw new HttpError(400, 'Registrar login email looks invalid');
  if (sequencerEmail && !isEmail(sequencerEmail)) throw new HttpError(400, 'Sequencer login email looks invalid');

  const { rows: [order] } = await query(
    `INSERT INTO orders (user_id, inbox_type, quantity, price_per_mailbox, domains, usernames,
       domain_access_method, registrar, registrar_email, domain_access_notes,
       sequencer, sequencer_workspace, sequencer_email, sequencer_notes, notes, domain_invited, sequencer_invited)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [req.user.id, price.inbox_type, quantity, price.price_per_mailbox, domains, usernames,
     accessMethod, str(b.registrar, 200), registrarEmail, str(b.domain_access_notes),
     sequencer, str(b.sequencer_workspace, 200), sequencerEmail, sequencerNotes, str(b.notes), domainInvited, sequencerInvited],
  );
  if (sheet) {
    // Stored re-serialized in the template's column order, so the admin's download is clean.
    const csv = onboarding.toCsv([onboarding.COLUMNS, ...sheet.rows.map((r) => onboarding.COLUMNS.map((c) => r[c]))]);
    await query('INSERT INTO order_files (order_id, filename, row_count, data) VALUES ($1, $2, $3, $4)',
      [order.id, str(b.onboarding_filename, 200) || 'onboarding.csv', sheet.users, onboarding.encrypt(csv)]);
  }

  const total = billing.money(quantity * price.price_per_mailbox);
  await billing.notify(req.user, `Order #${order.id} received`,
    `We received your order for ${quantity} ${price.label} mailboxes (${total}/month). We'll let you know as soon as they're active.`);

  const notifyTo = emailList(settings.order_notify_emails);
  if (notifyTo.length) {
    sendMail({
      to: notifyTo.join(', '),
      subject: `New order #${order.id}: ${quantity} × ${price.label} from ${req.user.company || req.user.email}`,
      text: `${req.user.name} <${req.user.email}> placed order #${order.id}.\n\n` +
        `Type: ${price.label}\nMailboxes: ${quantity}\nMonthly: ${total}\n` +
        `Onboarding CSV: ${sheet ? `uploaded (${sheet.users} rows) - download it from the order in the admin panel` : 'not uploaded'}\n\n` +
        `${ownDomains ? `DNS invitation to ${settings.support_email}: ${domainInvited ? 'sent' : 'not sent (see domain access)'}` : 'Pre-warmed: no client domains (we provide them)'}\n` +
        `Sequencer invitation: ${sequencerInvited ? `sent (${sequencer === 'Other' ? sequencerOther : sequencer}, workspace "${str(b.sequencer_workspace, 200)}")` : 'not sent'}\n\n` +
        `Domains:\n${domains}\n\nOpen the admin panel: ${baseUrl(req)}/#/admin/orders/${order.id}`,
      heading: `New order #${order.id} from ${req.user.company || req.user.name || req.user.email}`,
      cta: { label: 'Open the order', url: `${baseUrl(req)}/#/admin/orders/${order.id}` },
      reason: 'You receive this because you are on the MithMill new-order notification list (Settings).',
    });
  }
  res.status(201).json({ id: order.id });
}));

app.post('/api/notifications/read', auth, asyncRoute(async (req, res) => {
  await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- admin

const admin = express.Router();
admin.use(auth, adminOnly);

// Clients, batches and invoices are shared by the admin panel and the reseller
// portal: this router is mounted under both /api/admin and /api/reseller, and
// every route checks the caller may see the client involved.
const shared = express.Router();
shared.use(auth, (req, res, next) => (
  ['admin', 'staff', 'reseller'].includes(req.user.role) ? next() : next(new HttpError(403, 'Not allowed'))));

// A reseller has to sign the current Reseller Agreement before using their dashboard.
async function signedAgreement(resellerId) {
  const { rows: [a] } = await query(
    'SELECT id, version, signer_name, signer_title, signed_at FROM reseller_agreements WHERE reseller_id = $1 AND version = $2 ORDER BY signed_at DESC LIMIT 1',
    [resellerId, policy.VERSION]);
  return a || null;
}
const requireAgreement = asyncRoute(async (req, res, next) => {
  // The agreement itself (reading, signing, downloading) is always reachable.
  if (req.user.role !== 'reseller' || req.path.startsWith('/agreement')) return next();
  if (!(await signedAgreement(req.user.id))) throw new HttpError(428, 'Please read and sign the Reseller Agreement first.');
  next();
});
shared.use(requireAgreement);

// The owner sees every client; team members only Mithmill's own (not
// resellers'), and a separated team member only the clients they added; a
// reseller only their own. client: { reseller_id, added_by }.
const separated = (req) => req.user.role === 'staff' && req.user.separated;
function canSee(req, client) {
  if (req.user.role === 'admin') return true;
  if (req.user.role === 'reseller') return client.reseller_id === req.user.id;
  return client.reseller_id == null && (!separated(req) || client.added_by === req.user.id);
}
async function assertClient(req, userId) {
  const { rows: [c] } = await query("SELECT * FROM users WHERE id = $1 AND role = 'client'", [Number(userId) || 0]);
  if (!c || !canSee(req, c)) throw new HttpError(404, 'Client not found');
  return c;
}
async function assertOrder(req, id) {
  const { rows: [o] } = await query('SELECT u.reseller_id, u.added_by FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1', [Number(id) || 0]);
  if (!o || !canSee(req, o)) throw new HttpError(404, 'Batch not found');
}
async function assertInvoice(req, id) {
  const { rows: [i] } = await query('SELECT u.reseller_id, u.added_by FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.id = $1', [Number(id) || 0]);
  if (!i || !canSee(req, i)) throw new HttpError(404, 'Invoice not found');
}
// SQL condition on `users u` for list queries, matching canSee.
const clientScope = (req) => (req.user.role === 'admin' ? 'true'
  : req.user.role === 'reseller' ? `u.reseller_id = ${Number(req.user.id)}`
    : separated(req) ? `u.reseller_id IS NULL AND u.added_by = ${Number(req.user.id)}` : 'u.reseller_id IS NULL');

async function activityRecipients() {
  const st = await getSettings();
  return emailList(st.activity_emails || st.order_notify_emails);
}

// Wraps an admin route so its change lands in the activity log (and, for team
// members, in the owner's inbox) with a before/after of every field.
// snap: audit snapshot name; getId(req, responseBody) -> id of the thing.
function audited(action, snap, getId, handler) {
  return asyncRoute(async (req, res, next) => {
    const id0 = getId(req, null);
    const before = id0 != null && !['added', 'invited'].includes(action) ? await audit.snapshots[snap](id0) : null;
    let payload;
    const send = res.json.bind(res);
    res.json = (body) => { payload = body; return res; };
    try {
      await handler(req, res, next);
    } finally {
      res.json = send;
    }
    if (payload === undefined) return;
    try {
      const id1 = getId(req, payload);
      const after = ['deleted', 'revoked'].includes(action) || id1 == null ? null : await audit.snapshots[snap](id1);
      const changes = audit.diff(before, after);
      if (!(action === 'edited' && !changes.length)) {
        await audit.record(req.user, action, (after || before || { title: snap }).title, changes,
          { recipients: await activityRecipients(), appUrl: baseUrl(req) });
      }
    } catch (err) {
      console.error('Activity log failed:', err);
    }
    send(payload);
  });
}
const byParam = (req) => req.params.id;

// Everything the panel lists. The owner also gets resellers' clients (marked
// with reseller_id; the main pages leave them out and the Resellers page shows them).
shared.get('/overview', asyncRoute(async (req, res) => {
  const scope = clientScope(req);
  const reseller = req.user.role === 'reseller';
  const [orders, clients, invites, invoices, pricing, clientPricing] = await Promise.all([
    query(`SELECT ${ORDER_COLUMNS}, o.admin_notes, o.from_invoice_id, o.cancel_reason, u.sold_by AS seller, o.user_id, u.email, u.name, u.company, u.reseller_id,
             f.row_count AS csv_rows, f.filename AS csv_filename
           FROM orders o JOIN pricing p ON p.inbox_type = o.inbox_type JOIN users u ON u.id = o.user_id
           LEFT JOIN order_files f ON f.order_id = o.id
           WHERE ${scope}
           ORDER BY (o.status IN ('pending','in_progress')) DESC, o.created_at DESC`),
    query(`SELECT u.id, u.email, u.name, u.company, u.created_at, u.password_set, u.reseller_id, u.sold_by AS seller,
             EXISTS (SELECT 1 FROM invites i WHERE i.email = u.email AND i.accepted_at IS NULL AND i.expires_at > now()) AS invited,
             COALESCE(SUM(o.quantity) FILTER (WHERE o.status = 'active' AND o.inbox_type <> 'other'), 0)::int AS active_mailboxes,
             COALESCE(SUM(o.quantity * o.price_per_mailbox) FILTER (WHERE o.status = 'active'), 0) AS monthly,
             count(o.id)::int AS batch_count,
             (SELECT count(*) FROM invoices i WHERE i.user_id = u.id)::int AS invoice_count
           FROM users u LEFT JOIN orders o ON o.user_id = u.id
           WHERE u.role = 'client' AND ${scope} GROUP BY u.id ORDER BY u.created_at DESC`),
    reseller ? { rows: [] } : query(`SELECT id, email, name, company, expires_at, created_at FROM invites
           WHERE accepted_at IS NULL AND expires_at > now() AND role = 'client'
             ${separated(req) ? `AND added_by = ${Number(req.user.id)}` : ''} ORDER BY created_at DESC`),
    query(`SELECT i.*, u.email, u.name, u.company, u.reseller_id, u.sold_by AS seller,
             (SELECT COALESCE(NULLIF(r.brand_name, ''), ru.company, ru.email) FROM resellers r JOIN users ru ON ru.id = r.user_id WHERE r.user_id = u.reseller_id) AS reseller_name
           FROM invoices i JOIN users u ON u.id = i.user_id
           WHERE ${scope}
           ORDER BY (i.status = 'unpaid') DESC, i.due_date DESC, i.id DESC LIMIT 500`),
    query("SELECT * FROM pricing WHERE inbox_type <> 'other' ORDER BY sort_order"),
    reseller ? { rows: [] } : query('SELECT user_id, inbox_type, price_per_mailbox FROM client_pricing'),
  ]);
  res.json({
    orders: orders.rows, clients: clients.rows, invites: invites.rows,
    invoices: invoices.rows, pricing: pricing.rows, clientPricing: clientPricing.rows, settings: reseller ? {} : await getSettings(),
    sellers: reseller ? [] : (await query("SELECT COALESCE(NULLIF(name, ''), email) AS name FROM users WHERE role IN ('admin', 'staff') ORDER BY role, name")).rows.map((r) => r.name),
    mailEnabled: mailEnabled(), today: billing.today(),
    whiteLabel: reseller ? (await query('SELECT white_label FROM resellers WHERE user_id = $1', [req.user.id])).rows[0].white_label : undefined,
  });
}));

shared.patch('/orders/:id', audited('edited', 'order', byParam, async (req, res) => {
  const id = Number(req.params.id);
  await assertOrder(req, id);
  const { rows: [order] } = await query(
    `SELECT o.*, p.label, u.email, u.name FROM orders o
     JOIN pricing p ON p.inbox_type = o.inbox_type JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [id],
  );
  if (!order) throw new HttpError(404, 'Order not found');
  const client = { id: order.user_id, email: order.email, name: order.name };

  if (typeof req.body.domains === 'string') {
    await query('UPDATE orders SET domains = $1 WHERE id = $2', [str(req.body.domains, 20000), id]);
  }
  if (typeof req.body.usernames === 'string') {
    await query('UPDATE orders SET usernames = $1 WHERE id = $2', [str(req.body.usernames, 20000), id]);
  }
  if (typeof req.body.batch_name === 'string') {
    await query('UPDATE orders SET batch_name = $1 WHERE id = $2', [str(req.body.batch_name, 200), id]);
  }
  if (typeof req.body.admin_notes === 'string') {
    await query('UPDATE orders SET admin_notes = $1 WHERE id = $2', [str(req.body.admin_notes), id]);
  }

  if (req.body.billing_cycle !== undefined) {
    const months = parseCycle(req.body);
    if (months !== billing.cycleMonths(order)) {
      await query('UPDATE orders SET billing_months = $1 WHERE id = $2', [months, id]);
      // Keep the renewal on the same day, one new cycle after the current period started.
      if (order.status === 'active' && order.next_billing_date) {
        const day = order.billing_day || Number(order.next_billing_date.slice(8));
        let periodStart = order.next_billing_date;
        // step back one old cycle to find the current period's start
        const [y, m] = periodStart.split('-').map(Number);
        const back = y * 12 + (m - 1) - billing.cycleMonths(order);
        periodStart = `${Math.floor(back / 12)}-${String((back % 12) + 1).padStart(2, '0')}-01`;
        let next = billing.nextBillingDate(periodStart, day, months);
        while (next <= billing.today()) next = billing.nextBillingDate(next, day, months);
        await query("UPDATE invoices SET status = 'void' WHERE order_id = $1 AND status = 'unpaid' AND period_start = $2", [id, order.next_billing_date]);
        await query('UPDATE orders SET next_billing_date = $1 WHERE id = $2', [next, id]);
        order.next_billing_date = next;
      }
      order.billing_months = months;
    }
  }

  const newPrice = req.body.price_per_mailbox !== undefined ? Number(req.body.price_per_mailbox) : order.price_per_mailbox;
  const newQty = req.body.quantity !== undefined ? Number(req.body.quantity) : order.quantity;
  if (!(newPrice >= 0)) throw new HttpError(400, 'Price must be 0 or more');
  if (!Number.isInteger(newQty) || newQty < 1 || newQty > 10000) throw new HttpError(400, 'Mailboxes must be between 1 and 10000');
  if (newPrice !== order.price_per_mailbox || newQty !== order.quantity) {
    await query('UPDATE orders SET price_per_mailbox = $1, quantity = $2 WHERE id = $3', [newPrice, newQty, id]);
    // Keep an already-issued, unpaid invoice for the upcoming renewal in step.
    await query(
      `UPDATE invoices SET amount = $1 WHERE order_id = $2 AND period_start = $3 AND status = 'unpaid'`,
      [newPrice * newQty * billing.cycleMonths(order), id, order.next_billing_date],
    );
    await query(
      `UPDATE invoice_items SET quantity = $1, unit_price = $2
        WHERE invoice_id IN (SELECT id FROM invoices WHERE order_id = $3 AND period_start = $4 AND status = 'unpaid')`,
      [newQty, newPrice * billing.cycleMonths(order), id, order.next_billing_date],
    );
    Object.assign(order, { price_per_mailbox: newPrice, quantity: newQty });
  }

  if (req.body.next_billing_date !== undefined) {
    const d = str(req.body.next_billing_date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'Billing date must be YYYY-MM-DD');
    if (d !== order.next_billing_date) {
      if (d <= billing.today()) throw new HttpError(400, 'The renewal date must be after today');
      await query('UPDATE orders SET next_billing_date = $1, billing_day = $2 WHERE id = $3',
        [d, Number(d.slice(8)), id]);
      // The renewal invoice issued for the old date no longer applies.
      await query(
        `UPDATE invoices SET status = 'void'
          WHERE order_id = $1 AND status = 'unpaid' AND period_start = $2`,
        [id, order.next_billing_date],
      );
    }
  }

  let invoiceId = null;
  const status = req.body.status;
  if (status && status !== order.status) {
    if (!['pending', 'in_progress', 'active', 'cancelled'].includes(status)) throw new HttpError(400, 'Bad status');
    if (status === 'active') {
      // Activation starts billing: first month invoiced today, renewal one month later.
      const start = billing.today();
      const day = Number(start.slice(8));
      const next = order.next_billing_date && order.next_billing_date > start
        ? order.next_billing_date
        : billing.nextBillingDate(start, day, billing.cycleMonths(order));
      await query(
        `UPDATE orders SET status = 'active', activated_at = COALESCE(activated_at, now()), cancelled_at = NULL,
           next_billing_date = $1, billing_day = COALESCE(billing_day, $2) WHERE id = $3`,
        [next, day, id],
      );
      if (req.body.create_invoice !== false && !order.activated_at) {
        const inv = await billing.createOrderInvoice(order, start,
          `Batch #${id}: ${order.quantity} × ${order.label} mailboxes, first ${billing.cycleMonths(order) === 1 ? 'month' : 'period'}`, 'First period');
        if (inv) invoiceId = inv.id;
      }
      await billing.notify(client, `Your ${order.quantity} ${order.label} mailboxes are active`,
        `Batch #${id} is now active. Your next renewal is on ${billing.prettyDate(next)} ` +
        `(${billing.money(billing.cycleAmount(order))}).`);
    } else {
      await query('UPDATE orders SET status = $1 WHERE id = $2', [status, id]);
      if (status === 'in_progress') {
        await billing.notify(client, `Order #${id} is being set up`,
          `We've started setting up your ${order.quantity} ${order.label} mailboxes.`);
      } else if (status === 'cancelled') {
        // Stop renewals: no next billing date, and unpaid upcoming invoices void.
        await query('UPDATE orders SET next_billing_date = NULL, cancelled_at = now() WHERE id = $1', [id]);
        await query(
          `UPDATE invoices SET status = 'void'
            WHERE order_id = $1 AND status = 'unpaid' AND period_start IS NOT NULL AND period_start >= $2`,
          [id, billing.today()],
        );
        await billing.notify(client, `Batch #${id} cancelled`,
          `Your ${order.quantity} ${order.label} mailboxes (batch #${id}) have been cancelled and will not renew.`);
      }
    }
  }
  res.json({ ok: true, invoiceId });
}));

// Removes a batch entirely (e.g. added by mistake). Its unpaid invoices are
// voided; paid invoices stay as history.
// ---- cancelling subscriptions, with a reason and an email to the client

const CANCEL_REASONS = { requested: 'Requested by client', no_payment: 'No payment made', other: 'Other' };

// Cancels the given batches (all of one client): they stop renewing and their
// upcoming unpaid invoices are voided. The client gets one email worded for
// the reason: a thank-you when they asked for it, or a note that the payment
// never came after several follow-ups.
async function cancelBatches(req, ids, { reason, note, notify, voidInvoiceId }) {
  if (!CANCEL_REASONS[reason]) throw new HttpError(400, 'Choose a reason for the cancellation');
  if (reason === 'other' && !note) throw new HttpError(400, 'Write the reason for the cancellation');
  const orders = [];
  for (const id of [...new Set(ids.map(Number))]) {
    await assertOrder(req, id);
    const { rows: [o] } = await query(
      `SELECT o.*, p.label, u.email, u.name FROM orders o JOIN pricing p ON p.inbox_type = o.inbox_type
        JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [id]);
    if (o.status !== 'cancelled') orders.push(o);
  }
  if (!orders.length) throw new HttpError(400, 'Those batches are already cancelled');
  if (new Set(orders.map((o) => o.user_id)).size > 1) throw new HttpError(400, 'Cancel one client\'s batches at a time');
  const why = reason === 'other' ? note : CANCEL_REASONS[reason];
  for (const o of orders) {
    await query(`UPDATE orders SET status = 'cancelled', next_billing_date = NULL, cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
      [o.id, why]);
    await query(
      `UPDATE invoices SET status = 'void'
        WHERE order_id = $1 AND status = 'unpaid' AND period_start IS NOT NULL AND period_start >= $2`, [o.id, billing.today()]);
    await audit.record(req.user, 'cancelled', `batch #${o.id}${o.batch_name ? ` "${o.batch_name}"` : ''} (${o.email})`,
      [{ field: 'Reason', from: '', to: why }], { recipients: await activityRecipients(), appUrl: baseUrl(req) });
  }
  if (voidInvoiceId) {
    await assertInvoice(req, voidInvoiceId);
    await query("UPDATE invoices SET status = 'void' WHERE id = $1 AND status = 'unpaid'", [Number(voidInvoiceId)]);
  }

  const first = orders[0];
  const brand = await brands.forClient(first.user_id);
  const brandName = brand ? brand.name : 'MithMill';
  const what = orders.map((o) => `• ${o.batch_name ? `${o.batch_name} (batch #${o.id})` : `Batch #${o.id}`}: ${billing.whatLabel(o)}`).join('\n');
  const plural = orders.length > 1;
  let title;
  let body;
  if (reason === 'no_payment') {
    title = 'Your subscription has been cancelled';
    body = `Your subscription has been cancelled, as we didn't receive the payment after multiple follow-ups:\n\n${what}\n\n` +
      `${plural ? 'They' : 'It'} won't renew. If you'd still like to keep them, reply to this email and we'll help you reactivate your subscription.`;
  } else {
    title = 'Your subscription has been cancelled';
    body = `${reason === 'requested' ? 'As you requested, your' : 'Your'} subscription has been cancelled:\n\n${what}\n\n` +
      `${reason === 'other' ? `Reason: ${note}\n\n` : ''}${plural ? 'They' : 'It'} won't renew, and you won't be charged for ${plural ? 'them' : 'it'} again.\n\n` +
      `Thank you for choosing ${brandName}. We hope to see you again soon, and we'd love to help with your next order whenever you need more mailboxes.`;
  }
  if (note && reason !== 'other') body += `\n\n${note}`;
  let emailed = false;
  if (notify) {
    await billing.notify({ id: first.user_id, email: first.email, name: first.name }, title, body,
      { always: true, paymentNote: false, heading: title });
    emailed = true;
  }
  return { cancelled: orders.map((o) => o.id), emailed, to: first.email };
}

shared.post('/orders/:id/cancel', asyncRoute(async (req, res) => {
  res.json(await cancelBatches(req, [req.params.id], {
    reason: str(req.body.reason, 20), note: str(req.body.note, 2000), notify: req.body.notify !== false,
  }));
}));

// From an invoice: its batch and the batches made from its recurring lines.
shared.post('/invoices/:id/cancel', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  await assertInvoice(req, id);
  const { rows: [inv] } = await query('SELECT order_id FROM invoices WHERE id = $1', [id]);
  const { rows: related } = await query(
    "SELECT id FROM orders WHERE (id = $1 OR from_invoice_id = $2) AND status <> 'cancelled'", [inv.order_id, id]);
  const allowed = new Set(related.map((r) => r.id));
  const ids = (Array.isArray(req.body.order_ids) ? req.body.order_ids.map(Number) : [...allowed]).filter((x) => allowed.has(x));
  if (!ids.length) throw new HttpError(400, 'This invoice has no active subscription to cancel');
  res.json(await cancelBatches(req, ids, {
    reason: str(req.body.reason, 20), note: str(req.body.note, 2000), notify: req.body.notify !== false,
    voidInvoiceId: req.body.void_invoice === true ? id : null,
  }));
}));

shared.delete('/orders/:id', audited('deleted', 'order', byParam, async (req, res) => {
  const id = Number(req.params.id);
  await assertOrder(req, id);
  const { rows: [o] } = await query('SELECT id FROM orders WHERE id = $1', [id]);
  if (!o) throw new HttpError(404, 'Batch not found');
  await query("UPDATE invoices SET status = 'void' WHERE order_id = $1 AND status = 'unpaid'", [id]);
  await query('DELETE FROM orders WHERE id = $1', [id]);
  res.json({ ok: true });
}));

admin.post('/invites', audited('invited', 'invite', (req, body) => (body ? body.id : null), async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const { rows: [found] } = await query('SELECT role, name, company, password_set, reseller_id, added_by FROM users WHERE email = $1', [email]);
  if (found && found.role !== 'client') throw new HttpError(400, found.role === 'reseller' ? 'That email belongs to a reseller' : 'That email belongs to a team member');
  // Resellers' clients don't log in to the portal.
  if (found && found.reseller_id) throw new HttpError(400, 'That email belongs to a reseller\'s client, who can\'t be invited');
  if (found && !canSee(req, found)) throw new HttpError(400, 'A client with that email already exists');
  // A client you added yourself but who never joined gets a normal invite, not a reset.
  const existing = found && found.password_set ? found : null;
  const name = str(req.body.name, 200) || (found && found.name) || '';
  const company = str(req.body.company, 200) || (found && found.company) || '';

  const token = crypto.randomBytes(24).toString('base64url');
  const soldBy = str(req.body.sold_by, 100);
  // An existing client keeps theirs unless one is given; a new one gets it when they accept.
  if (found && soldBy) await query('UPDATE users SET sold_by = $1 WHERE email = $2', [soldBy, email]);
  const blockVpn = req.user.role === 'admin' && req.body.block_vpn === true;
  if (found && blockVpn) await query('UPDATE users SET block_vpn = true WHERE email = $1', [email]);
  const { rows: [created] } = await query(
    `INSERT INTO invites (email, name, company, token, expires_at, sold_by, added_by, block_vpn)
     VALUES ($1, $2, $3, $4, now() + interval '${INVITE_DAYS} days', $5, $6, $7) RETURNING id`,
    [email, name, company, token, soldBy, req.user.id, blockVpn],
  );
  const link = `${baseUrl(req)}/#/invite/${token}`;
  const emailed = await sendMail({
    to: email,
    subject: existing ? 'Reset your Mithmill portal password' : "You're invited to the Mithmill client portal",
    text: existing
      ? `Hi ${name || 'there'},\n\nUse this link to set a new password for the Mithmill client portal ` +
        `(valid for ${INVITE_DAYS} days):\n\n${link}\n\nMithmill`
      : `Hi ${name || 'there'},\n\nYou've been invited to the Mithmill client portal, where you can see your ` +
        `mailboxes and billing and place new orders.\n\nSet your password here (valid for ${INVITE_DAYS} days):\n\n` +
        `${link}\n\n${billing.PAYMENT_NOTE}\n\nMithmill`,
    heading: existing ? 'Reset your password' : "You're invited to the MithMill client portal",
    cta: { label: existing ? 'Set a new password' : 'Accept invitation', url: link },
    note: existing ? null : billing.PAYMENT_NOTE,
    reason: existing
      ? 'You receive this because a password reset was requested for your MithMill client portal account. If that wasn\'t you, ignore this email.'
      : 'You receive this because MithMill invited you to its client portal. If you weren\'t expecting it, you can ignore this email.',
  });
  res.status(201).json({ id: created.id, link, emailed, reset: Boolean(existing) });
}));

// Billing cycle from the admin forms: monthly, yearly, or custom (every N months).
function parseCycle(b) {
  if (b.billing_cycle === 'yearly') return 12;
  if (b.billing_cycle === 'custom') {
    const n = Number(b.custom_months);
    if (!Number.isInteger(n) || n < 1 || n > 36) throw new HttpError(400, 'Custom cycle must be 1 to 36 months');
    return n;
  }
  return 1;
}

// Adds a client without inviting them, so existing batches and billing can be
// loaded first. They get their password when they accept an invite later.
// A reseller's clients belong to that reseller (reseller_id) and never log in.
shared.post('/clients', audited('added', 'user', (req, body) => (body ? body.id : null), async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const reseller = req.user.role === 'reseller';
  const { rows: [found] } = await query('SELECT id, role, reseller_id FROM users WHERE email = $1', [email]);
  if (found) {
    if (reseller) throw new HttpError(400, found.reseller_id === req.user.id ? 'You already have a client with that email' : 'That email can\'t be used. Use a different one.');
    throw new HttpError(400, found.role === 'client' ? 'A client with that email already exists' : 'That email belongs to a team member');
  }
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const { rows: [user] } = await query(
    `INSERT INTO users (email, name, company, password_hash, password_set, reseller_id, sold_by, added_by, block_vpn) VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8) RETURNING id`,
    [email, str(req.body.name, 200), str(req.body.company, 200), unusable, reseller ? req.user.id : null, reseller ? '' : str(req.body.sold_by, 100), req.user.id,
      req.user.role === 'admin' && req.body.block_vpn === true],
  );
  res.status(201).json({ id: user.id });
}));

// Edits a client's details. Changing the login email is owner-only; the old
// address is told, and pending invites to it stop working.
shared.patch('/clients/:id', audited('edited', 'user', byParam, async (req, res) => {
  const id = Number(req.params.id);
  const client = await assertClient(req, id);
  const email = req.body.email === undefined ? client.email : str(req.body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const name = req.body.name === undefined ? client.name : str(req.body.name, 200);
  const company = req.body.company === undefined ? client.company : str(req.body.company, 200);
  const emailChanged = email !== client.email;
  if (emailChanged) {
    if (req.user.role === 'staff') throw new HttpError(403, 'Only the account owner can change a client\'s email');
    const { rows: [taken] } = await query('SELECT role FROM users WHERE email = $1 AND id <> $2', [email, id]);
    if (taken && req.user.role === 'reseller') throw new HttpError(400, 'That email can\'t be used. Use a different one.');
    if (taken) throw new HttpError(400, taken.role === 'client' ? 'Another client already uses that email' : 'That email belongs to a team member');
  }
  // Sold by (who gets the commission on this client) is for MithMill's team only.
  const soldBy = req.user.role === 'reseller' || req.body.sold_by === undefined ? client.sold_by : str(req.body.sold_by, 100);
  await query('UPDATE users SET email = $1, name = $2, company = $3, sold_by = $4 WHERE id = $5', [email, name, company, soldBy, id]);
  if (emailChanged) {
    await query('DELETE FROM invites WHERE email = $1 AND accepted_at IS NULL', [client.email]);
    if (client.password_set) {
      const url = baseUrl(req);
      await sendMail({
        to: client.email,
        subject: 'Your Mithmill portal login email was changed',
        text: `Hi ${name || 'there'},\n\nThe login email for your Mithmill client portal account was changed from ${client.email} to ${email}. ` +
          `From now on, log in with ${email}.\n\nIf you didn't ask for this, please contact us right away.\n\nMithmill`,
        heading: 'Your login email was changed',
      });
      await sendMail({
        to: email,
        subject: 'Your Mithmill portal login email was updated',
        text: `Hi ${name || 'there'},\n\nThis is now the login email for your Mithmill client portal account (it was ${client.email}). ` +
          `Your password stays the same.\n\nLog in: ${url}\n\nMithmill`,
        heading: 'Your login email was updated',
        cta: { label: 'Log in to your portal', url },
      });
    }
  }
  res.json({ ok: true, emailChanged });
}));

// Deletes a client and everything of theirs: batches, invoices (paid ones
// too), notifications, pricing and uploaded CSVs. Owner-only; can't be undone.
// Owner, or a reseller for their own clients.
shared.delete('/clients/:id', audited('deleted', 'user', byParam, async (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role === 'staff') throw new HttpError(403, 'Only the account owner can do this');
  const client = await assertClient(req, id);
  await query('DELETE FROM invites WHERE email = $1 AND accepted_at IS NULL', [client.email]);
  await query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// Adds a batch on a client's behalf: an existing purchase (with its billing
// dates) or a new order taken outside the portal.
shared.post('/orders', audited('added', 'order', (req, body) => (body ? body.id : null), async (req, res) => {
  const b = req.body;
  if (!b.user_id) throw new HttpError(400, 'Choose a client');
  const client = await assertClient(req, b.user_id);
  const { rows: [type] } = await query('SELECT inbox_type, label FROM pricing WHERE inbox_type = $1', [str(b.inbox_type, 50)]);
  if (!type) throw new HttpError(400, 'Choose a mailbox type');
  const quantity = Number(b.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) throw new HttpError(400, 'Mailboxes must be between 1 and 10000');
  const price = Number(b.price_per_mailbox);
  if (!(price >= 0)) throw new HttpError(400, 'Price must be 0 or more');
  const status = ['pending', 'in_progress', 'active', 'cancelled'].includes(b.status) ? b.status : 'active';

  const today = billing.today();
  const start = str(b.start_date, 10) || today;
  if (!DATE_RE.test(start)) throw new HttpError(400, 'Start date must be a date');
  const months = parseCycle(b);
  // Renews on the start date's day every cycle: roll forward to the next renewal after today.
  const day = Number(start.slice(8));
  let next = null;
  if (status === 'active') {
    next = billing.nextBillingDate(start, day, months);
    while (next <= today) next = billing.nextBillingDate(next, day, months);
  }

  const { rows: [order] } = await query(
    `INSERT INTO orders (user_id, inbox_type, quantity, price_per_mailbox, domains, usernames,
       domain_access_method, sequencer, sequencer_workspace, admin_notes, batch_name, status,
       activated_at, billing_day, next_billing_date, created_at, billing_months, sold_by)
     VALUES ($1, $2, $3, $4, $5, $6, '', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
    [client.id, type.inbox_type, quantity, price, str(b.domains, 20000), str(b.usernames, 20000),
     str(b.sequencer, 50), str(b.sequencer_workspace, 200), str(b.admin_notes), str(b.batch_name, 200), status,
     status === 'pending' ? null : `${start}T00:00:00Z`, status === 'active' ? day : null,
     next, `${start}T00:00:00Z`, months, str(b.sold_by, 100)],
  );

  // Invoices for the batch's billing periods so far: just the current one (the
  // one ending at the next renewal), or every period since the start date, so
  // a client added months later sees their whole history.
  let invoiceId = null;
  let created = [];
  if (status === 'active' && ['paid', 'unpaid', 'all_paid', 'all_paid_current_unpaid'].includes(b.current_period)) {
    const all = billing.periodsSince(order, start);
    const periods = b.current_period.startsWith('all') ? all : all.slice(-1);
    const currentPaid = ['paid', 'all_paid'].includes(b.current_period);
    created = await recordPeriods({ ...order, label: type.label }, periods, currentPaid);
    invoiceId = created.length ? created[created.length - 1] : null;
  }
  if (b.notify === true && client.password_set) {
    await billing.notify(client, `New batch added: ${quantity} ${type.label} mailboxes`,
      `Batch #${order.id} has been added to your account.`);
  }
  res.status(201).json({ id: order.id, invoiceId, invoices: created.length });
}));

// Issues one invoice per billing period (skipping periods already invoiced),
// dated to the period. Past periods are recorded as paid; the latest one is
// paid or unpaid as asked. Returns the new invoice ids.
async function recordPeriods(order, periods, latestPaid) {
  const ids = [];
  for (const [i, start] of periods.entries()) {
    const inv = await billing.createOrderInvoice(order, start,
      `Batch #${order.id}: ${order.quantity} × ${order.label} mailboxes (from ${billing.prettyDate(start)})`,
      `Mailboxes from ${billing.prettyDate(start)}`);
    if (!inv) continue;
    ids.push(inv.id);
    await query('UPDATE invoices SET issue_date = $1 WHERE id = $2', [start, inv.id]);
    if (i < periods.length - 1 || latestPaid) {
      await query("UPDATE invoices SET status = 'paid', paid_at = $1 WHERE id = $2", [`${start}T12:00:00Z`, inv.id]);
    }
  }
  return ids;
}

// Fills in a batch's missing invoices for past billing periods (as paid), from
// its start date up to the current period. For clients added after months of
// service, so their invoice history is complete in their portal.
shared.post('/orders/:id/history', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  await assertOrder(req, id);
  const { rows: [order] } = await query(
    'SELECT o.*, p.label FROM orders o JOIN pricing p ON p.inbox_type = o.inbox_type WHERE o.id = $1', [id]);
  if (order.status !== 'active' || !order.next_billing_date || !order.activated_at) {
    throw new HttpError(400, 'Only active batches have a billing history to fill in');
  }
  const from = str(req.body.from, 10) || new Date(order.activated_at).toISOString().slice(0, 10);
  if (!DATE_RE.test(from)) throw new HttpError(400, 'Start date must be a date');
  const periods = billing.periodsSince(order, from, 2);
  const { rows: have } = await query('SELECT period_start FROM invoices WHERE order_id = $1 AND period_start IS NOT NULL', [id]);
  const existing = new Set(have.map((r) => r.period_start));
  const missing = periods.filter((p) => !existing.has(p));
  // Only past periods: the current one keeps whatever invoice it has (or gets one at renewal time).
  const past = missing.filter((p) => p !== periods[periods.length - 1]);
  const created = await recordPeriods(order, past, true);
  if (from < new Date(order.activated_at).toISOString().slice(0, 10)) {
    await query('UPDATE orders SET activated_at = $1, created_at = LEAST(created_at, $1) WHERE id = $2', [`${from}T00:00:00Z`, id]);
  }
  await audit.record(req.user, 'edited', `batch #${id} (invoice history)`,
    [{ field: 'Past invoices added', from: '', to: created.length ? `${created.length} (marked paid)` : 'none needed' }],
    { recipients: await activityRecipients(), appUrl: baseUrl(req) });
  res.json({ created: created.length, periods: periods.length });
}));

admin.delete('/invites/:id', audited('revoked', 'invite', byParam, async (req, res) => {
  await query(`DELETE FROM invites WHERE id = $1 AND accepted_at IS NULL${separated(req) ? ' AND added_by = $2' : ''}`,
    separated(req) ? [Number(req.params.id), req.user.id] : [Number(req.params.id)]);
  res.json({ ok: true });
}));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validates the invoice editor's payload. Returns the cleaned header and items.
async function parseInvoice(req) {
  const body = req.body;
  const userId = Number(body.user_id);
  if (!userId) throw new HttpError(400, 'Choose a client');
  const user = await assertClient(req, userId);

  const orderId = body.order_id ? Number(body.order_id) : null;
  if (orderId) {
    const { rows: [o] } = await query('SELECT 1 FROM orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
    if (!o) throw new HttpError(400, 'That batch does not belong to this client');
  }
  const issueDate = str(body.issue_date, 10) || billing.today();
  const dueDate = str(body.due_date, 10);
  if (!DATE_RE.test(issueDate)) throw new HttpError(400, 'Issue date must be a date');
  if (!DATE_RE.test(dueDate)) throw new HttpError(400, 'Due date must be a date');

  const { rows: types } = await query('SELECT inbox_type FROM pricing');
  const validTypes = new Set(['', 'other', ...types.map((t) => t.inbox_type)]);
  const rawItems = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
  const items = rawItems.map((it, i) => {
    const item = {
      inbox_type: str(it.inbox_type, 50),
      batch_name: str(it.batch_name, 200),
      description: str(it.description, 1000),
      quantity: Number(it.quantity),
      unit_price: Number(it.unit_price),
      recurring: it.inbox_type === 'other' && it.recurring === true,
    };
    const n = i + 1;
    if (!validTypes.has(item.inbox_type)) throw new HttpError(400, `Line ${n}: unknown mailbox type`);
    if (!item.inbox_type && !item.description && !item.batch_name) throw new HttpError(400, `Line ${n}: add a type, batch name or description`);
    if (!(item.quantity > 0)) throw new HttpError(400, `Line ${n}: quantity must be more than 0`);
    if (!(item.unit_price >= 0)) throw new HttpError(400, `Line ${n}: price must be 0 or more`);
    return item;
  });
  if (!items.length) throw new HttpError(400, 'Add at least one line');

  const subtotal = items.reduce((t, it) => t + Math.round(it.quantity * it.unit_price * 100), 0) / 100;
  const discount = body.discount ? Number(body.discount) : 0;
  if (!(discount >= 0) || discount > subtotal) throw new HttpError(400, 'Discount must be between 0 and the subtotal');
  const amount = Math.round((subtotal - discount) * 100) / 100;
  if (!(amount > 0)) throw new HttpError(400, 'Invoice total must be more than 0');

  const description = str(body.description, 500) || (items.length === 1
    ? [items[0].batch_name, items[0].description].filter(Boolean).join(': ') || 'Invoice'
    : `${items.length} items`);
  const status = ['unpaid', 'paid'].includes(body.status) ? body.status : null;
  const paidDate = str(body.paid_date, 10);
  if (status === 'paid' && paidDate && !DATE_RE.test(paidDate)) throw new HttpError(400, 'Paid date must be a date');
  return {
    user, orderId, issueDate, dueDate, items, discount, amount, description, notes: str(body.notes, 5000), soldBy: str(body.sold_by, 100),
    status, paidAt: status === 'paid' ? `${paidDate || billing.today()}T12:00:00Z` : null,
  };
}

async function writeItems(client, invoiceId, items) {
  await client.query('DELETE FROM invoice_items WHERE invoice_id = $1', [invoiceId]);
  for (const [i, it] of items.entries()) {
    await client.query(
      `INSERT INTO invoice_items (invoice_id, inbox_type, batch_name, description, quantity, unit_price, sort_order, recurring)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [invoiceId, it.inbox_type, it.batch_name, it.description, it.quantity, it.unit_price, i, it.recurring],
    );
  }
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function invoiceWithItems(id, userId) {
  const { rows: [inv] } = await query(
    `SELECT i.*, u.email, u.name, u.company, u.sold_by AS seller FROM invoices i JOIN users u ON u.id = i.user_id
      WHERE i.id = $1 ${userId ? "AND i.user_id = $2 AND i.status <> 'void'" : ''}`,
    userId ? [id, userId] : [id],
  );
  if (!inv) throw new HttpError(404, 'Invoice not found');
  const { rows: items } = await query(
    'SELECT inbox_type, batch_name, description, quantity, unit_price, recurring FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order, id',
    [id],
  );
  const { rows: pricing } = await query('SELECT inbox_type, label FROM pricing ORDER BY sort_order');
  // Invoices from before line items existed show as a single line.
  if (!items.length) items.push({ inbox_type: '', batch_name: '', description: inv.description, quantity: 1, unit_price: inv.amount + inv.discount });
  if (userId) { delete inv.sold_by; delete inv.seller; } // admin-only
  // A white-label reseller's client sees the reseller's name, logo and payment details.
  const wl = await brands.forClient(inv.user_id);
  const reseller = userId ? null : await brands.resellerOf(inv.user_id);
  return {
    ...inv, items, pricing, paymentNote: wl ? wl.paymentNote : billing.PAYMENT_NOTE,
    brand: wl ? { name: wl.name, logo: wl.logoPath } : null,
    resellerName: reseller ? reseller.name : null,
    payLinks: inv.status === 'unpaid' ? billing.payButtons(inv, wl ? wl.paymentNote : '') : [],
  };
}

app.get('/api/invoices/:id', auth, asyncRoute(async (req, res) => {
  res.json(await invoiceWithItems(Number(req.params.id), req.user.id));
}));

shared.get('/invoices/:id', asyncRoute(async (req, res) => {
  await assertInvoice(req, req.params.id);
  res.json(await invoiceWithItems(Number(req.params.id)));
}));

// Turns an invoice's mailbox lines into active batches, so they count on the
// client's dashboard and renew from the invoice's issue date. The invoice is
// linked to the (first) batch as its first billing period.
async function createBatchesFromInvoice(invoiceId, months) {
  const { rows: [inv] } = await query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (inv.order_id) throw new HttpError(400, 'This invoice is already linked to a batch');
  const { rows: types } = await query('SELECT inbox_type FROM pricing');
  const valid = new Set(types.map((t) => t.inbox_type).filter((t) => t !== 'other'));
  const { rows: items } = await query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order, id', [invoiceId]);
  // Mailbox lines, plus "Other" lines marked recurring (e.g. an SMTP service).
  const lines = items.filter((it) => valid.has(it.inbox_type) || (it.inbox_type === 'other' && it.recurring));
  if (!lines.length) throw new HttpError(400, 'This invoice has no mailbox lines or recurring Other lines');
  const bad = lines.find((it) => !Number.isInteger(it.quantity) || it.quantity < 1);
  if (bad) throw new HttpError(400, 'Mailbox lines need a whole-number quantity to become a batch');

  const start = inv.issue_date || billing.today();
  const day = Number(start.slice(8));
  let next = billing.nextBillingDate(start, day, months);
  while (next <= billing.today()) next = billing.nextBillingDate(next, day, months);
  const ids = [];
  for (const it of lines) {
    const { rows: [o] } = await query(
      `INSERT INTO orders (user_id, inbox_type, quantity, price_per_mailbox, domains, usernames, domain_access_method,
         sequencer, batch_name, status, activated_at, billing_day, next_billing_date, created_at, billing_months, from_invoice_id, sold_by)
       VALUES ($1, $2, $3, $4, '', '', '', '', $5, 'active', $6, $7, $8, $6, $9, $10, $11) RETURNING id`,
      [inv.user_id, it.inbox_type, it.quantity, Math.round((it.unit_price / months) * 100) / 100,
       otherName(it), `${start}T00:00:00Z`, day, next, months, invoiceId, inv.sold_by],
    );
    ids.push(o.id);
  }
  await query('UPDATE invoices SET order_id = $1, period_start = $2 WHERE id = $3', [ids[0], start, invoiceId]);
  return ids;
}

const otherName = (it) => it.batch_name || (it.inbox_type === 'other' ? it.description || 'Other service' : '');

// An invoice that already belongs to a batch can still carry "Other" lines
// ticked Recurring (e.g. a warmup service added to a mailbox batch). Each
// becomes its own active batch that renews alongside the linked one; saving
// the invoice again updates that batch rather than adding another.
async function syncRecurringOtherLines(invoiceId) {
  const { rows: [inv] } = await query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
  if (!inv || !inv.order_id || inv.status === 'void') return [];
  const { rows: [base] } = await query('SELECT * FROM orders WHERE id = $1', [inv.order_id]);
  if (!base) return [];
  const { rows: items } = await query(
    "SELECT * FROM invoice_items WHERE invoice_id = $1 AND inbox_type = 'other' AND recurring ORDER BY sort_order, id", [invoiceId]);
  const months = billing.cycleMonths(base);
  const start = inv.period_start || inv.issue_date || billing.today();
  const day = base.billing_day || Number(start.slice(8));
  // This invoice already charges the line for the period starting at `start`,
  // so the new batch's first renewal is the one after it.
  let next = base.next_billing_date || billing.nextBillingDate(start, day, months);
  while (next <= start || next <= billing.today()) next = billing.nextBillingDate(next, day, months);
  const ids = [];
  for (const it of items) {
    if (!Number.isInteger(it.quantity) || it.quantity < 1) continue;
    const name = otherName(it);
    const price = Math.round((it.unit_price / months) * 100) / 100;
    const { rows: [found] } = await query(
      `SELECT id FROM orders WHERE from_invoice_id = $1 AND inbox_type = 'other' AND batch_name = $2`,
      [invoiceId, name]);
    if (found) {
      await query('UPDATE orders SET quantity = $1, price_per_mailbox = $2 WHERE id = $3', [it.quantity, price, found.id]);
      ids.push(found.id);
      continue;
    }
    const { rows: [o] } = await query(
      `INSERT INTO orders (user_id, inbox_type, quantity, price_per_mailbox, domains, usernames, domain_access_method,
         sequencer, batch_name, status, activated_at, billing_day, next_billing_date, created_at, billing_months, from_invoice_id, sold_by)
       VALUES ($1, 'other', $2, $3, '', '', '', '', $4, $5, $6, $7, $8, $6, $9, $10, $11) RETURNING id`,
      [inv.user_id, it.quantity, price, name, base.status === 'active' ? 'active' : base.status,
       `${start}T00:00:00Z`, day, base.status === 'active' ? next : null, months, invoiceId, inv.sold_by || base.sold_by]);
    ids.push(o.id);
  }
  return ids;
}

shared.post('/invoices/:id/batches', audited('edited', 'invoice', byParam, async (req, res) => {
  await assertInvoice(req, req.params.id);
  const ids = await createBatchesFromInvoice(Number(req.params.id), parseCycle(req.body));
  res.status(201).json({ batchIds: ids });
}));

shared.post('/invoices', audited('added', 'invoice', (req, body) => (body ? body.id : null), async (req, res) => {
  const v = await parseInvoice(req);
  const cycle = req.body.create_batches === true && !v.orderId ? parseCycle(req.body) : null;
  const id = await inTransaction(async (client) => {
    const { rows: [inv] } = await client.query(
      `INSERT INTO invoices (user_id, order_id, description, amount, discount, due_date, issue_date, notes, sold_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [v.user.id, v.orderId, v.description, v.amount, v.discount, v.dueDate, v.issueDate, v.notes, v.soldBy],
    );
    await writeItems(client, inv.id, v.items);
    if (v.status === 'paid') await client.query("UPDATE invoices SET status = 'paid', paid_at = $1 WHERE id = $2", [v.paidAt, inv.id]);
    return inv.id;
  });
  let batchIds = [];
  if (cycle) {
    try {
      batchIds = await createBatchesFromInvoice(id, cycle);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err; // no mailbox lines: nothing to add
    }
  }
  if (v.orderId) batchIds = await syncRecurringOtherLines(id);
  await billing.resellerCost(id);
  if (req.body.notify !== false) {
    await billing.notify(v.user, `New invoice: ${billing.money(v.amount)}`,
      `Invoice #${id} for ${billing.money(v.amount)} (${v.description}) is due on ${billing.prettyDate(v.dueDate)}.`,
      { buttons: v.status === 'paid' ? [] : billing.payButtons({ notes: v.notes, amount: v.amount }) });
  }
  res.status(201).json({ id, batchIds });
}));

shared.put('/invoices/:id', audited('edited', 'invoice', byParam, async (req, res) => {
  const id = Number(req.params.id);
  await assertInvoice(req, id);
  const { rows: [existing] } = await query('SELECT id, status FROM invoices WHERE id = $1', [id]);
  if (!existing) throw new HttpError(404, 'Invoice not found');
  const v = await parseInvoice(req);
  await inTransaction(async (client) => {
    await client.query(
      `UPDATE invoices SET user_id = $1, order_id = $2, description = $3, amount = $4, discount = $5,
         due_date = $6, issue_date = $7, notes = $8, sold_by = $10 WHERE id = $9`,
      [v.user.id, v.orderId, v.description, v.amount, v.discount, v.dueDate, v.issueDate, v.notes, id, v.soldBy],
    );
    await writeItems(client, id, v.items);
    if (v.status === 'paid') await client.query("UPDATE invoices SET status = 'paid', paid_at = $1 WHERE id = $2", [v.paidAt, id]);
    if (v.status === 'unpaid') await client.query("UPDATE invoices SET status = 'unpaid', paid_at = NULL WHERE id = $1", [id]);
  });
  const batchIds = await syncRecurringOtherLines(id);
  if (existing.status !== 'paid') await billing.resellerCost(id);
  let thanked = null;
  if (v.status === 'paid' && existing.status !== 'paid' && req.body.thank !== false) {
    const { rows: [inv] } = await query('SELECT * FROM invoices WHERE id = $1', [id]);
    thanked = await sendPaymentThanks(inv);
  } else if (req.body.notify === true) {
    await billing.notify(v.user, `Invoice #${id} updated: ${billing.money(v.amount)}`,
      `Invoice #${id} has been updated. Total ${billing.money(v.amount)}, due on ${billing.prettyDate(v.dueDate)}.`,
      { buttons: v.status === 'paid' ? [] : billing.payButtons({ notes: v.notes, amount: v.amount }) });
  }
  res.json({ ok: true, batchIds, thanked });
}));

// "Payment received, thank you" email when an invoice is marked paid. Sent to
// clients who haven't joined the portal yet too; branded for resellers' clients.
async function sendPaymentThanks(inv) {
  const { rows: [user] } = await query('SELECT id, email, name FROM users WHERE id = $1', [inv.user_id]);
  const brand = await brands.forClient(inv.user_id);
  const money = billing.money(inv.amount);
  await billing.notify(user, `Payment received: ${money}`,
    `We've received your payment of ${money} for invoice #${inv.id} (${inv.description}). Thank you for your purchase!\n\n` +
    `${inv.order_id ? 'Your mailboxes stay active, and we\'ll remind you before your next renewal.\n\n' : ''}` +
    `We appreciate your business and look forward to working with you. Thanks for choosing ${brand ? brand.name : 'MithMill'}!`,
    { always: true, paymentNote: false, subject: `Payment received for invoice #${inv.id}. Thank you!`, heading: 'Payment received. Thank you!' });
  return user.email;
}

// Emails the invoice to the client: every line, the total and due date, the
// notes (payment details) and a link to it in the portal once they've joined.
// With { urgent: true, hours } it's a critical alert instead: the mailboxes
// will be deactivated in that many hours unless the invoice is paid now.
shared.post('/invoices/:id/send', asyncRoute(async (req, res) => {
  await assertInvoice(req, req.params.id);
  res.json(await emailInvoice(req, Number(req.params.id), {
    urgent: req.body && req.body.urgent === true, hours: req.body && req.body.hours,
  }));
}));

async function emailInvoice(req, invoiceId, opts = {}) {
  if (!mailEnabled()) throw new HttpError(503, 'Email is not set up, so the invoice can\'t be sent');
  const inv = await invoiceWithItems(invoiceId);
  if (inv.status === 'void') throw new HttpError(400, 'This invoice is void');
  const urgent = opts.urgent === true;
  if (urgent && inv.status === 'paid') throw new HttpError(400, 'This invoice is already paid');
  const hours = Math.min(72, Math.max(1, Math.round(Number(opts.hours) || 3)));
  const hrs = `${hours} hour${hours === 1 ? '' : 's'}`;
  const { rows: [client] } = await query('SELECT password_set, reseller_id FROM users WHERE id = $1', [inv.user_id]);
  const brand = await brands.forClient(inv.user_id);
  const brandName = brand ? brand.name : 'MithMill';
  const { esc, C } = emailTemplate;
  const label = (t) => (inv.pricing.find((p) => p.inbox_type === t) || {}).label || '';
  const qty = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const money = billing.money;
  const subtotal = inv.items.reduce((t, it) => t + it.quantity * it.unit_price, 0);
  const due = billing.prettyDate(inv.due_date);
  const issued = billing.prettyDate(inv.issue_date || billing.today());
  const lineName = (it) => [it.inbox_type === 'other' ? '' : label(it.inbox_type), it.batch_name, it.description].filter(Boolean).join(' · ') || 'Item';
  const paid = inv.status === 'paid';

  const td = `padding:10px 8px;border-bottom:1px solid ${C.line};font-size:14px;color:${C.text};vertical-align:top`;
  const num = `${td};text-align:right;white-space:nowrap`;
  const th = `padding:8px;border-bottom:1px solid ${C.line};font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};text-align:left`;
  const row = (l, v, strong) => `<tr><td style="padding:6px 8px;text-align:right;font-size:${strong ? 16 : 14}px;color:${strong ? C.ink : C.muted};${strong ? 'font-weight:700' : ''}">${l}</td><td style="padding:6px 8px;text-align:right;white-space:nowrap;font-size:${strong ? 16 : 14}px;color:${C.ink};${strong ? 'font-weight:700' : ''}">${v}</td></tr>`;
  const html = `${urgent ? emailTemplate.alertBox({ title: `Your mailboxes will be deactivated in about ${hrs}`,
    body: `Invoice #${inv.id} (${billing.money(inv.amount)}) is still unpaid. Pay now to keep them active.` }) : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px;font-size:13px;color:${C.muted}">
      <tr><td>Invoice <strong style="color:${C.ink}">#${inv.id}</strong></td><td align="right">Issued ${esc(issued)} · ${paid ? `<strong style="color:#047857">Paid</strong>` : `Due <strong style="color:${C.ink}">${esc(due)}</strong>`}</td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 8px">
      <tr><th style="${th}">Item</th><th style="${th};text-align:right">Qty</th><th style="${th};text-align:right">Price</th><th style="${th};text-align:right">Amount</th></tr>
      ${inv.items.map((it) => `<tr><td style="${td}">${esc(lineName(it))}</td><td style="${num}">${qty(it.quantity)}</td><td style="${num}">${money(it.unit_price)}</td><td style="${num}">${money(it.quantity * it.unit_price)}</td></tr>`).join('')}
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:0 0 20px">
      ${inv.discount ? row('Subtotal', money(subtotal)) + row('Discount', `−${money(inv.discount)}`) : ''}
      ${row(paid ? 'Total paid' : 'Total due', money(inv.amount), true)}
    </table>
    <div style="clear:both"></div>
    ${inv.notes ? `<div style="margin:0 0 16px;padding:14px 16px;background:${C.bg};border:1px solid ${C.line};border-radius:10px;font-size:14px;line-height:1.6;color:${C.text}"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};margin-bottom:6px">Notes</div>${emailTemplate.linkify(esc(inv.notes)).replace(/\n/g, '<br>')}</div>` : ''}
    ${brand ? '' : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>
      <td style="font-size:12px;color:${C.faint};padding-right:8px;vertical-align:middle">Payments powered by</td>
      <td style="vertical-align:middle">${APP_URL ? `<img src="${esc(APP_URL)}/mixxbee-logo.png" alt="Mixxbee" width="60" style="display:block;width:60px;height:auto;border:0">` : '<strong>Mixxbee</strong>'}</td>
    </tr></table>`}`;

  const name = inv.name || 'there';
  const intro = urgent
    ? `Hi ${name},\n\nInvoice #${inv.id} for ${money(inv.amount)} is still unpaid, and the mailboxes below will be deactivated in about ${hrs}.\n\nTo keep them active, please complete the payment now.`
    : paid
      ? `Hi ${name},\n\nHere is your paid invoice #${inv.id} for ${money(inv.amount)}. Thank you!`
      : `Hi ${name},\n\nHere is your invoice #${inv.id} for ${money(inv.amount)}, due on ${due}.`;
  const confirm = urgent
    ? 'Already paid? Reply to this email with a screenshot of the payment, or share it in your dedicated WhatsApp or ' +
      'Slack group with us (recommended), so we can confirm it and keep your mailboxes active.'
    : paid ? '' : 'To confirm your payment, please reply to this email with a screenshot of the payment, ' +
      'or share it in your dedicated WhatsApp or Slack group with us (recommended).';
  const link = client && client.password_set ? `${baseUrl(req)}/#/invoice/${inv.id}` : null;
  const text = [
    urgent ? `CRITICAL ALERT: your mailboxes will be deactivated in about ${hrs}.` : '',
    intro,
    inv.items.map((it) => `• ${lineName(it)}: ${qty(it.quantity)} × ${money(it.unit_price)} = ${money(it.quantity * it.unit_price)}`).join('\n'),
    `${inv.discount ? `Discount: −${money(inv.discount)}\n` : ''}${paid ? 'Total paid' : 'Total due'}: ${money(inv.amount)}${paid ? '' : ` (due ${due})`}`,
    inv.payLinks.map((b) => `${b.hint ? `${b.hint}\n` : ''}${b.label}: ${b.url}`).join('\n'),
    inv.notes ? `Notes:\n${inv.notes}` : '',
    confirm,
    link ? `View your invoice: ${link}` : '',
    inv.paymentNote,
    brand ? brandName : 'Mithmill',
  ].filter(Boolean).join('\n\n');

  const sent = await sendMail({
    to: inv.email,
    subject: urgent ? `URGENT: your mailboxes will be deactivated in ${hrs} (invoice #${inv.id} unpaid)`
      : paid ? `Invoice #${inv.id} from ${brandName} (paid)` : `Invoice #${inv.id} from ${brandName}: ${money(inv.amount)} due ${due}`,
    text,
    heading: urgent ? `Critical alert: your mailboxes expire in ${hrs}`
      : paid ? `Invoice #${inv.id} (paid)` : `Invoice #${inv.id}: ${money(inv.amount)} due ${due}`,
    htmlText: intro,
    html,
    after: confirm,
    buttons: inv.payLinks,
    cta: link ? { label: 'View invoice', url: link } : null,
    note: inv.paymentNote || undefined,
    brand,
    reason: `You receive this because ${brandName} sent you an invoice for your account.`,
  });
  if (!sent) throw new HttpError(502, 'The email could not be sent. Please try again in a moment.');
  const { rows: [upd] } = await query(
    `UPDATE invoices SET ${urgent ? 'urgent_sent_at' : 'sent_at'} = now() WHERE id = $1 RETURNING ${urgent ? 'urgent_sent_at' : 'sent_at'} AS at`, [inv.id]);
  upd.sent_at = upd.at;
  try {
    await audit.record(req.user, 'sent', `${urgent ? 'urgent reminder for ' : ''}invoice #${inv.id} (${inv.email})`,
      [{ field: urgent ? `Urgent reminder (${hrs}) sent to` : 'Sent to', from: '', to: inv.email }],
      { recipients: await activityRecipients(), appUrl: baseUrl(req) });
  } catch (err) {
    console.error('Activity log failed:', err);
  }
  return { ok: true, to: inv.email, sentAt: upd.sent_at };
}

shared.patch('/invoices/:id', audited('edited', 'invoice', byParam, async (req, res) => {
  await assertInvoice(req, req.params.id);
  const status = req.body.status;
  if (!['unpaid', 'paid', 'void'].includes(status)) throw new HttpError(400, 'Bad status');
  const { rows: [before] } = await query('SELECT status FROM invoices WHERE id = $1', [Number(req.params.id)]);
  const { rows: [inv] } = await query(
    `UPDATE invoices SET status = $1, paid_at = CASE WHEN $1 = 'paid' THEN now() ELSE NULL END
     WHERE id = $2 RETURNING *`, [status, Number(req.params.id)],
  );
  if (!inv) throw new HttpError(404, 'Invoice not found');
  let thanked = null;
  if (status === 'paid' && before.status !== 'paid' && req.body.notify !== false) thanked = await sendPaymentThanks(inv);
  res.json({ ok: true, thanked });
}));

admin.get('/orders/:id/onboarding.csv', asyncRoute(async (req, res) => {
  await assertOrder(req, req.params.id);
  const { rows: [f] } = await query('SELECT * FROM order_files WHERE order_id = $1', [Number(req.params.id)]);
  if (!f) throw new HttpError(404, 'No onboarding CSV for this order');
  res.attachment(`order-${f.order_id}-onboarding.csv`).type('text/csv').send(onboarding.decrypt(f.data));
}));

admin.put('/settings', ownerOnly, audited('edited', 'settings', () => 'all', async (req, res) => {
  const b = req.body;
  const updates = {};
  if (b.order_notify_emails !== undefined) {
    const list = emailList(b.order_notify_emails);
    if (!list.length) throw new HttpError(400, 'Add at least one valid email for order notifications');
    updates.order_notify_emails = list.join(', ');
  }
  for (const [key, label] of [['website_url', 'Website'], ['privacy_url', 'Privacy policy'], ['terms_url', 'Terms']]) {
    if (b[key] !== undefined) {
      const url = str(b[key], 300);
      if (!/^https?:\/\/\S+$/i.test(url)) throw new HttpError(400, `${label} must be a full link starting with https://`);
      updates[key] = url;
    }
  }
  if (b.overdue_alert_emails !== undefined) {
    const list = emailList(b.overdue_alert_emails);
    if (!list.length) throw new HttpError(400, 'Add at least one valid email for unpaid-invoice alerts');
    updates.overdue_alert_emails = list.join(', ');
  }
  if (b.activity_emails !== undefined) {
    const list = emailList(b.activity_emails);
    if (!list.length) throw new HttpError(400, 'Add at least one valid email for team activity');
    updates.activity_emails = list.join(', ');
  }
  if (b.csv_required_min !== undefined) {
    const n = Number(b.csv_required_min);
    if (!Number.isInteger(n) || n < 0 || n > 10000) throw new HttpError(400, 'CSV threshold must be a whole number (0 = never required)');
    updates.csv_required_min = String(n);
  }
  if (b.support_email !== undefined) {
    const e = str(b.support_email, 200).toLowerCase();
    if (!isEmail(e)) throw new HttpError(400, 'Enter a valid email for cancellation requests');
    updates.support_email = e;
  }
  if (b.cancel_note !== undefined) {
    const note = str(b.cancel_note, 2000);
    if (!note) throw new HttpError(400, 'The cancellation note can\'t be empty');
    updates.cancel_note = note;
  }
  for (const [k, v] of Object.entries(updates)) {
    await query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
  }
  await syncEmailBrand();
  res.json({ ok: true });
}));

// Mailbox types and their standard prices: edit name, description, price and
// whether clients can order it.
admin.put('/pricing', ownerOnly, audited('edited', 'standardPricing', () => 'all', async (req, res) => {
  const prices = Array.isArray(req.body.prices) ? req.body.prices : [];
  for (const p of prices) {
    const type = str(p.inbox_type, 50);
    if (type === 'other') continue;
    const price = Number(p.price_per_mailbox);
    if (!(price >= 0)) throw new HttpError(400, 'Prices must be 0 or more');
    const label = p.label === undefined ? null : str(p.label, 80);
    if (label === '') throw new HttpError(400, 'Every mailbox type needs a name');
    await query(
      `UPDATE pricing SET price_per_mailbox = $1, label = COALESCE($2, label),
         description = COALESCE($3, description), active = COALESCE($4, active),
         needs_domains = COALESCE($6, needs_domains) WHERE inbox_type = $5`,
      [price, label, p.description === undefined ? null : str(p.description, 300),
       p.active === undefined ? null : Boolean(p.active), type, p.needs_domains === undefined ? null : Boolean(p.needs_domains)],
    );
  }
  res.json({ ok: true });
}));

admin.post('/pricing/types', ownerOnly, audited('edited', 'standardPricing', () => 'all', async (req, res) => {
  const label = str(req.body.label, 80);
  if (!label) throw new HttpError(400, 'Give the mailbox type a name');
  const price = Number(req.body.price_per_mailbox);
  if (!(price >= 0)) throw new HttpError(400, 'Price must be 0 or more');
  const { rows: [dup] } = await query('SELECT 1 FROM pricing WHERE lower(label) = lower($1)', [label]);
  if (dup) throw new HttpError(400, 'A mailbox type with that name already exists');
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'type';
  let slug = base;
  for (let n = 2; (await query('SELECT 1 FROM pricing WHERE inbox_type = $1', [slug])).rows.length; n++) slug = `${base}_${n}`;
  const { rows: [{ max }] } = await query("SELECT COALESCE(MAX(sort_order), 0) AS max FROM pricing WHERE inbox_type <> 'other'");
  await query(
    'INSERT INTO pricing (inbox_type, label, price_per_mailbox, sort_order, description, active) VALUES ($1, $2, $3, $4, $5, true)',
    [slug, label, price, Number(max) + 1, str(req.body.description, 300)],
  );
  res.status(201).json({ inbox_type: slug });
}));

admin.delete('/pricing/types/:type', ownerOnly, audited('edited', 'standardPricing', () => 'all', async (req, res) => {
  const type = str(req.params.type, 50);
  if (type === 'other') throw new HttpError(400, 'This type can\'t be removed');
  const { rows: [used] } = await query(
    `SELECT (SELECT count(*) FROM orders WHERE inbox_type = $1) + (SELECT count(*) FROM invoice_items WHERE inbox_type = $1) AS n`, [type],
  );
  if (Number(used.n)) throw new HttpError(400, 'This type is used by batches or invoices, so it can\'t be deleted. Untick "Offer to clients" to hide it instead.');
  await query('DELETE FROM client_pricing WHERE inbox_type = $1', [type]);
  await query('DELETE FROM pricing WHERE inbox_type = $1', [type]);
  res.json({ ok: true });
}));

admin.put('/clients/:id/pricing', audited('edited', 'clientPricing', byParam, async (req, res) => {
  const userId = Number(req.params.id);
  await assertClient(req, userId);
  const prices = Array.isArray(req.body.prices) ? req.body.prices : [];
  for (const p of prices) {
    const type = str(p.inbox_type, 50);
    // Blank means "use the standard price".
    if (p.price_per_mailbox === null || p.price_per_mailbox === '' || p.price_per_mailbox === undefined) {
      await query('DELETE FROM client_pricing WHERE user_id = $1 AND inbox_type = $2', [userId, type]);
      continue;
    }
    const price = Number(p.price_per_mailbox);
    if (!(price >= 0)) throw new HttpError(400, 'Prices must be 0 or more');
    await query(
      `INSERT INTO client_pricing (user_id, inbox_type, price_per_mailbox)
       SELECT $1, inbox_type, $3 FROM pricing WHERE inbox_type = $2
       ON CONFLICT (user_id, inbox_type) DO UPDATE SET price_per_mailbox = EXCLUDED.price_per_mailbox`,
      [userId, type, price],
    );
  }
  res.json({ ok: true });
}));

// ---- team (owner only)

// Analytics (owner) covers Mithmill's own clients; resellers' clients are on
// the Resellers page. Month-by-month figures for the last 12 months in
// BILLING_TZ, plus this month to date against the same days of last month.
// "Active" means activated before the end of that month and not cancelled by then.
admin.get('/analytics', ownerOnly, asyncRoute(async (req, res) => {
  const tz = process.env.BILLING_TZ || 'Asia/Dhaka';
  const today = billing.today();
  const local = (col) => `(${col} AT TIME ZONE $2)::date`;
  const activeAt = (cut) => `o.activated_at IS NOT NULL AND ${local('o.activated_at')} < ${cut}
    AND (o.status = 'active' OR (o.status = 'cancelled' AND ${local('o.cancelled_at')} >= ${cut}))`;
  const [months, compare, outstanding, byType, topClients, recent, bySeller] = await Promise.all([
    query(`WITH m AS (
             SELECT ms::date AS ms, (ms + interval '1 month')::date AS me,
                    LEAST((ms + interval '1 month')::date, $1::date + 1) AS cut
               FROM generate_series(date_trunc('month', $1::date) - interval '11 months', date_trunc('month', $1::date), interval '1 month') ms)
           SELECT to_char(m.ms, 'YYYY-MM') AS month,
             (SELECT COALESCE(SUM(amount), 0) FROM direct_invoices WHERE status = 'paid' AND ${local('paid_at')} >= m.ms AND ${local('paid_at')} < m.me) AS payments,
             (SELECT count(*) FROM direct_invoices WHERE status = 'paid' AND ${local('paid_at')} >= m.ms AND ${local('paid_at')} < m.me)::int AS payment_count,
             (SELECT COALESCE(SUM(amount), 0) FROM direct_invoices WHERE status <> 'void' AND COALESCE(issue_date, ${local('created_at')}) >= m.ms AND COALESCE(issue_date, ${local('created_at')}) < m.me) AS invoiced,
             (SELECT count(*) FROM users WHERE role = 'client' AND reseller_id IS NULL AND ${local('created_at')} >= m.ms AND ${local('created_at')} < m.me)::int AS new_clients,
             (SELECT count(DISTINCT o.user_id) FROM direct_orders o WHERE ${activeAt('m.cut')})::int AS active_clients,
             (SELECT COALESCE(SUM(o.quantity * o.price_per_mailbox), 0) FROM direct_orders o WHERE ${activeAt('m.cut')}) AS mrr,
             (SELECT COALESCE(SUM(o.quantity), 0) FROM direct_orders o WHERE o.inbox_type <> 'other' AND ${activeAt('m.cut')})::int AS mailboxes,
             (SELECT count(*) FROM direct_orders o WHERE ${local('o.created_at')} >= m.ms AND ${local('o.created_at')} < m.me)::int AS new_batches,
             (SELECT count(*) FROM direct_orders o WHERE o.status = 'cancelled' AND ${local('o.cancelled_at')} >= m.ms AND ${local('o.cancelled_at')} < m.me)::int AS cancellations
           FROM m ORDER BY m.ms`, [today, tz]),
    // Last month up to the same day of the month as today (clamped to its length).
    query(`WITH r AS (
             SELECT (date_trunc('month', $1::date) - interval '1 month')::date AS ps, date_trunc('month', $1::date)::date AS ts)
           SELECT
             LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts) AS pe,
             (SELECT COALESCE(SUM(amount), 0) FROM direct_invoices WHERE status = 'paid' AND ${local('paid_at')} >= r.ps AND ${local('paid_at')} < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts)) AS payments,
             (SELECT count(*) FROM direct_invoices WHERE status = 'paid' AND ${local('paid_at')} >= r.ps AND ${local('paid_at')} < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts))::int AS payment_count,
             (SELECT COALESCE(SUM(amount), 0) FROM direct_invoices WHERE status <> 'void' AND COALESCE(issue_date, ${local('created_at')}) >= r.ps AND COALESCE(issue_date, ${local('created_at')}) < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts)) AS invoiced,
             (SELECT count(*) FROM users WHERE role = 'client' AND reseller_id IS NULL AND ${local('created_at')} >= r.ps AND ${local('created_at')} < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts))::int AS new_clients,
             (SELECT count(*) FROM direct_orders o WHERE ${local('o.created_at')} >= r.ps AND ${local('o.created_at')} < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts))::int AS new_batches,
             (SELECT count(*) FROM direct_orders o WHERE o.status = 'cancelled' AND ${local('o.cancelled_at')} >= r.ps AND ${local('o.cancelled_at')} < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts))::int AS cancellations
           FROM r`, [today, tz]),
    query(`SELECT COALESCE(SUM(amount), 0) AS unpaid, count(*)::int AS unpaid_count,
             COALESCE(SUM(amount) FILTER (WHERE due_date < $1), 0) AS overdue,
             (count(*) FILTER (WHERE due_date < $1))::int AS overdue_count
           FROM direct_invoices WHERE status = 'unpaid'`, [today]),
    query(`SELECT p.label, SUM(o.quantity * o.price_per_mailbox) AS mrr, SUM(o.quantity)::int AS quantity
           FROM direct_orders o JOIN pricing p ON p.inbox_type = o.inbox_type
           WHERE o.status = 'active' GROUP BY p.label, p.sort_order ORDER BY mrr DESC`),
    query(`SELECT u.id, u.email, u.name, u.company,
             COALESCE(SUM(i.amount) FILTER (WHERE ${local('i.paid_at')} >= date_trunc('month', $1::date)), 0) AS this_month,
             COALESCE(SUM(i.amount) FILTER (WHERE ${local('i.paid_at')} >= date_trunc('month', $1::date) - interval '1 month'
                                             AND ${local('i.paid_at')} < date_trunc('month', $1::date)), 0) AS last_month
           FROM direct_invoices i JOIN users u ON u.id = i.user_id
           WHERE i.status = 'paid' AND ${local('i.paid_at')} >= date_trunc('month', $1::date) - interval '1 month'
           GROUP BY u.id ORDER BY this_month DESC, last_month DESC LIMIT 10`, [today, tz]),
    query(`SELECT i.id, i.amount, i.paid_at, i.description, u.email, u.company
           FROM direct_invoices i JOIN users u ON u.id = i.user_id
           WHERE i.status = 'paid' AND i.paid_at IS NOT NULL ORDER BY i.paid_at DESC, i.id DESC LIMIT 10`),
    // Commission view: payments received per seller, this month and last.
    query(`SELECT u.sold_by AS seller,
             COALESCE(SUM(i.amount) FILTER (WHERE ${local('i.paid_at')} >= date_trunc('month', $1::date)), 0) AS this_month,
             (count(*) FILTER (WHERE ${local('i.paid_at')} >= date_trunc('month', $1::date)))::int AS this_count,
             COALESCE(SUM(i.amount) FILTER (WHERE ${local('i.paid_at')} < date_trunc('month', $1::date)), 0) AS last_month,
             (count(*) FILTER (WHERE ${local('i.paid_at')} < date_trunc('month', $1::date)))::int AS last_count
           FROM direct_invoices i JOIN users u ON u.id = i.user_id
           WHERE i.status = 'paid' AND ${local('i.paid_at')} >= date_trunc('month', $1::date) - interval '1 month'
           GROUP BY 1 ORDER BY this_month DESC, last_month DESC`, [today, tz]),
  ]);
  res.json({
    today, months: months.rows, lastMonthToDate: compare.rows[0], outstanding: outstanding.rows[0],
    byType: byType.rows, topClients: topClients.rows, recentPayments: recent.rows, bySeller: bySeller.rows,
  });
}));

// Client / reseller locations (owner): last known city and country per profile,
// from where they accepted their invite and logged in.
admin.get('/locations', ownerOnly, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.company, u.role, u.reseller_id, u.password_set, u.city, u.region, u.country, u.country_code,
       u.block_vpn, r.brand_name AS reseller_name,
       (SELECT count(*) FROM login_events e WHERE e.user_id = u.id AND e.kind = 'vpn_blocked')::int AS vpn_blocked,
       (SELECT min(e.created_at) FROM login_events e WHERE e.user_id = u.id AND e.kind = 'invite') AS joined_at,
       (SELECT max(e.created_at) FROM login_events e WHERE e.user_id = u.id) AS last_seen,
       (SELECT e.ip FROM login_events e WHERE e.user_id = u.id AND e.kind <> 'vpn_blocked' ORDER BY e.created_at DESC LIMIT 1) AS last_ip,
       (SELECT count(*) FROM login_events e WHERE e.user_id = u.id AND e.kind = 'login')::int AS logins,
       (SELECT count(DISTINCT e.country) FROM login_events e WHERE e.user_id = u.id AND e.country <> '')::int AS countries
     FROM users u LEFT JOIN resellers r ON r.user_id = u.reseller_id
     WHERE u.role IN ('reseller', 'staff') OR (u.role = 'client' AND u.reseller_id IS NULL)
     ORDER BY last_seen DESC NULLS LAST, u.created_at DESC`);
  res.json({ people: rows });
}));

// "Block VPN" on or off for one client, reseller or team member.
admin.patch('/locations/:id', ownerOnly, audited('edited', 'user', byParam, async (req, res) => {
  const { rows: [u] } = await query(
    "UPDATE users SET block_vpn = $2 WHERE id = $1 AND role IN ('client', 'reseller', 'staff') RETURNING id",
    [Number(req.params.id) || 0, req.body.block_vpn === true]);
  if (!u) throw new HttpError(404, 'Person not found');
  res.json({ ok: true });
}));

admin.get('/locations/:id', ownerOnly, asyncRoute(async (req, res) => {
  const { rows: events } = await query(
    `SELECT kind, ip, city, region, country, country_code, user_agent, vpn, created_at FROM login_events
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [Number(req.params.id) || 0]);
  res.json({ events });
}));

admin.get('/team', ownerOnly, asyncRoute(async (req, res) => {
  const [members, invites, log] = await Promise.all([
    query("SELECT id, email, name, role, password_set, separated, created_at FROM users WHERE role IN ('admin', 'staff') ORDER BY role, created_at"),
    query(`SELECT id, email, name, separated, expires_at, created_at FROM invites
           WHERE role = 'staff' AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`),
    query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 300'),
  ]);
  res.json({ members: members.rows, invites: invites.rows, log: log.rows });
}));

admin.post('/team', ownerOnly, audited('invited', 'invite', (req, body) => (body ? body.id : null), async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const { rows: [found] } = await query('SELECT role FROM users WHERE email = $1', [email]);
  if (found && found.role === 'client') throw new HttpError(400, 'That email belongs to a client. Use a different email for the team member.');
  if (found) throw new HttpError(400, 'That person is already on the team');
  const name = str(req.body.name, 200);
  const token = crypto.randomBytes(24).toString('base64url');
  const { rows: [created] } = await query(
    `INSERT INTO invites (email, name, company, token, expires_at, role, separated, block_vpn)
     VALUES ($1, $2, 'Mithmill', $3, now() + interval '${INVITE_DAYS} days', 'staff', $4, $5) RETURNING id`,
    [email, name, token, req.body.separated === true, req.body.block_vpn === true],
  );
  const link = `${baseUrl(req)}/#/invite/${token}`;
  const emailed = await sendMail({
    to: email,
    subject: 'You have been added to the Mithmill admin team',
    text: `Hi ${name || 'there'},\n\n${req.user.name || req.user.email} added you to the Mithmill client portal admin team. ` +
      `${req.body.separated === true ? 'You can add your own clients and manage their orders and invoices' : 'You can add clients, send invites and manage orders and invoices'}.\n\nSet your password here (valid for ${INVITE_DAYS} days):\n\n${link}\n\nMithmill`,
    heading: 'Join the MithMill admin team',
    cta: { label: 'Join the team', url: link },
    reason: 'You receive this because the MithMill account owner added you to the admin team.',
  });
  res.status(201).json({ id: created.id, link, emailed });
}));

// Separated: the team member only sees the clients they added themselves.
admin.patch('/team/:id', ownerOnly, audited('edited', 'user', byParam, async (req, res) => {
  const { rows: [u] } = await query("UPDATE users SET separated = $2 WHERE id = $1 AND role = 'staff' RETURNING id",
    [Number(req.params.id), req.body.separated === true]);
  if (!u) throw new HttpError(400, 'Only team members can be separated');
  res.json({ ok: true });
}));

admin.delete('/team/:id', ownerOnly, audited('deleted', 'user', byParam, async (req, res) => {
  const { rows: [u] } = await query('SELECT role FROM users WHERE id = $1', [Number(req.params.id)]);
  if (!u || u.role !== 'staff') throw new HttpError(400, 'Only team members can be removed');
  await query('DELETE FROM users WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// Sends a sample of the branded email to the owner, to preview the design.
admin.post('/test-email', ownerOnly, asyncRoute(async (req, res) => {
  const portal = baseUrl(req);
  const emailed = await sendMail({
    to: req.user.email,
    subject: 'Test email from your MithMill client portal',
    text: `Hi ${req.user.name || 'there'},\n\nThis is a test of the emails your clients and team receive from the MithMill client portal: ` +
      `invites, renewal reminders, invoices and order updates all use this design.\n\nOpen your portal: ${portal}\n\n${billing.PAYMENT_NOTE}\n\nMithmill`,
    heading: 'Your portal emails look like this',
    cta: { label: 'Open the portal', url: portal },
    note: billing.PAYMENT_NOTE,
  });
  if (!emailed) throw new HttpError(500, 'The email could not be sent. Check the SMTP settings on Render.');
  res.json({ ok: true, to: req.user.email });
}));

admin.post('/billing/run', asyncRoute(async (req, res) => {
  res.json(await billing.runBilling());
}));

// ---- resellers (owner only)
// A reseller logs in to their own portal and manages their clients' billing.
// The owner sets their branding and white-label switch here, and sees all
// their clients, batches and invoices; nothing in the reseller portal shows that.

const RESELLER_STATS = `
  (SELECT count(*) FROM users c WHERE c.reseller_id = u.id)::int AS clients,
  (SELECT count(*) FROM orders o JOIN users c ON c.id = o.user_id WHERE c.reseller_id = u.id AND o.status = 'active')::int AS active_batches,
  (SELECT COALESCE(SUM(o.quantity), 0) FROM orders o JOIN users c ON c.id = o.user_id
    WHERE c.reseller_id = u.id AND o.status = 'active' AND o.inbox_type <> 'other')::int AS mailboxes,
  (SELECT COALESCE(SUM(o.quantity * o.price_per_mailbox), 0) FROM orders o JOIN users c ON c.id = o.user_id
    WHERE c.reseller_id = u.id AND o.status = 'active') AS monthly,
  (SELECT COALESCE(SUM(i.amount), 0) FROM invoices i JOIN users c ON c.id = i.user_id
    WHERE c.reseller_id = u.id AND i.status = 'unpaid') AS unpaid`;

// A reseller's settings without the logo bytes or the SMTP password.
function resellerOut(r) {
  const { logo, smtp_pass: pass, ...rest } = r;
  return { ...rest, has_logo: Boolean(r.logo_type), has_smtp_pass: Boolean(pass) };
}

async function findReseller(id) {
  const { rows: [r] } = await query(
    `SELECT r.*, u.id, u.email, u.name, u.company, u.password_set, u.created_at,
       EXISTS (SELECT 1 FROM invites i WHERE i.email = u.email AND i.accepted_at IS NULL AND i.expires_at > now()) AS invited,
       ${RESELLER_STATS}
     FROM users u JOIN resellers r ON r.user_id = u.id WHERE u.id = $1 AND u.role = 'reseller'`, [Number(id) || 0]);
  if (!r) throw new HttpError(404, 'Reseller not found');
  return r;
}

async function inviteReseller(req, user) {
  const token = crypto.randomBytes(24).toString('base64url');
  await query('DELETE FROM invites WHERE email = $1 AND accepted_at IS NULL', [user.email]);
  await query(
    `INSERT INTO invites (email, name, company, token, expires_at, role)
     VALUES ($1, $2, $3, $4, now() + interval '${INVITE_DAYS} days', 'reseller')`,
    [user.email, user.name || '', user.company || '', token],
  );
  const link = `${baseUrl(req)}/#/invite/${token}`;
  const reset = Boolean(user.password_set);
  const emailed = await sendMail({
    to: user.email,
    subject: reset ? 'Reset your MithMill reseller portal password' : "You're invited to the MithMill reseller portal",
    text: reset
      ? `Hi ${user.name || 'there'},\n\nUse this link to set a new password for the MithMill reseller portal (valid for ${INVITE_DAYS} days):\n\n${link}\n\nMithmill`
      : `Hi ${user.name || 'there'},\n\nYou've been invited to the MithMill reseller portal, where you can add your clients and manage ` +
        `their mailboxes, invoices and renewals.\n\nSet your password here (valid for ${INVITE_DAYS} days):\n\n${link}\n\nMithmill`,
    heading: reset ? 'Reset your password' : "You're invited to the MithMill reseller portal",
    cta: { label: reset ? 'Set a new password' : 'Accept invitation', url: link },
    reason: 'You receive this because MithMill added you as a reseller.',
  });
  return { link, emailed, reset };
}

admin.get('/resellers', ownerOnly, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.company, u.password_set, u.created_at,
       r.brand_name, r.white_label, r.active, r.logo_type <> '' AS has_logo, r.logo_version,
       EXISTS (SELECT 1 FROM invites i WHERE i.email = u.email AND i.accepted_at IS NULL AND i.expires_at > now()) AS invited,
       ${RESELLER_STATS}
     FROM users u JOIN resellers r ON r.user_id = u.id WHERE u.role = 'reseller' ORDER BY u.created_at DESC`);
  res.json({ resellers: rows, mailEnabled: mailEnabled() });
}));

admin.get('/resellers/:id', ownerOnly, asyncRoute(async (req, res) => {
  const r = await findReseller(req.params.id);
  const [clients, orders, invoices] = await Promise.all([
    query(`SELECT u.id, u.email, u.name, u.company, u.created_at,
             COALESCE(SUM(o.quantity) FILTER (WHERE o.status = 'active' AND o.inbox_type <> 'other'), 0)::int AS active_mailboxes,
             COALESCE(SUM(o.quantity * o.price_per_mailbox) FILTER (WHERE o.status = 'active'), 0) AS monthly,
             count(o.id)::int AS batch_count
           FROM users u LEFT JOIN orders o ON o.user_id = u.id
           WHERE u.reseller_id = $1 GROUP BY u.id ORDER BY u.created_at DESC`, [r.id]),
    query(`SELECT ${ORDER_COLUMNS}, o.user_id, u.email, u.company, u.name
           FROM orders o JOIN pricing p ON p.inbox_type = o.inbox_type JOIN users u ON u.id = o.user_id
           WHERE u.reseller_id = $1 ORDER BY (o.status = 'active') DESC, o.next_billing_date, o.id DESC`, [r.id]),
    query(`SELECT i.id, i.user_id, i.order_id, i.description, i.amount, i.issue_date, i.due_date, i.status, i.paid_at, i.created_at, u.email, u.company
           FROM invoices i JOIN users u ON u.id = i.user_id
           WHERE u.reseller_id = $1 ORDER BY (i.status = 'unpaid') DESC, i.due_date DESC, i.id DESC LIMIT 500`, [r.id]),
  ]);
  const { rows: [agreement] } = await query(
    'SELECT version, signer_name, signer_title, signed_at, ip FROM reseller_agreements WHERE reseller_id = $1 ORDER BY signed_at DESC LIMIT 1', [r.id]);
  res.json({ reseller: resellerOut(r), clients: clients.rows, orders: orders.rows, invoices: invoices.rows, today: billing.today(),
    mailAccount: process.env.SMTP_USER || '', agreement: agreement || null, agreementVersion: policy.VERSION });
}));

admin.post('/resellers', ownerOnly, asyncRoute(async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const { rows: [found] } = await query('SELECT role FROM users WHERE email = $1', [email]);
  if (found) throw new HttpError(400, `That email is already used by ${found.role === 'reseller' ? 'a reseller' : found.role === 'client' ? 'a client' : 'a team member'}`);
  const name = str(req.body.name, 200);
  const company = str(req.body.company, 200);
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const user = await inTransaction(async (client) => {
    const { rows: [u] } = await client.query(
      `INSERT INTO users (email, name, company, password_hash, password_set, role) VALUES ($1, $2, $3, $4, false, 'reseller') RETURNING *`,
      [email, name, company, unusable]);
    await client.query('INSERT INTO resellers (user_id, brand_name) VALUES ($1, $2)', [u.id, company || name]);
    return u;
  });
  const sent = await inviteReseller(req, user);
  await audit.record(req.user, 'added', `reseller ${company || name || email} <${email}>`, []);
  res.status(201).json({ id: user.id, ...sent });
}));

admin.post('/resellers/:id/invite', ownerOnly, asyncRoute(async (req, res) => {
  const r = await findReseller(req.params.id);
  res.json(await inviteReseller(req, r));
}));

const optEmail = (v, label) => {
  const e = str(v, 200).toLowerCase();
  if (e && !isEmail(e)) throw new HttpError(400, `${label} must be a valid email`);
  return e;
};
const optUrl = (v, label) => {
  const u = str(v, 300);
  if (u && !/^https?:\/\/\S+$/i.test(u)) throw new HttpError(400, `${label} must be a full link starting with https://`);
  return u;
};

admin.put('/resellers/:id', ownerOnly, asyncRoute(async (req, res) => {
  const r = await findReseller(req.params.id);
  const b = req.body;
  const v = {
    brand_name: b.brand_name === undefined ? r.brand_name : str(b.brand_name, 120),
    website: b.website === undefined ? r.website : optUrl(b.website, 'Website'),
    support_email: b.support_email === undefined ? r.support_email : optEmail(b.support_email, 'Support email'),
    payment_note: b.payment_note === undefined ? r.payment_note : str(b.payment_note, 3000),
    sender_name: b.sender_name === undefined ? r.sender_name : str(b.sender_name, 120),
    sender_email: b.sender_email === undefined ? r.sender_email : optEmail(b.sender_email, 'Sending email'),
    reply_to: b.reply_to === undefined ? r.reply_to : optEmail(b.reply_to, 'Reply-to email'),
    smtp_host: b.smtp_host === undefined ? r.smtp_host : str(b.smtp_host, 200),
    smtp_port: b.smtp_port === undefined ? r.smtp_port : Number(b.smtp_port) || 465,
    smtp_user: b.smtp_user === undefined ? r.smtp_user : str(b.smtp_user, 200),
    white_label: b.white_label === undefined ? r.white_label : Boolean(b.white_label),
    active: b.active === undefined ? r.active : Boolean(b.active),
    monthly_commitment: b.monthly_commitment === undefined ? r.monthly_commitment
      : (b.monthly_commitment === '' || b.monthly_commitment === null ? null : Math.max(0, Math.round(Number(b.monthly_commitment)) || 0)),
  };
  if (!v.brand_name) throw new HttpError(400, 'Give the reseller a brand name');
  if (v.smtp_port < 1 || v.smtp_port > 65535) throw new HttpError(400, 'SMTP port must be a number like 465 or 587');
  // A new password replaces the stored one; clearing the server removes it.
  let pass = r.smtp_pass;
  if (typeof b.smtp_pass === 'string' && b.smtp_pass) pass = onboarding.encrypt(b.smtp_pass.slice(0, 500));
  if (!v.smtp_host) { v.smtp_user = ''; pass = null; }
  await query(
    `UPDATE resellers SET brand_name = $1, website = $2, support_email = $3, payment_note = $4, sender_name = $5,
       sender_email = $6, reply_to = $7, smtp_host = $8, smtp_port = $9, smtp_user = $10, smtp_pass = $11,
       white_label = $12, active = $13, monthly_commitment = $15 WHERE user_id = $14`,
    [v.brand_name, v.website, v.support_email, v.payment_note, v.sender_name, v.sender_email, v.reply_to,
     v.smtp_host, v.smtp_port, v.smtp_user, pass, v.white_label, v.active, r.id, v.monthly_commitment]);
  const changes = Object.entries(v).filter(([k, val]) => String(val) !== String(r[k]))
    .map(([k, val]) => ({ field: k.replace(/_/g, ' '), from: String(r[k] ?? ''), to: String(val) }));
  if (pass !== r.smtp_pass) changes.push({ field: 'smtp password', from: '', to: pass ? '(changed)' : '(removed)' });
  if (changes.length) await audit.record(req.user, 'edited', `reseller ${r.brand_name || r.email} <${r.email}>`, changes);
  res.json({ ok: true });
}));

// Logo for white-label emails and invoices: a PNG/JPEG/GIF/WebP up to 300 KB,
// sent as a data URL. null removes it.
admin.put('/resellers/:id/logo', ownerOnly, asyncRoute(async (req, res) => {
  const r = await findReseller(req.params.id);
  if (req.body.data_url === null) {
    await query("UPDATE resellers SET logo = NULL, logo_type = '', logo_version = logo_version + 1 WHERE user_id = $1", [r.id]);
    return res.json({ ok: true });
  }
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data_url || ''));
  if (!m) throw new HttpError(400, 'Upload a PNG, JPG, GIF or WebP image');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > 300 * 1024) throw new HttpError(400, 'The logo must be 300 KB or smaller');
  await query('UPDATE resellers SET logo = $1, logo_type = $2, logo_version = logo_version + 1 WHERE user_id = $3', [data, m[1], r.id]);
  await audit.record(req.user, 'edited', `reseller ${r.brand_name || r.email} <${r.email}>`, [{ field: 'logo', from: '', to: '(new logo)' }]);
  res.json({ ok: true });
}));

// Sends a sample of this reseller's white-label email to the owner (even with
// white-label off), through their mail server if one is set.
admin.post('/resellers/:id/test-email', ownerOnly, asyncRoute(async (req, res) => {
  const r = await findReseller(req.params.id);
  const brand = await brands.forReseller(r.id);
  const sent = await sendMail({
    to: req.user.email,
    subject: `Test email: how ${brand.name}'s clients see their emails`,
    text: `Hi there,\n\nThis is how renewal reminders and invoices look for ${brand.name}'s clients when white-label is on.` +
      `${brand.paymentNote ? `\n\n${brand.paymentNote}` : ''}\n\n${brand.name}`,
    heading: 'Your batch will renew in 7 days',
    note: brand.paymentNote || undefined,
    brand,
    reason: `Test email for the reseller ${brand.name}, sent from the MithMill admin panel.`,
  });
  if (!sent) throw new HttpError(502, 'The email could not be sent. Check the mail server settings.');
  res.json({ ok: true, to: req.user.email, via: brand.smtp ? 'their mail server' : 'the MithMill mail account' });
}));

// Reseller earnings: payout = invoice total - their cost. Earned counts paid
// invoices, pending unpaid ones; balance is earned minus payouts made.
async function resellerEarnings(resellerId) {
  const { rows: [e] } = await query(
    `SELECT COALESCE(SUM(i.amount - COALESCE(i.reseller_cost, 0)) FILTER (WHERE i.status = 'paid'), 0) AS earned,
            COALESCE(SUM(i.amount - COALESCE(i.reseller_cost, 0)) FILTER (WHERE i.status = 'unpaid'), 0) AS pending,
            COALESCE(SUM(i.amount) FILTER (WHERE i.status = 'paid'), 0) AS sales,
            COALESCE(SUM(i.reseller_cost) FILTER (WHERE i.status = 'paid'), 0) AS cost,
            (SELECT COALESCE(SUM(amount), 0) FROM reseller_payouts WHERE reseller_id = $1) AS paid_out
       FROM invoices i JOIN users u ON u.id = i.user_id WHERE u.reseller_id = $1`, [resellerId]);
  return { ...e, balance: Math.round((e.earned - e.paid_out) * 100) / 100 };
}

async function resellerPrices(resellerId) {
  const { rows } = await query(
    `SELECT p.inbox_type, p.label, p.price_per_mailbox AS standard, rp.price_per_mailbox AS price
       FROM pricing p LEFT JOIN reseller_pricing rp ON rp.inbox_type = p.inbox_type AND rp.reseller_id = $1
      WHERE p.active OR rp.price_per_mailbox IS NOT NULL ORDER BY p.sort_order`, [resellerId]);
  return rows;
}

admin.get('/resellers/:id/agreement.pdf', ownerOnly, asyncRoute(async (req, res) => {
  const r = await findReseller(req.params.id);
  const { rows: [a] } = await query('SELECT pdf, version FROM reseller_agreements WHERE reseller_id = $1 ORDER BY signed_at DESC LIMIT 1', [r.id]);
  if (!a) throw new HttpError(404, 'This reseller hasn\'t signed the agreement yet');
  res.attachment(`Mithmill-Reseller-Agreement-v${a.version}-${(r.brand_name || r.email).replace(/[^A-Za-z0-9]+/g, '-')}.pdf`).type('application/pdf').send(a.pdf);
}));

admin.get('/resellers/:id/payouts', ownerOnly, asyncRoute(async (req, res) => {
  const r = await findReseller(req.params.id);
  const { rows: payouts } = await query('SELECT * FROM reseller_payouts WHERE reseller_id = $1 ORDER BY paid_on DESC, id DESC', [r.id]);
  res.json({ earnings: await resellerEarnings(r.id), prices: await resellerPrices(r.id), payouts });
}));

// Their price per mailbox per month for each type; blank = the standard price.
// Unpaid invoices are re-costed; paid ones keep the cost they were paid at.
admin.put('/resellers/:id/pricing', ownerOnly, asyncRoute(async (req, res) => {
  const r = await findReseller(req.params.id);
  const prices = Array.isArray(req.body.prices) ? req.body.prices : [];
  const changes = [];
  for (const p of prices) {
    const type = str(p.inbox_type, 50);
    const { rows: [old] } = await query('SELECT price_per_mailbox FROM reseller_pricing WHERE reseller_id = $1 AND inbox_type = $2', [r.id, type]);
    if (p.price === null || p.price === '' || p.price === undefined) {
      if (old) { await query('DELETE FROM reseller_pricing WHERE reseller_id = $1 AND inbox_type = $2', [r.id, type]); changes.push({ field: type, from: billing.money(old.price_per_mailbox), to: 'standard price' }); }
      continue;
    }
    const price = Number(p.price);
    if (!(price >= 0)) throw new HttpError(400, 'Prices must be 0 or more');
    await query(
      `INSERT INTO reseller_pricing (reseller_id, inbox_type, price_per_mailbox)
       SELECT $1, inbox_type, $3 FROM pricing WHERE inbox_type = $2
       ON CONFLICT (reseller_id, inbox_type) DO UPDATE SET price_per_mailbox = EXCLUDED.price_per_mailbox`, [r.id, type, price]);
    if (!old || old.price_per_mailbox !== price) changes.push({ field: type, from: old ? billing.money(old.price_per_mailbox) : 'standard price', to: billing.money(price) });
  }
  const { rows: unpaid } = await query(
    "SELECT i.id FROM invoices i JOIN users u ON u.id = i.user_id WHERE u.reseller_id = $1 AND i.status = 'unpaid'", [r.id]);
  for (const { id } of unpaid) await billing.resellerCost(id);
  if (changes.length) await audit.record(req.user, 'edited', `reseller prices for ${r.brand_name || r.email}`, changes);
  res.json({ ok: true, recalculated: unpaid.length });
}));

admin.post('/resellers/:id/payouts', ownerOnly, asyncRoute(async (req, res) => {
  const r = await findReseller(req.params.id);
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  if (!(amount > 0)) throw new HttpError(400, 'Enter the amount paid');
  const paidOn = str(req.body.paid_on, 10) || billing.today();
  if (!DATE_RE.test(paidOn)) throw new HttpError(400, 'Paid on must be a date');
  const { rows: [p] } = await query(
    'INSERT INTO reseller_payouts (reseller_id, amount, paid_on, note) VALUES ($1, $2, $3, $4) RETURNING id',
    [r.id, amount, paidOn, str(req.body.note, 500)]);
  await audit.record(req.user, 'added', `payout of ${billing.money(amount)} to reseller ${r.brand_name || r.email}`, []);
  res.status(201).json({ id: p.id });
}));

admin.delete('/resellers/:id/payouts/:pid', ownerOnly, asyncRoute(async (req, res) => {
  const r = await findReseller(req.params.id);
  const { rowCount } = await query('DELETE FROM reseller_payouts WHERE id = $1 AND reseller_id = $2', [Number(req.params.pid) || 0, r.id]);
  if (!rowCount) throw new HttpError(404, 'Payout not found');
  await audit.record(req.user, 'deleted', `a payout to reseller ${r.brand_name || r.email}`, []);
  res.json({ ok: true });
}));

// ---- reseller portal: their own settings

const resellerRouter = express.Router();
resellerRouter.use(auth, (req, res, next) => (req.user.role === 'reseller' ? next() : next(new HttpError(403, 'Resellers only'))));

// The agreement: its text, the reseller's details and rates, and whether they've signed this version.
resellerRouter.get('/agreement', asyncRoute(async (req, res) => {
  const r = await findReseller(req.user.id);
  const prices = (await resellerPrices(r.id)).map((p) => ({ label: p.label, price: p.price === null ? p.standard : p.price }));
  res.json({
    title: policy.TITLE, version: policy.VERSION, blocks: policy.blocks(), signed: await signedAgreement(r.id),
    reseller: { brand: r.brand_name, name: r.name, email: r.email, commitment: r.monthly_commitment }, prices,
  });
}));

// Signing: the reseller's name and a signature image (uploaded or drawn).
// The signed PDF is stored and emailed to the reseller and to MithMill.
resellerRouter.post('/agreement', asyncRoute(async (req, res) => {
  const r = await findReseller(req.user.id);
  if (await signedAgreement(r.id)) return res.json({ ok: true, already: true });
  const signerName = str(req.body.signer_name, 120);
  if (!signerName) throw new HttpError(400, 'Type your full name');
  if (req.body.agree !== true) throw new HttpError(400, 'Tick the box to confirm you agree');
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.signature || ''));
  if (!m) throw new HttpError(400, 'Add your signature: upload a PNG or JPG image, or draw it');
  const signature = Buffer.from(m[2], 'base64');
  if (signature.length > 1024 * 1024) throw new HttpError(400, 'The signature image must be 1 MB or smaller');
  if (signature.length < 200) throw new HttpError(400, 'The signature looks empty. Please sign again.');
  const prices = (await resellerPrices(r.id)).map((p) => ({ label: p.label, price: p.price === null ? p.standard : p.price }));
  const signedAt = new Date();
  const signer = { name: signerName, title: str(req.body.signer_title, 120) };
  let pdf;
  try {
    pdf = await agreementPdf.build({
      reseller: { brand: r.brand_name, name: r.name, company: r.company, email: r.email, commitment: r.monthly_commitment },
      prices, signer, signedAt, ip: req.ip, signature,
    });
  } catch (err) {
    console.error('Agreement PDF failed:', err);
    throw new HttpError(400, 'That signature image couldn\'t be used. Please upload a PNG or JPG, or draw it instead.');
  }
  await query(
    `INSERT INTO reseller_agreements (reseller_id, version, signer_name, signer_title, signature, signature_type, ip, user_agent, pdf, signed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [r.id, policy.VERSION, signer.name, signer.title, signature, m[1], req.ip || '', str(req.get('user-agent'), 300), pdf, signedAt]);
  await audit.record(req.user, 'added', `signed Reseller Agreement v${policy.VERSION} (${r.brand_name || r.email})`,
    [{ field: 'Signed by', from: '', to: signer.name }]);

  const filename = `Mithmill-Reseller-Agreement-v${policy.VERSION}-${(r.brand_name || r.email).replace(/[^A-Za-z0-9]+/g, '-')}.pdf`;
  const attachments = [{ filename, content: pdf, contentType: 'application/pdf' }];
  const when = billing.prettyDate(signedAt.toISOString().slice(0, 10));
  await sendMail({
    to: r.email,
    subject: `Your signed ${policy.TITLE}`,
    text: `Hi ${r.name || signer.name},\n\nThank you for signing the ${policy.TITLE} (version ${policy.VERSION}) on ${when}. ` +
      `A copy of the signed agreement is attached as a PDF for your records.\n\nYour reseller dashboard is ready to use: ${baseUrl(req)}\n\nMithmill`,
    heading: 'Your signed reseller agreement',
    cta: { label: 'Open your dashboard', url: baseUrl(req) },
    attachments,
    reason: 'You receive this because you signed the Mithmill reseller agreement.',
  });
  const owners = [...new Set([ADMIN_EMAIL, ...(await activityRecipients())].filter(Boolean))];
  if (owners.length) {
    await sendMail({
      to: owners.join(', '),
      subject: `Reseller agreement signed: ${r.brand_name || r.email}`,
      text: `${signer.name}${signer.title ? ` (${signer.title})` : ''} signed the ${policy.TITLE} (version ${policy.VERSION}) for ` +
        `${r.brand_name || r.company || 'their business'} <${r.email}> on ${signedAt.toUTCString()} from IP ${req.ip || 'unknown'}.\n\n` +
        `The signed PDF is attached.\n\nReseller page: ${baseUrl(req)}/#/admin/resellers/${r.id}`,
      heading: 'Reseller agreement signed',
      cta: { label: 'Open the reseller', url: `${baseUrl(req)}/#/admin/resellers/${r.id}` },
      attachments,
      reason: 'You receive this because a reseller signed the Mithmill reseller agreement.',
    });
  }
  res.json({ ok: true });
}));

resellerRouter.get('/agreement.pdf', asyncRoute(async (req, res) => {
  const { rows: [a] } = await query('SELECT pdf, version FROM reseller_agreements WHERE reseller_id = $1 ORDER BY signed_at DESC LIMIT 1', [req.user.id]);
  if (!a) throw new HttpError(404, 'You haven\'t signed the agreement yet');
  res.attachment(`Mithmill-Reseller-Agreement-v${a.version}.pdf`).type('application/pdf').send(a.pdf);
}));

// Everything else in the reseller portal needs the signed agreement.
resellerRouter.use(requireAgreement);

resellerRouter.get('/settings', asyncRoute(async (req, res) => {
  const r = await findReseller(req.user.id);
  res.json({
    brand_name: r.brand_name, white_label: r.white_label, logo: r.logo_type ? `/brand/${r.id}/logo?v=${r.logo_version}` : null,
    website: r.website, support_email: r.support_email, payment_note: r.payment_note, sender_name: r.sender_name,
    reply_to: r.reply_to, sender_email: r.sender_email || (r.smtp_host ? r.smtp_user : ''), mailEnabled: mailEnabled(),
  });
}));

// With white-label on, a reseller sets what their clients' emails say: sender
// name, reply-to and support emails, and their payment details. Brand name,
// logo and mail server are set by MithMill.
resellerRouter.put('/settings', asyncRoute(async (req, res) => {
  const r = await findReseller(req.user.id);
  if (!r.white_label) throw new HttpError(403, 'White-label is not turned on for your account. Please contact MithMill.');
  const b = req.body;
  const v = {
    sender_name: str(b.sender_name, 120),
    reply_to: optEmail(b.reply_to, 'Reply-to email'),
    support_email: optEmail(b.support_email, 'Support email'),
    payment_note: str(b.payment_note, 3000),
  };
  await query('UPDATE resellers SET sender_name = $1, reply_to = $2, support_email = $3, payment_note = $4 WHERE user_id = $5',
    [v.sender_name, v.reply_to, v.support_email, v.payment_note, r.id]);
  const changes = Object.entries(v).filter(([k, val]) => val !== r[k]).map(([k, val]) => ({ field: k.replace(/_/g, ' '), from: r[k] || '', to: val }));
  if (changes.length) await audit.record(req.user, 'edited', `reseller settings (${r.email})`, changes);
  res.json({ ok: true });
}));

// The reseller's Payouts page: earnings, their prices, a line per invoice and payouts received.
resellerRouter.get('/payouts', asyncRoute(async (req, res) => {
  const [invoices, payouts] = await Promise.all([
    query(`SELECT i.id, i.description, i.amount, i.reseller_cost, i.status, i.issue_date, i.paid_at, i.created_at, u.email, u.name, u.company
             FROM invoices i JOIN users u ON u.id = i.user_id
            WHERE u.reseller_id = $1 AND i.status <> 'void' ORDER BY COALESCE(i.issue_date, i.created_at::date) DESC, i.id DESC LIMIT 500`, [req.user.id]),
    query('SELECT id, amount, paid_on, note FROM reseller_payouts WHERE reseller_id = $1 ORDER BY paid_on DESC, id DESC', [req.user.id]),
  ]);
  res.json({ earnings: await resellerEarnings(req.user.id), prices: await resellerPrices(req.user.id), invoices: invoices.rows, payouts: payouts.rows });
}));

app.use('/api/reseller', shared);
app.use('/api/reseller', resellerRouter);

// Reseller logos, public so email clients can load them.
app.get('/brand/:id/logo', asyncRoute(async (req, res) => {
  const { rows: [r] } = await query("SELECT logo, logo_type FROM resellers WHERE user_id = $1 AND logo_type <> ''", [Number(req.params.id) || 0]);
  if (!r) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400').type(r.logo_type).send(r.logo);
}));

app.use('/api/admin', shared);
app.use('/api/admin', admin);

// External scheduler hook (e.g. cron-job.org hitting this daily). Also wakes a
// sleeping free-tier service so reminders still go out.
app.all('/api/cron/billing', asyncRoute(async (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET) throw new HttpError(403, 'Forbidden');
  res.json(await billing.runBilling());
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------- static + errors

// The page is served with its CSS/JS URLs stamped with a per-deploy version,
// and nothing is cached without re-checking, so a deploy reaches every
// browser on the next page load instead of hiding behind a stale copy.
const fs = require('fs');
const ASSET_VERSION = crypto.createHash('sha1')
  .update(['app.js', 'styles.css'].map((f) => fs.readFileSync(path.join(__dirname, 'public', f))).join(''))
  .digest('hex').slice(0, 10);
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('href="styles.css"', `href="styles.css?v=${ASSET_VERSION}"`)
  .replace('src="app.js"', `src="app.js?v=${ASSET_VERSION}"`);
const sendIndex = (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(INDEX_HTML);
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong' : err.message, ...(err.code ? { code: err.code } : {}) });
});

// ---------------------------------------------------------------- boot

async function ensureAdmin() {
  if (!ADMIN_EMAIL) return;
  const { rows: [user] } = await query('SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL]);
  if (user) {
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    return;
  }
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    console.warn('ADMIN_PASSWORD (8+ chars) is required to create the admin account');
    return;
  }
  await query(
    "INSERT INTO users (email, name, company, password_hash, role) VALUES ($1, 'Mithmill Admin', 'Mithmill', $2, 'admin')",
    [ADMIN_EMAIL, await bcrypt.hash(password, 10)],
  );
  console.log(`Created admin account ${ADMIN_EMAIL}`);
}

// One-time fix: invoices created with mailbox lines but no batch (before the
// invoice editor could add batches) never counted on the client's dashboard.
// Turn them into active monthly batches, once.
async function linkStandaloneInvoices() {
  const flag = 'standalone_invoices_linked_v1';
  const { rows: [done] } = await query('SELECT 1 FROM settings WHERE key = $1', [flag]);
  if (done) return;
  const { rows } = await query(
    `SELECT i.id FROM invoices i
      WHERE i.order_id IS NULL AND i.status <> 'void'
        AND EXISTS (SELECT 1 FROM invoice_items it JOIN pricing p ON p.inbox_type = it.inbox_type WHERE it.invoice_id = i.id)
      ORDER BY i.id`,
  );
  for (const { id } of rows) {
    try {
      const ids = await createBatchesFromInvoice(id, 1);
      console.log(`Invoice #${id}: added batch(es) ${ids.join(', ')}`);
    } catch (err) {
      console.warn(`Invoice #${id}: not converted (${err.message})`);
    }
  }
  await query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [flag, new Date().toISOString()]);
}

// One-time: recurring Other lines saved on batch invoices before they became batches.
async function syncExistingOtherLines() {
  const flag = 'other_lines_synced_v1';
  const { rows: [done] } = await query('SELECT 1 FROM settings WHERE key = $1', [flag]);
  if (done) return;
  const { rows } = await query(
    `SELECT DISTINCT i.id FROM invoices i JOIN invoice_items it ON it.invoice_id = i.id
      WHERE i.order_id IS NOT NULL AND i.status <> 'void' AND it.inbox_type = 'other' AND it.recurring ORDER BY i.id`);
  for (const { id } of rows) {
    const ids = await syncRecurringOtherLines(id);
    if (ids.length) console.log(`Invoice #${id}: recurring Other line(s) now batch(es) ${ids.join(', ')}`);
  }
  await query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [flag, new Date().toISOString()]);
}

// One-time: Sold by moved from batches/invoices to the client. Each client
// takes the value from their most recent invoice or batch that had one.
async function moveSoldByToClients() {
  const flag = 'sold_by_on_clients_v1';
  const { rows: [done] } = await query('SELECT 1 FROM settings WHERE key = $1', [flag]);
  if (done) return;
  await query(`UPDATE users u SET sold_by = s.sold_by FROM (
      SELECT DISTINCT ON (user_id) user_id, sold_by FROM (
        SELECT user_id, sold_by, created_at FROM invoices WHERE sold_by <> ''
        UNION ALL SELECT user_id, sold_by, created_at FROM orders WHERE sold_by <> '') x
      ORDER BY user_id, created_at DESC) s
    WHERE u.id = s.user_id AND u.sold_by = ''`);
  await query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [flag, new Date().toISOString()]);
}

async function scheduledBilling() {
  try {
    const result = await billing.runBilling();
    if (result.remindersSent) console.log('Billing run:', result);
  } catch (err) {
    console.error('Billing run failed:', err);
  }
}

(async () => {
  await migrate();
  await ensureAdmin();
  await linkStandaloneInvoices();
  await syncExistingOtherLines();
  await moveSoldByToClients();
  // Resellers' invoices from before reseller prices existed get their cost worked out.
  const { rows: uncosted } = await query(
    'SELECT i.id FROM invoices i JOIN users u ON u.id = i.user_id WHERE u.reseller_id IS NOT NULL AND i.reseller_cost IS NULL');
  for (const { id } of uncosted) await billing.resellerCost(id);
  // One-time: pre-warmed types don't need the client's domains.
  await query(`INSERT INTO settings (key, value) VALUES ('prewarmed_no_domains_v1', now()::text) ON CONFLICT (key) DO NOTHING`).then(async (r) => {
    if (r.rowCount) await query("UPDATE pricing SET needs_domains = false WHERE label ~* 'pre.?warm' OR inbox_type ~* 'pre_?warm'");
  });
  await syncEmailBrand();
  // One-time switch requested by Mithmill: cancellation requests go to support@.
  await query(
    `INSERT INTO settings (key, value) VALUES ('support_email_moved_v1', now()::text) ON CONFLICT (key) DO NOTHING`,
  ).then(async (r) => {
    if (r.rowCount) await query("UPDATE settings SET value = 'support@mithmill.com' WHERE key = 'support_email'");
  });
  app.listen(PORT, () => console.log(`Mithmill client portal on :${PORT}`));
  scheduledBilling();
  setInterval(scheduledBilling, 60 * 60 * 1000);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

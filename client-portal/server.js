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
  constructor(status, message) {
    super(message);
    this.status = status;
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
  let uid;
  try {
    uid = jwt.verify(req.cookies.session || '', SESSION_SECRET).uid;
  } catch {
    throw new HttpError(401, 'Please log in');
  }
  const { rows: [user] } = await query(
    'SELECT id, email, name, company, role FROM users WHERE id = $1', [uid],
  );
  if (!user) throw new HttpError(401, 'Please log in');
  req.user = user;
  next();
});

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
  setSession(res, user);
  res.json({ ok: true, role: user.role });
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
  if (!invite) throw new HttpError(404, 'This invite link is invalid or has expired. Ask Mithmill for a new one.');
  return invite;
}

app.get('/api/invites/:token', asyncRoute(async (req, res) => {
  const invite = await findInvite(req.params.token);
  const { rows: [existing] } = await query('SELECT password_set FROM users WHERE email = $1', [invite.email]);
  res.json({ email: invite.email, name: invite.name, company: invite.company, reset: Boolean(existing && existing.password_set) });
}));

app.post('/api/invites/:token/accept', asyncRoute(async (req, res) => {
  const invite = await findInvite(req.params.token);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const name = str(req.body.name, 200) || invite.name;
  const hash = await bcrypt.hash(password, 10);

  const { rows: [user] } = await query(
    `INSERT INTO users (email, name, company, password_hash, role) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_set = true,
       name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE users.name END
     RETURNING *`,
    [invite.email, name, invite.company, hash, invite.role === 'staff' ? 'staff' : 'client'],
  );
  await query('UPDATE invites SET accepted_at = now() WHERE id = $1', [invite.id]);
  setSession(res, user);
  res.json({ ok: true, role: user.role });
}));

// ---------------------------------------------------------------- client

// Standard prices with this client's overrides applied.
const CLIENT_PRICING_SQL = `
  SELECT p.inbox_type, p.label, p.description, p.active, COALESCE(cp.price_per_mailbox, p.price_per_mailbox) AS price_per_mailbox
    FROM pricing p
    LEFT JOIN client_pricing cp ON cp.inbox_type = p.inbox_type AND cp.user_id = $1`;

const ORDER_COLUMNS = `o.id, o.inbox_type, p.label AS inbox_label, o.quantity, o.price_per_mailbox,
  o.domains, o.usernames, o.domain_access_method, o.registrar, o.registrar_email, o.domain_access_notes,
  o.sequencer, o.sequencer_workspace, o.sequencer_email, o.sequencer_notes, o.notes, o.status,
  o.activated_at, o.next_billing_date, o.created_at, o.batch_name, o.billing_months`;

app.get('/api/dashboard', auth, asyncRoute(async (req, res) => {
  const uid = req.user.id;
  const settings = await getSettings();
  const [orders, invoices, notifications, pricing] = await Promise.all([
    query(`SELECT ${ORDER_COLUMNS}, (SELECT row_count FROM order_files f WHERE f.order_id = o.id) AS csv_rows
           FROM orders o JOIN pricing p ON p.inbox_type = o.inbox_type
           WHERE o.user_id = $1 ORDER BY o.created_at DESC`, [uid]),
    query(`SELECT id, order_id, description, amount, issue_date, due_date, status, paid_at, created_at
           FROM invoices WHERE user_id = $1 AND status <> 'void' ORDER BY due_date DESC, id DESC`, [uid]),
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
  const b = req.body;
  const { rows: [price] } = await query(`${CLIENT_PRICING_SQL} WHERE p.inbox_type = $2`,
    [req.user.id, str(b.inbox_type, 50)]);
  if (!price || price.inbox_type === 'other' || !price.active) throw new HttpError(400, 'Choose an inbox type');

  // Onboarding sheet: optional, required for big orders, and the source of
  // domains/usernames when those fields are left empty.
  const settings = await getSettings();
  let sheet = null;
  if (b.onboarding_csv) {
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
  if (csvMin > 0 && quantity >= csvMin && !sheet) {
    throw new HttpError(400, `Orders of ${csvMin} or more mailboxes need the onboarding CSV. Download the sample, fill it in and upload it.`);
  }
  const domains = str(b.domains, 20000) || (sheet ? sheet.domains.join('\n') : '');
  const usernames = str(b.usernames, 20000) ||
    (sheet ? sheet.rows.map((r) => `${r['Full name']} - ${r.Username}@${r['Domain name']}`).join('\n').slice(0, 20000) : '');
  if (!domains) throw new HttpError(400, 'Add at least one domain');
  if (!usernames) throw new HttpError(400, 'Add at least one username');
  const accessMethod = str(b.domain_access_method, 50);
  if (!ACCESS_METHODS.includes(accessMethod)) throw new HttpError(400, 'Choose how we get domain access');
  const sequencer = str(b.sequencer, 50);
  if (!SEQUENCERS.includes(sequencer)) throw new HttpError(400, 'Choose your sequencer');
  const registrarEmail = str(b.registrar_email, 200);
  const sequencerEmail = str(b.sequencer_email, 200);
  if (registrarEmail && !isEmail(registrarEmail)) throw new HttpError(400, 'Registrar login email looks invalid');
  if (sequencerEmail && !isEmail(sequencerEmail)) throw new HttpError(400, 'Sequencer login email looks invalid');

  const { rows: [order] } = await query(
    `INSERT INTO orders (user_id, inbox_type, quantity, price_per_mailbox, domains, usernames,
       domain_access_method, registrar, registrar_email, domain_access_notes,
       sequencer, sequencer_workspace, sequencer_email, sequencer_notes, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [req.user.id, price.inbox_type, quantity, price.price_per_mailbox, domains, usernames,
     accessMethod, str(b.registrar, 200), registrarEmail, str(b.domain_access_notes),
     sequencer, str(b.sequencer_workspace, 200), sequencerEmail, str(b.sequencer_notes), str(b.notes)],
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

admin.get('/overview', asyncRoute(async (req, res) => {
  const [orders, clients, invites, invoices, pricing, clientPricing] = await Promise.all([
    query(`SELECT ${ORDER_COLUMNS}, o.admin_notes, o.user_id, u.email, u.name, u.company,
             f.row_count AS csv_rows, f.filename AS csv_filename
           FROM orders o JOIN pricing p ON p.inbox_type = o.inbox_type JOIN users u ON u.id = o.user_id
           LEFT JOIN order_files f ON f.order_id = o.id
           ORDER BY (o.status IN ('pending','in_progress')) DESC, o.created_at DESC`),
    query(`SELECT u.id, u.email, u.name, u.company, u.created_at, u.password_set,
             EXISTS (SELECT 1 FROM invites i WHERE i.email = u.email AND i.accepted_at IS NULL AND i.expires_at > now()) AS invited,
             COALESCE(SUM(o.quantity) FILTER (WHERE o.status = 'active' AND o.inbox_type <> 'other'), 0)::int AS active_mailboxes,
             COALESCE(SUM(o.quantity * o.price_per_mailbox) FILTER (WHERE o.status = 'active'), 0) AS monthly,
             count(o.id)::int AS batch_count,
             (SELECT count(*) FROM invoices i WHERE i.user_id = u.id)::int AS invoice_count
           FROM users u LEFT JOIN orders o ON o.user_id = u.id
           WHERE u.role = 'client' GROUP BY u.id ORDER BY u.created_at DESC`),
    query(`SELECT id, email, name, company, expires_at, created_at FROM invites
           WHERE accepted_at IS NULL AND expires_at > now() AND role = 'client' ORDER BY created_at DESC`),
    query(`SELECT i.*, u.email, u.company FROM invoices i JOIN users u ON u.id = i.user_id
           ORDER BY (i.status = 'unpaid') DESC, i.due_date DESC, i.id DESC LIMIT 500`),
    query("SELECT * FROM pricing WHERE inbox_type <> 'other' ORDER BY sort_order"),
    query('SELECT user_id, inbox_type, price_per_mailbox FROM client_pricing'),
  ]);
  res.json({
    orders: orders.rows, clients: clients.rows, invites: invites.rows,
    invoices: invoices.rows, pricing: pricing.rows, clientPricing: clientPricing.rows, settings: await getSettings(), mailEnabled: mailEnabled(), today: billing.today(),
  });
}));

admin.patch('/orders/:id', audited('edited', 'order', byParam, async (req, res) => {
  const id = Number(req.params.id);
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
admin.delete('/orders/:id', audited('deleted', 'order', byParam, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [o] } = await query('SELECT id FROM orders WHERE id = $1', [id]);
  if (!o) throw new HttpError(404, 'Batch not found');
  await query("UPDATE invoices SET status = 'void' WHERE order_id = $1 AND status = 'unpaid'", [id]);
  await query('DELETE FROM orders WHERE id = $1', [id]);
  res.json({ ok: true });
}));

admin.post('/invites', audited('invited', 'invite', (req, body) => (body ? body.id : null), async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const { rows: [found] } = await query('SELECT role, name, company, password_set FROM users WHERE email = $1', [email]);
  if (found && found.role !== 'client') throw new HttpError(400, 'That email belongs to a team member');
  // A client you added yourself but who never joined gets a normal invite, not a reset.
  const existing = found && found.password_set ? found : null;
  const name = str(req.body.name, 200) || (found && found.name) || '';
  const company = str(req.body.company, 200) || (found && found.company) || '';

  const token = crypto.randomBytes(24).toString('base64url');
  const { rows: [created] } = await query(
    `INSERT INTO invites (email, name, company, token, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '${INVITE_DAYS} days') RETURNING id`,
    [email, name, company, token],
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
admin.post('/clients', audited('added', 'user', (req, body) => (body ? body.id : null), async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const { rows: [found] } = await query('SELECT id, role FROM users WHERE email = $1', [email]);
  if (found) throw new HttpError(400, found.role === 'client' ? 'A client with that email already exists' : 'That email belongs to a team member');
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const { rows: [user] } = await query(
    `INSERT INTO users (email, name, company, password_hash, password_set) VALUES ($1, $2, $3, $4, false) RETURNING id`,
    [email, str(req.body.name, 200), str(req.body.company, 200), unusable],
  );
  res.status(201).json({ id: user.id });
}));

// Edits a client's details. Changing the login email is owner-only; the old
// address is told, and pending invites to it stop working.
admin.patch('/clients/:id', audited('edited', 'user', byParam, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [client] } = await query("SELECT * FROM users WHERE id = $1 AND role = 'client'", [id]);
  if (!client) throw new HttpError(404, 'Client not found');
  const email = req.body.email === undefined ? client.email : str(req.body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const name = req.body.name === undefined ? client.name : str(req.body.name, 200);
  const company = req.body.company === undefined ? client.company : str(req.body.company, 200);
  const emailChanged = email !== client.email;
  if (emailChanged) {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only the account owner can change a client\'s email');
    const { rows: [taken] } = await query('SELECT role FROM users WHERE email = $1 AND id <> $2', [email, id]);
    if (taken) throw new HttpError(400, taken.role === 'client' ? 'Another client already uses that email' : 'That email belongs to a team member');
  }
  await query('UPDATE users SET email = $1, name = $2, company = $3 WHERE id = $4', [email, name, company, id]);
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
admin.delete('/clients/:id', ownerOnly, audited('deleted', 'user', byParam, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [client] } = await query("SELECT email FROM users WHERE id = $1 AND role = 'client'", [id]);
  if (!client) throw new HttpError(404, 'Client not found');
  await query('DELETE FROM invites WHERE email = $1 AND accepted_at IS NULL', [client.email]);
  await query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// Adds a batch on a client's behalf: an existing purchase (with its billing
// dates) or a new order taken outside the portal.
admin.post('/orders', audited('added', 'order', (req, body) => (body ? body.id : null), async (req, res) => {
  const b = req.body;
  const { rows: [client] } = await query("SELECT id, email, name, password_set FROM users WHERE id = $1 AND role = 'client'", [Number(b.user_id)]);
  if (!client) throw new HttpError(400, 'Choose a client');
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
       activated_at, billing_day, next_billing_date, created_at, billing_months)
     VALUES ($1, $2, $3, $4, $5, $6, '', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
    [client.id, type.inbox_type, quantity, price, str(b.domains, 20000), str(b.usernames, 20000),
     str(b.sequencer, 50), str(b.sequencer_workspace, 200), str(b.admin_notes), str(b.batch_name, 200), status,
     status === 'pending' ? null : `${start}T00:00:00Z`, status === 'active' ? day : null,
     next, `${start}T00:00:00Z`, months],
  );

  // Optionally record the current billing period (the one ending at the next renewal).
  let invoiceId = null;
  if (status === 'active' && ['paid', 'unpaid'].includes(b.current_period)) {
    let periodStart = start;
    while (billing.nextBillingDate(periodStart, day, months) < next) periodStart = billing.nextBillingDate(periodStart, day, months);
    const inv = await billing.createOrderInvoice({ ...order, label: type.label }, periodStart,
      `Batch #${order.id}: ${quantity} × ${type.label} mailboxes (from ${billing.prettyDate(periodStart)})`,
      `Mailboxes from ${billing.prettyDate(periodStart)}`);
    if (inv) {
      invoiceId = inv.id;
      await query('UPDATE invoices SET issue_date = $1 WHERE id = $2', [periodStart, inv.id]);
      if (b.current_period === 'paid') {
        await query("UPDATE invoices SET status = 'paid', paid_at = $1 WHERE id = $2", [`${periodStart}T12:00:00Z`, inv.id]);
      }
    }
  }
  if (b.notify === true && client.password_set) {
    await billing.notify(client, `New batch added: ${quantity} ${type.label} mailboxes`,
      `Batch #${order.id} has been added to your account.`);
  }
  res.status(201).json({ id: order.id, invoiceId });
}));

admin.delete('/invites/:id', audited('revoked', 'invite', byParam, async (req, res) => {
  await query('DELETE FROM invites WHERE id = $1 AND accepted_at IS NULL', [Number(req.params.id)]);
  res.json({ ok: true });
}));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validates the invoice editor's payload. Returns the cleaned header and items.
async function parseInvoice(body) {
  const userId = Number(body.user_id);
  const { rows: [user] } = await query("SELECT id, email, name FROM users WHERE id = $1 AND role = 'client'", [userId]);
  if (!user) throw new HttpError(400, 'Choose a client');

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
    user, orderId, issueDate, dueDate, items, discount, amount, description, notes: str(body.notes, 5000),
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
    `SELECT i.*, u.email, u.name, u.company FROM invoices i JOIN users u ON u.id = i.user_id
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
  return { ...inv, items, pricing, paymentNote: billing.PAYMENT_NOTE, payLinks: inv.status === 'unpaid' ? billing.payButtons(inv) : [] };
}

app.get('/api/invoices/:id', auth, asyncRoute(async (req, res) => {
  res.json(await invoiceWithItems(Number(req.params.id), req.user.id));
}));

admin.get('/invoices/:id', asyncRoute(async (req, res) => {
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
         sequencer, batch_name, status, activated_at, billing_day, next_billing_date, created_at, billing_months, from_invoice_id)
       VALUES ($1, $2, $3, $4, '', '', '', '', $5, 'active', $6, $7, $8, $6, $9, $10) RETURNING id`,
      [inv.user_id, it.inbox_type, it.quantity, Math.round((it.unit_price / months) * 100) / 100,
       otherName(it), `${start}T00:00:00Z`, day, next, months, invoiceId],
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
         sequencer, batch_name, status, activated_at, billing_day, next_billing_date, created_at, billing_months, from_invoice_id)
       VALUES ($1, 'other', $2, $3, '', '', '', '', $4, $5, $6, $7, $8, $6, $9, $10) RETURNING id`,
      [inv.user_id, it.quantity, price, name, base.status === 'active' ? 'active' : base.status,
       `${start}T00:00:00Z`, day, base.status === 'active' ? next : null, months, invoiceId]);
    ids.push(o.id);
  }
  return ids;
}

admin.post('/invoices/:id/batches', audited('edited', 'invoice', byParam, async (req, res) => {
  const ids = await createBatchesFromInvoice(Number(req.params.id), parseCycle(req.body));
  res.status(201).json({ batchIds: ids });
}));

admin.post('/invoices', audited('added', 'invoice', (req, body) => (body ? body.id : null), async (req, res) => {
  const v = await parseInvoice(req.body);
  const cycle = req.body.create_batches === true && !v.orderId ? parseCycle(req.body) : null;
  const id = await inTransaction(async (client) => {
    const { rows: [inv] } = await client.query(
      `INSERT INTO invoices (user_id, order_id, description, amount, discount, due_date, issue_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [v.user.id, v.orderId, v.description, v.amount, v.discount, v.dueDate, v.issueDate, v.notes],
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
  if (req.body.notify !== false) {
    await billing.notify(v.user, `New invoice: ${billing.money(v.amount)}`,
      `Invoice #${id} for ${billing.money(v.amount)} (${v.description}) is due on ${billing.prettyDate(v.dueDate)}.`,
      { buttons: v.status === 'paid' ? [] : billing.payButtons({ notes: v.notes, amount: v.amount }) });
  }
  res.status(201).json({ id, batchIds });
}));

admin.put('/invoices/:id', audited('edited', 'invoice', byParam, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [existing] } = await query('SELECT id FROM invoices WHERE id = $1', [id]);
  if (!existing) throw new HttpError(404, 'Invoice not found');
  const v = await parseInvoice(req.body);
  await inTransaction(async (client) => {
    await client.query(
      `UPDATE invoices SET user_id = $1, order_id = $2, description = $3, amount = $4, discount = $5,
         due_date = $6, issue_date = $7, notes = $8 WHERE id = $9`,
      [v.user.id, v.orderId, v.description, v.amount, v.discount, v.dueDate, v.issueDate, v.notes, id],
    );
    await writeItems(client, id, v.items);
    if (v.status === 'paid') await client.query("UPDATE invoices SET status = 'paid', paid_at = $1 WHERE id = $2", [v.paidAt, id]);
    if (v.status === 'unpaid') await client.query("UPDATE invoices SET status = 'unpaid', paid_at = NULL WHERE id = $1", [id]);
  });
  const batchIds = await syncRecurringOtherLines(id);
  if (req.body.notify === true) {
    await billing.notify(v.user, `Invoice #${id} updated: ${billing.money(v.amount)}`,
      `Invoice #${id} has been updated. Total ${billing.money(v.amount)}, due on ${billing.prettyDate(v.dueDate)}.`,
      { buttons: v.status === 'paid' ? [] : billing.payButtons({ notes: v.notes, amount: v.amount }) });
  }
  res.json({ ok: true, batchIds });
}));

// Emails the invoice to the client: every line, the total and due date, the
// notes (payment details) and a link to it in the portal once they've joined.
admin.post('/invoices/:id/send', asyncRoute(async (req, res) => {
  if (!mailEnabled()) throw new HttpError(503, 'Email is not set up, so the invoice can\'t be sent');
  const inv = await invoiceWithItems(Number(req.params.id));
  if (inv.status === 'void') throw new HttpError(400, 'This invoice is void');
  const { rows: [client] } = await query('SELECT password_set FROM users WHERE id = $1', [inv.user_id]);
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
  const html = `
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
    ${inv.notes ? `<div style="margin:0 0 16px;padding:14px 16px;background:${C.bg};border:1px solid ${C.line};border-radius:10px;font-size:14px;line-height:1.6;color:${C.text}"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};margin-bottom:6px">Notes</div>${emailTemplate.linkify(esc(inv.notes)).replace(/\n/g, '<br>')}</div>` : ''}`;

  const name = inv.name || 'there';
  const intro = paid
    ? `Hi ${name},\n\nHere is your paid invoice #${inv.id} for ${money(inv.amount)}. Thank you!`
    : `Hi ${name},\n\nHere is your invoice #${inv.id} for ${money(inv.amount)}, due on ${due}.`;
  const confirm = paid ? '' : 'To confirm your payment, please reply to this email with a screenshot of the payment, ' +
    'or share it in your dedicated WhatsApp or Slack group with us (recommended).';
  const link = client && client.password_set ? `${baseUrl(req)}/#/invoice/${inv.id}` : null;
  const text = [
    intro,
    inv.items.map((it) => `• ${lineName(it)}: ${qty(it.quantity)} × ${money(it.unit_price)} = ${money(it.quantity * it.unit_price)}`).join('\n'),
    `${inv.discount ? `Discount: −${money(inv.discount)}\n` : ''}${paid ? 'Total paid' : 'Total due'}: ${money(inv.amount)}${paid ? '' : ` (due ${due})`}`,
    inv.payLinks.map((b) => `${b.label}: ${b.url}`).join('\n'),
    inv.notes ? `Notes:\n${inv.notes}` : '',
    confirm,
    link ? `View your invoice: ${link}` : '',
    billing.PAYMENT_NOTE,
    'Mithmill',
  ].filter(Boolean).join('\n\n');

  const sent = await sendMail({
    to: inv.email,
    subject: paid ? `Invoice #${inv.id} from MithMill (paid)` : `Invoice #${inv.id} from MithMill: ${money(inv.amount)} due ${due}`,
    text,
    heading: paid ? `Invoice #${inv.id} (paid)` : `Invoice #${inv.id}: ${money(inv.amount)} due ${due}`,
    htmlText: intro,
    html,
    after: confirm,
    buttons: inv.payLinks,
    cta: link ? { label: 'View invoice', url: link } : null,
    note: billing.PAYMENT_NOTE,
    reason: 'You receive this because MithMill sent you an invoice for your account.',
  });
  if (!sent) throw new HttpError(502, 'The email could not be sent. Please try again in a moment.');
  const { rows: [upd] } = await query('UPDATE invoices SET sent_at = now() WHERE id = $1 RETURNING sent_at', [inv.id]);
  try {
    await audit.record(req.user, 'sent', `invoice #${inv.id} (${inv.email})`, [{ field: 'Sent to', from: '', to: inv.email }],
      { recipients: await activityRecipients(), appUrl: baseUrl(req) });
  } catch (err) {
    console.error('Activity log failed:', err);
  }
  res.json({ ok: true, to: inv.email, sentAt: upd.sent_at });
}));

admin.patch('/invoices/:id', audited('edited', 'invoice', byParam, async (req, res) => {
  const status = req.body.status;
  if (!['unpaid', 'paid', 'void'].includes(status)) throw new HttpError(400, 'Bad status');
  const { rows: [inv] } = await query(
    `UPDATE invoices SET status = $1, paid_at = CASE WHEN $1 = 'paid' THEN now() ELSE NULL END
     WHERE id = $2 RETURNING *`, [status, Number(req.params.id)],
  );
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (status === 'paid') {
    const { rows: [user] } = await query('SELECT id, email, name FROM users WHERE id = $1', [inv.user_id]);
    await billing.notify(user, `Payment received: ${billing.money(inv.amount)}`,
      `Thank you! We've received your payment for invoice #${inv.id} (${inv.description}).`);
  }
  res.json({ ok: true });
}));

admin.get('/orders/:id/onboarding.csv', asyncRoute(async (req, res) => {
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
         description = COALESCE($3, description), active = COALESCE($4, active) WHERE inbox_type = $5`,
      [price, label, p.description === undefined ? null : str(p.description, 300),
       p.active === undefined ? null : Boolean(p.active), type],
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
  const { rows: [client] } = await query("SELECT id FROM users WHERE id = $1 AND role = 'client'", [userId]);
  if (!client) throw new HttpError(404, 'Client not found');
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

// Analytics (owner): month-by-month figures for the last 12 months in
// BILLING_TZ, plus this month to date against the same days of last month.
// "Active" means activated before the end of that month and not cancelled by then.
admin.get('/analytics', ownerOnly, asyncRoute(async (req, res) => {
  const tz = process.env.BILLING_TZ || 'Asia/Dhaka';
  const today = billing.today();
  const local = (col) => `(${col} AT TIME ZONE $2)::date`;
  const activeAt = (cut) => `o.activated_at IS NOT NULL AND ${local('o.activated_at')} < ${cut}
    AND (o.status = 'active' OR (o.status = 'cancelled' AND ${local('o.cancelled_at')} >= ${cut}))`;
  const [months, compare, outstanding, byType, topClients, recent] = await Promise.all([
    query(`WITH m AS (
             SELECT ms::date AS ms, (ms + interval '1 month')::date AS me,
                    LEAST((ms + interval '1 month')::date, $1::date + 1) AS cut
               FROM generate_series(date_trunc('month', $1::date) - interval '11 months', date_trunc('month', $1::date), interval '1 month') ms)
           SELECT to_char(m.ms, 'YYYY-MM') AS month,
             (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE status = 'paid' AND ${local('paid_at')} >= m.ms AND ${local('paid_at')} < m.me) AS payments,
             (SELECT count(*) FROM invoices WHERE status = 'paid' AND ${local('paid_at')} >= m.ms AND ${local('paid_at')} < m.me)::int AS payment_count,
             (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE status <> 'void' AND COALESCE(issue_date, ${local('created_at')}) >= m.ms AND COALESCE(issue_date, ${local('created_at')}) < m.me) AS invoiced,
             (SELECT count(*) FROM users WHERE role = 'client' AND ${local('created_at')} >= m.ms AND ${local('created_at')} < m.me)::int AS new_clients,
             (SELECT count(DISTINCT o.user_id) FROM orders o WHERE ${activeAt('m.cut')})::int AS active_clients,
             (SELECT COALESCE(SUM(o.quantity * o.price_per_mailbox), 0) FROM orders o WHERE ${activeAt('m.cut')}) AS mrr,
             (SELECT COALESCE(SUM(o.quantity), 0) FROM orders o WHERE o.inbox_type <> 'other' AND ${activeAt('m.cut')})::int AS mailboxes,
             (SELECT count(*) FROM orders o WHERE ${local('o.created_at')} >= m.ms AND ${local('o.created_at')} < m.me)::int AS new_batches,
             (SELECT count(*) FROM orders o WHERE o.status = 'cancelled' AND ${local('o.cancelled_at')} >= m.ms AND ${local('o.cancelled_at')} < m.me)::int AS cancellations
           FROM m ORDER BY m.ms`, [today, tz]),
    // Last month up to the same day of the month as today (clamped to its length).
    query(`WITH r AS (
             SELECT (date_trunc('month', $1::date) - interval '1 month')::date AS ps, date_trunc('month', $1::date)::date AS ts)
           SELECT
             LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts) AS pe,
             (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE status = 'paid' AND ${local('paid_at')} >= r.ps AND ${local('paid_at')} < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts)) AS payments,
             (SELECT count(*) FROM invoices WHERE status = 'paid' AND ${local('paid_at')} >= r.ps AND ${local('paid_at')} < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts))::int AS payment_count,
             (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE status <> 'void' AND COALESCE(issue_date, ${local('created_at')}) >= r.ps AND COALESCE(issue_date, ${local('created_at')}) < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts)) AS invoiced,
             (SELECT count(*) FROM users WHERE role = 'client' AND ${local('created_at')} >= r.ps AND ${local('created_at')} < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts))::int AS new_clients,
             (SELECT count(*) FROM orders o WHERE ${local('o.created_at')} >= r.ps AND ${local('o.created_at')} < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts))::int AS new_batches,
             (SELECT count(*) FROM orders o WHERE o.status = 'cancelled' AND ${local('o.cancelled_at')} >= r.ps AND ${local('o.cancelled_at')} < LEAST(r.ps + (extract(day FROM $1::date)::int), r.ts))::int AS cancellations
           FROM r`, [today, tz]),
    query(`SELECT COALESCE(SUM(amount), 0) AS unpaid, count(*)::int AS unpaid_count,
             COALESCE(SUM(amount) FILTER (WHERE due_date < $1), 0) AS overdue,
             (count(*) FILTER (WHERE due_date < $1))::int AS overdue_count
           FROM invoices WHERE status = 'unpaid'`, [today]),
    query(`SELECT p.label, SUM(o.quantity * o.price_per_mailbox) AS mrr, SUM(o.quantity)::int AS quantity
           FROM orders o JOIN pricing p ON p.inbox_type = o.inbox_type
           WHERE o.status = 'active' GROUP BY p.label, p.sort_order ORDER BY mrr DESC`),
    query(`SELECT u.id, u.email, u.name, u.company,
             COALESCE(SUM(i.amount) FILTER (WHERE ${local('i.paid_at')} >= date_trunc('month', $1::date)), 0) AS this_month,
             COALESCE(SUM(i.amount) FILTER (WHERE ${local('i.paid_at')} >= date_trunc('month', $1::date) - interval '1 month'
                                             AND ${local('i.paid_at')} < date_trunc('month', $1::date)), 0) AS last_month
           FROM invoices i JOIN users u ON u.id = i.user_id
           WHERE i.status = 'paid' AND ${local('i.paid_at')} >= date_trunc('month', $1::date) - interval '1 month'
           GROUP BY u.id ORDER BY this_month DESC, last_month DESC LIMIT 10`, [today, tz]),
    query(`SELECT i.id, i.amount, i.paid_at, i.description, u.email, u.company
           FROM invoices i JOIN users u ON u.id = i.user_id
           WHERE i.status = 'paid' AND i.paid_at IS NOT NULL ORDER BY i.paid_at DESC, i.id DESC LIMIT 10`),
  ]);
  res.json({
    today, months: months.rows, lastMonthToDate: compare.rows[0], outstanding: outstanding.rows[0],
    byType: byType.rows, topClients: topClients.rows, recentPayments: recent.rows,
  });
}));

admin.get('/team', ownerOnly, asyncRoute(async (req, res) => {
  const [members, invites, log] = await Promise.all([
    query("SELECT id, email, name, role, password_set, created_at FROM users WHERE role IN ('admin', 'staff') ORDER BY role, created_at"),
    query(`SELECT id, email, name, expires_at, created_at FROM invites
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
    `INSERT INTO invites (email, name, company, token, expires_at, role)
     VALUES ($1, $2, 'Mithmill', $3, now() + interval '${INVITE_DAYS} days', 'staff') RETURNING id`,
    [email, name, token],
  );
  const link = `${baseUrl(req)}/#/invite/${token}`;
  const emailed = await sendMail({
    to: email,
    subject: 'You have been added to the Mithmill admin team',
    text: `Hi ${name || 'there'},\n\n${req.user.name || req.user.email} added you to the Mithmill client portal admin team. ` +
      `You can add clients, send invites and manage orders and invoices.\n\nSet your password here (valid for ${INVITE_DAYS} days):\n\n${link}\n\nMithmill`,
    heading: 'Join the MithMill admin team',
    cta: { label: 'Join the team', url: link },
    reason: 'You receive this because the MithMill account owner added you to the admin team.',
  });
  res.status(201).json({ id: created.id, link, emailed });
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
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong' : err.message });
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

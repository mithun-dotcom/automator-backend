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

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Admins only'));
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
    `INSERT INTO users (email, name, company, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_set = true,
       name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE users.name END
     RETURNING *`,
    [invite.email, name, invite.company, hash],
  );
  await query('UPDATE invites SET accepted_at = now() WHERE id = $1', [invite.id]);
  setSession(res, user);
  res.json({ ok: true, role: user.role });
}));

// ---------------------------------------------------------------- client

// Standard prices with this client's overrides applied.
const CLIENT_PRICING_SQL = `
  SELECT p.inbox_type, p.label, COALESCE(cp.price_per_mailbox, p.price_per_mailbox) AS price_per_mailbox
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
    query(`${CLIENT_PRICING_SQL} ORDER BY p.sort_order`, [uid]),
  ]);

  const active = orders.rows.filter((o) => o.status === 'active');
  const pending = orders.rows.filter((o) => o.status === 'pending' || o.status === 'in_progress');
  const unpaid = invoices.rows.filter((i) => i.status === 'unpaid');
  const nextRenewal = active.map((o) => o.next_billing_date).filter(Boolean).sort()[0] || null;

  res.json({
    user: req.user,
    stats: {
      activeMailboxes: active.reduce((n, o) => n + o.quantity, 0),
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
  csv_required_min: '10',
  support_email: ADMIN_EMAIL,
  cancel_note: `To cancel a subscription, email us at ${ADMIN_EMAIL || 'our support address'} or send us a message ` +
    'wherever you are connected with us (WhatsApp, Telegram, Slack, Skype…). Subscriptions can\'t be cancelled from the portal.',
};

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
  if (!price) throw new HttpError(400, 'Choose an inbox type');

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
        `Domains:\n${domains}\n\nOpen the admin panel: ${baseUrl(req)}/#/admin`,
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

admin.get('/overview', asyncRoute(async (req, res) => {
  const [orders, clients, invites, invoices, pricing, clientPricing] = await Promise.all([
    query(`SELECT ${ORDER_COLUMNS}, o.admin_notes, o.user_id, u.email, u.name, u.company,
             f.row_count AS csv_rows, f.filename AS csv_filename
           FROM orders o JOIN pricing p ON p.inbox_type = o.inbox_type JOIN users u ON u.id = o.user_id
           LEFT JOIN order_files f ON f.order_id = o.id
           ORDER BY (o.status IN ('pending','in_progress')) DESC, o.created_at DESC`),
    query(`SELECT u.id, u.email, u.name, u.company, u.created_at, u.password_set,
             EXISTS (SELECT 1 FROM invites i WHERE i.email = u.email AND i.accepted_at IS NULL AND i.expires_at > now()) AS invited,
             COALESCE(SUM(o.quantity) FILTER (WHERE o.status = 'active'), 0)::int AS active_mailboxes,
             COALESCE(SUM(o.quantity * o.price_per_mailbox) FILTER (WHERE o.status = 'active'), 0) AS monthly
           FROM users u LEFT JOIN orders o ON o.user_id = u.id
           WHERE u.role = 'client' GROUP BY u.id ORDER BY u.created_at DESC`),
    query(`SELECT id, email, name, company, expires_at, created_at FROM invites
           WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`),
    query(`SELECT i.*, u.email, u.company FROM invoices i JOIN users u ON u.id = i.user_id
           ORDER BY (i.status = 'unpaid') DESC, i.due_date DESC, i.id DESC LIMIT 500`),
    query('SELECT * FROM pricing ORDER BY sort_order'),
    query('SELECT user_id, inbox_type, price_per_mailbox FROM client_pricing'),
  ]);
  res.json({
    orders: orders.rows, clients: clients.rows, invites: invites.rows,
    invoices: invoices.rows, pricing: pricing.rows, clientPricing: clientPricing.rows, settings: await getSettings(), mailEnabled: mailEnabled(), today: billing.today(),
  });
}));

admin.patch('/orders/:id', asyncRoute(async (req, res) => {
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
        `UPDATE orders SET status = 'active', activated_at = COALESCE(activated_at, now()),
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
        await billing.notify(client, `Batch #${id} cancelled`,
          `Your ${order.quantity} ${order.label} mailboxes (batch #${id}) have been cancelled and will not renew.`);
      }
    }
  }
  res.json({ ok: true, invoiceId });
}));

admin.post('/invites', asyncRoute(async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const { rows: [found] } = await query('SELECT role, name, company, password_set FROM users WHERE email = $1', [email]);
  if (found && found.role === 'admin') throw new HttpError(400, 'That email belongs to an admin');
  // A client you added yourself but who never joined gets a normal invite, not a reset.
  const existing = found && found.password_set ? found : null;
  const name = str(req.body.name, 200) || (found && found.name) || '';
  const company = str(req.body.company, 200) || (found && found.company) || '';

  const token = crypto.randomBytes(24).toString('base64url');
  await query(
    `INSERT INTO invites (email, name, company, token, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '${INVITE_DAYS} days')`,
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
  });
  res.status(201).json({ link, emailed, reset: Boolean(existing) });
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
admin.post('/clients', asyncRoute(async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const { rows: [found] } = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (found) throw new HttpError(400, 'A client with that email already exists');
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const { rows: [user] } = await query(
    `INSERT INTO users (email, name, company, password_hash, password_set) VALUES ($1, $2, $3, $4, false) RETURNING id`,
    [email, str(req.body.name, 200), str(req.body.company, 200), unusable],
  );
  res.status(201).json({ id: user.id });
}));

// Adds a batch on a client's behalf: an existing purchase (with its billing
// dates) or a new order taken outside the portal.
admin.post('/orders', asyncRoute(async (req, res) => {
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

admin.delete('/invites/:id', asyncRoute(async (req, res) => {
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
      `INSERT INTO invoice_items (invoice_id, inbox_type, batch_name, description, quantity, unit_price, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [invoiceId, it.inbox_type, it.batch_name, it.description, it.quantity, it.unit_price, i],
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
    'SELECT inbox_type, batch_name, description, quantity, unit_price FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order, id',
    [id],
  );
  const { rows: pricing } = await query('SELECT inbox_type, label FROM pricing ORDER BY sort_order');
  // Invoices from before line items existed show as a single line.
  if (!items.length) items.push({ inbox_type: '', batch_name: '', description: inv.description, quantity: 1, unit_price: inv.amount + inv.discount });
  return { ...inv, items, pricing, paymentNote: billing.PAYMENT_NOTE };
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
  const valid = new Set(types.map((t) => t.inbox_type));
  const { rows: items } = await query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order, id', [invoiceId]);
  const lines = items.filter((it) => valid.has(it.inbox_type));
  if (!lines.length) throw new HttpError(400, 'This invoice has no mailbox lines (Google Workspace, Azure or Microsoft 365)');
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
         sequencer, batch_name, status, activated_at, billing_day, next_billing_date, created_at, billing_months)
       VALUES ($1, $2, $3, $4, '', '', '', '', $5, 'active', $6, $7, $8, $6, $9) RETURNING id`,
      [inv.user_id, it.inbox_type, it.quantity, Math.round((it.unit_price / months) * 100) / 100, it.batch_name,
       `${start}T00:00:00Z`, day, next, months],
    );
    ids.push(o.id);
  }
  await query('UPDATE invoices SET order_id = $1, period_start = $2 WHERE id = $3', [ids[0], start, invoiceId]);
  return ids;
}

admin.post('/invoices/:id/batches', asyncRoute(async (req, res) => {
  const ids = await createBatchesFromInvoice(Number(req.params.id), parseCycle(req.body));
  res.status(201).json({ batchIds: ids });
}));

admin.post('/invoices', asyncRoute(async (req, res) => {
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
  if (req.body.notify !== false) {
    await billing.notify(v.user, `New invoice: ${billing.money(v.amount)}`,
      `Invoice #${id} for ${billing.money(v.amount)} (${v.description}) is due on ${billing.prettyDate(v.dueDate)}.`);
  }
  res.status(201).json({ id, batchIds });
}));

admin.put('/invoices/:id', asyncRoute(async (req, res) => {
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
  if (req.body.notify === true) {
    await billing.notify(v.user, `Invoice #${id} updated: ${billing.money(v.amount)}`,
      `Invoice #${id} has been updated. Total ${billing.money(v.amount)}, due on ${billing.prettyDate(v.dueDate)}.`);
  }
  res.json({ ok: true });
}));

admin.patch('/invoices/:id', asyncRoute(async (req, res) => {
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

admin.put('/settings', asyncRoute(async (req, res) => {
  const b = req.body;
  const updates = {};
  if (b.order_notify_emails !== undefined) {
    const list = emailList(b.order_notify_emails);
    if (!list.length) throw new HttpError(400, 'Add at least one valid email for order notifications');
    updates.order_notify_emails = list.join(', ');
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
  res.json({ ok: true });
}));

admin.put('/pricing', asyncRoute(async (req, res) => {
  const prices = Array.isArray(req.body.prices) ? req.body.prices : [];
  for (const p of prices) {
    const price = Number(p.price_per_mailbox);
    if (!(price >= 0)) throw new HttpError(400, 'Prices must be 0 or more');
    await query('UPDATE pricing SET price_per_mailbox = $1 WHERE inbox_type = $2', [price, str(p.inbox_type, 50)]);
  }
  res.json({ ok: true });
}));

admin.put('/clients/:id/pricing', asyncRoute(async (req, res) => {
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

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
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
  app.listen(PORT, () => console.log(`Mithmill client portal on :${PORT}`));
  scheduledBilling();
  setInterval(scheduledBilling, 60 * 60 * 1000);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

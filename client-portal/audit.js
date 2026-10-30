// Activity log for the admin panel. Each audited route takes a snapshot of the
// thing it changes before and after, records the field-by-field differences,
// and emails the owner when a team member (staff) made the change.
const { query } = require('./db');
const { sendMail } = require('./mailer');
const billing = require('./billing');

const money = (n) => (n === null || n === undefined || n === '' ? '' : billing.money(n));
const day = (d) => (d ? billing.prettyDate(d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : '');
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '');

// ---- snapshots: { title, fields: { Label: 'value' } }

async function order(id) {
  const { rows: [o] } = await query(
    `SELECT o.*, p.label, u.email, u.company FROM orders o
     JOIN pricing p ON p.inbox_type = o.inbox_type JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [id],
  );
  if (!o) return null;
  return {
    title: `batch #${o.id}${o.batch_name ? ` "${o.batch_name}"` : ''} (${o.company || o.email})`,
    fields: {
      Client: `${o.company ? `${o.company} ` : ''}<${o.email}>`,
      'Batch name': o.batch_name,
      Type: o.label,
      Status: o.status === 'in_progress' ? 'Setting up' : cap(o.status),
      Mailboxes: String(o.quantity),
      'Price per mailbox': money(o.price_per_mailbox),
      'Billing cycle': cap(billing.cycleLabel(billing.cycleMonths(o))),
      'Next renewal': day(o.next_billing_date),
      Domains: o.domains,
      Usernames: o.usernames,
      'Internal notes': o.admin_notes,
    },
  };
}

async function invoice(id) {
  const { rows: [i] } = await query(
    'SELECT i.*, u.email, u.company FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.id = $1', [id],
  );
  if (!i) return null;
  const { rows: items } = await query(
    `SELECT it.*, p.label FROM invoice_items it LEFT JOIN pricing p ON p.inbox_type = it.inbox_type
      WHERE it.invoice_id = $1 ORDER BY it.sort_order, it.id`, [id],
  );
  const lines = items.map((it) => [
    `${Number(it.quantity)} × ${it.label || 'Item'}`, it.batch_name, it.description,
    `@ ${money(it.unit_price)}${it.recurring ? ' (recurring)' : ''}`,
  ].filter(Boolean).join(' · ')).join('\n');
  return {
    title: `invoice #${i.id} (${i.company || i.email})`,
    fields: {
      Client: `${i.company ? `${i.company} ` : ''}<${i.email}>`,
      Status: cap(i.status),
      'Paid on': day(i.paid_at),
      Amount: money(i.amount),
      Discount: Number(i.discount) ? money(i.discount) : '',
      'Issue date': day(i.issue_date),
      'Due date': day(i.due_date),
      'Linked batch': i.order_id ? `#${i.order_id}` : '',
      Lines: lines,
      Notes: i.notes,
    },
  };
}

async function user(idOrEmail) {
  const byEmail = typeof idOrEmail === 'string' && idOrEmail.includes('@');
  const { rows: [u] } = await query(`SELECT * FROM users WHERE ${byEmail ? 'email' : 'id'} = $1`, [byEmail ? idOrEmail.toLowerCase() : Number(idOrEmail)]);
  if (!u) return null;
  return {
    title: `${u.role === 'client' ? 'client' : 'team member'} ${u.company || u.name || u.email} <${u.email}>`,
    fields: { Email: u.email, Name: u.name, Company: u.company, 'Sold by': u.sold_by, Role: u.role === 'staff' ? 'Team member' : cap(u.role), ...(u.role === 'staff' ? { Separated: u.separated ? 'Yes, sees only their own clients' : 'No' } : {}), Account: u.password_set ? 'Joined' : 'Not joined yet' },
  };
}

async function invite(id) {
  const { rows: [i] } = await query('SELECT * FROM invites WHERE id = $1', [id]);
  if (!i) return null;
  return { title: `invite for ${i.email}`, fields: { Email: i.email, Name: i.name, Company: i.company, Type: i.role === 'staff' ? (i.separated ? 'Team member (separated)' : 'Team member') : 'Client' } };
}

async function clientPricing(userId) {
  const u = await user(userId);
  if (!u) return null;
  const { rows } = await query(
    `SELECT p.label, cp.price_per_mailbox FROM pricing p
      LEFT JOIN client_pricing cp ON cp.inbox_type = p.inbox_type AND cp.user_id = $1
      WHERE p.inbox_type <> 'other' ORDER BY p.sort_order`, [Number(userId)],
  );
  return {
    title: `pricing for ${u.fields.Company || u.fields.Name || u.fields.Email} <${u.fields.Email}>`,
    fields: Object.fromEntries(rows.map((r) => [r.label, r.price_per_mailbox === null ? 'Standard' : money(r.price_per_mailbox)])),
  };
}

async function standardPricing() {
  const { rows } = await query("SELECT inbox_type, label, price_per_mailbox, active, description FROM pricing WHERE inbox_type <> 'other' ORDER BY sort_order");
  return {
    title: 'mailbox types and standard prices',
    fields: Object.fromEntries(rows.map((r) => [`Type "${r.inbox_type}"`,
      `${r.label}: ${money(r.price_per_mailbox)}${r.active ? '' : ' (hidden from clients)'}${r.description ? ` · ${r.description}` : ''}`])),
  };
}

async function settings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const labels = {
    order_notify_emails: 'New-order emails', csv_required_min: 'CSV required from (mailboxes)',
    cancel_note: 'Cancellation note', support_email: 'Cancellation requests go to', activity_emails: 'Team activity emails', overdue_alert_emails: 'Unpaid-invoice alerts', website_url: 'Website', privacy_url: 'Privacy policy link', terms_url: 'Terms link',
  };
  return { title: 'settings', fields: Object.fromEntries(rows.filter((r) => labels[r.key]).map((r) => [labels[r.key], r.value])) };
}

const snapshots = { order, invoice, user, invite, clientPricing, standardPricing, settings };

// ---- diffing + recording

function diff(before, after) {
  const keys = [...new Set([...Object.keys(before ? before.fields : {}), ...Object.keys(after ? after.fields : {})])];
  return keys
    .map((k) => ({ field: k, from: before ? before.fields[k] || '' : '', to: after ? after.fields[k] || '' : '' }))
    .filter((c) => c.from !== c.to);
}

const VERB = { added: 'added', edited: 'edited', deleted: 'deleted', invited: 'sent an invite', revoked: 'revoked', cancelled: 'cancelled', sent: 'emailed' };

async function record(actor, action, title, changes, { recipients, appUrl } = {}) {
  await query(
    `INSERT INTO audit_log (actor_id, actor_name, actor_email, actor_role, action, title, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.id, actor.name || '', actor.email, actor.role, action, title, JSON.stringify(changes)],
  );
  // The owner hears about team members' changes; their own aren't emailed.
  if (actor.role !== 'staff' || !recipients || !recipients.length) return;
  const who = actor.name ? `${actor.name} (${actor.email})` : actor.email;
  const verb = VERB[action] || action;
  const detail = changes.length
    ? changes.map((c) => {
      const multi = /\n/.test(c.from) || /\n/.test(c.to) || c.from.length > 60 || c.to.length > 60;
      if (['added', 'invited'].includes(action)) return multi ? `• ${c.field}:\n${c.to}` : `• ${c.field}: ${c.to}`;
      if (['deleted', 'revoked'].includes(action)) return multi ? `• ${c.field}:\n${c.from}` : `• ${c.field}: ${c.from}`;
      const from = c.from || '(empty)';
      const to = c.to || '(empty)';
      return multi ? `• ${c.field}\n  Before:\n${from}\n  Now:\n${to}` : `• ${c.field}: ${from} → ${to}`;
    }).join('\n')
    : '(no field changes)';
  const heading = { added: 'Details', deleted: 'What was deleted', invited: 'Details' }[action] || 'Changes (before → now)';
  await sendMail({
    to: recipients.join(', '),
    subject: `[Mithmill portal] ${actor.name || actor.email} ${verb} ${title}`,
    text: `${who} ${verb} ${title}.\n\n${heading}:\n\n${detail}\n\nWhen: ${new Date().toLocaleString('en-GB', { timeZone: process.env.BILLING_TZ || 'Asia/Dhaka' })}` +
      `${appUrl ? `\n\nActivity log: ${appUrl}/#/admin/team` : ''}`,
    heading: `${actor.name || actor.email} ${verb} ${title}`,
    cta: appUrl ? { label: 'View activity log', url: `${appUrl}/#/admin/team` } : null,
    reason: 'You receive this because you are on the MithMill team activity list (Settings → Team activity).',
  });
}

module.exports = { snapshots, diff, record };

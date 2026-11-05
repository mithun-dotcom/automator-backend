const { query } = require('./db');
const { sendMail } = require('./mailer');
const { findPayLinks } = require('./payLinks');
const brands = require('./brands');

const TZ = process.env.BILLING_TZ || 'Asia/Dhaka';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const REMINDER_DAYS = [7, 3, 1];

const PAYMENT_NOTE =
  'Please note: payments are collected under the company name Mixxbee LLC. ' +
  'Please be advised that Mithmill and Mixxbee LLC are the same company.';

// ---- Date helpers. Billing dates are plain 'YYYY-MM-DD' strings in BILLING_TZ.

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function parse(d) {
  const [y, m, day] = d.split('-').map(Number);
  return { y, m, day };
}

function fmt(y, m, day) {
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The date `months` later on `billingDay`, clamped to that month's length, so
// a batch activated on the 31st renews on Feb 28 and then on Mar 31 again.
function nextBillingDate(d, billingDay, months = 1) {
  const { y, m } = parse(d);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return fmt(ny, nm, Math.min(billingDay, daysInMonth));
}

// Start dates of a batch's billing periods so far, oldest first: walking back
// one cycle at a time from the next renewal to the start date (give or take
// `slackDays`, for activation times stored in UTC).
function periodsSince(order, startDate, slackDays = 0) {
  const months = Math.max(1, Number(order.billing_months) || 1);
  const day = order.billing_day || Number(order.next_billing_date.slice(8));
  const min = slackDays ? new Date(Date.parse(`${startDate}T00:00:00Z`) - slackDays * 86400000).toISOString().slice(0, 10) : startDate;
  const out = [];
  let p = nextBillingDate(order.next_billing_date, day, -months);
  while (p >= min && out.length < 120) {
    out.unshift(p);
    p = nextBillingDate(p, day, -months);
  }
  return out;
}

const cycleMonths = (order) => Math.max(1, Number(order.billing_months) || 1);
const cycleLabel = (months) => (months === 1 ? 'monthly' : months === 12 ? 'yearly' : `every ${months} months`);
const periodLabel = (months) => (months === 1 ? '1 month' : months === 12 ? '12 months' : `${months} months`);
// Prices are per mailbox per month; an invoice covers the whole cycle.
const cycleAmount = (order) => order.quantity * order.price_per_mailbox * cycleMonths(order);

function daysBetween(from, to) {
  const a = parse(from);
  const b = parse(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.day) - Date.UTC(a.y, a.m - 1, a.day)) / 86400000);
}

function prettyDate(d) {
  const { y, m, day } = parse(d);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

const money = (n) => `$${Number(n).toFixed(2)}`;

// ---- Notifications

// Clients added by an admin and not yet joined see notifications in the
// portal once they accept their invite, but get no emails before then, except
// with { always: true } (renewal reminders), which they get without the portal link.
// emailExtra is added to the email only, not the portal notification.
// buttons: Pay buttons [{label, url}] for the email; subject, heading and
// alert ({ title, body } red box) override the email's look; paymentNote:
// false leaves out the payment notice (e.g. in a cancellation email).
// A reseller's client gets the reseller's branding when white-label is on
// (their name, logo, sender and payment details instead of MithMill's).
async function notify(user, title, body, { always = false, emailExtra = '', buttons = [], subject, heading, alert, paymentNote = true } = {}) {
  await query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)', [user.id, title, body]);
  const { rows: [u] } = await query('SELECT password_set, reseller_id FROM users WHERE id = $1', [user.id]);
  const joined = !u || u.password_set;
  if (!joined && !always) return;
  const portal = joined && APP_URL;
  const brand = u && u.reseller_id ? await brands.forClient(user.id) : null;
  const note = !paymentNote ? '' : brand ? brand.paymentNote : PAYMENT_NOTE;
  const name = brand ? brand.name : 'Mithmill';
  const reseller = u && u.reseller_id ? await brands.resellerOf(user.id) : null;
  await sendMail({
    to: user.email,
    subject: subject || title,
    text: `Hi ${user.name || 'there'},\n\n${body}${buttons.length ? `\n\n${buttons.map((b) => `${b.hint ? `${b.hint}\n` : ''}${b.label}: ${b.url}`).join('\n')}` : ''}${emailExtra ? `\n\n${emailExtra}` : ''}${portal ? `\n\nOpen your portal: ${brand && brand.portalUrl ? brand.portalUrl : APP_URL}` : ''}${note ? `\n\n${note}` : ''}\n\n${name}`,
    heading: heading || title,
    alert,
    cta: portal ? { label: 'Open your portal', url: brand && brand.portalUrl ? brand.portalUrl : APP_URL } : null,
    buttons,
    after: emailExtra || undefined,
    note: note || undefined,
    brand,
    reason: reseller ? `You receive this because you have an active service with ${brand ? brand.name : 'MithMill'}.` : undefined,
  });
}

// ---- Invoices

// The active parts of a batch (other mailbox types / services in the same batch).
async function batchParts(orderId) {
  const { rows } = await query(
    `SELECT o.*, p.label FROM orders o JOIN pricing p ON p.inbox_type = o.inbox_type
      WHERE o.parent_order_id = $1 AND o.status = 'active' ORDER BY o.id`, [orderId]);
  return rows;
}

// Issues the invoice for one billing period of a batch, with a line for it and
// for each of its parts. Does nothing if that period is already invoiced.
async function createOrderInvoice(order, periodStart, description, itemDescription) {
  const months = cycleMonths(order);
  const parts = await batchParts(order.id);
  const amount = Math.round([order, ...parts].reduce((t, o) => t + cycleAmount(o), 0) * 100) / 100;
  const { rows: [inv] } = await query(
    `INSERT INTO invoices (user_id, order_id, period_start, description, amount, due_date, issue_date, sold_by)
     VALUES ($1, $2, $3, $4, $5, $3, $6, $7)
     ON CONFLICT (order_id, period_start) WHERE order_id IS NOT NULL AND period_start IS NOT NULL
     DO NOTHING RETURNING id`,
    [order.user_id, order.id, periodStart, description, amount, today(), order.sold_by || ''],
  );
  if (inv) {
    let sort = 0;
    for (const o of [order, ...parts]) {
      await query(
        `INSERT INTO invoice_items (invoice_id, inbox_type, batch_name, description, quantity, unit_price, recurring, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [inv.id, o.inbox_type, order.batch_name || `Batch #${order.id}`,
         `${o.inbox_type === 'other' && o.batch_name && o.id !== order.id ? `${o.batch_name}: ` : ''}${months === 1 ? itemDescription : `${itemDescription} (${periodLabel(months)} × ${money(o.price_per_mailbox)}/month)`}`,
         o.quantity, o.price_per_mailbox * months, o.inbox_type === 'other', sort],
      );
      sort += 1;
    }
    await resellerCost(inv.id);
  }
  return inv;
}

// What a reseller pays MithMill for one of their clients' invoices: each line's
// mailboxes at the reseller's price for that type (or the standard price),
// for the batch's billing cycle. Stored on the invoice; null for non-resellers.
async function resellerCost(invoiceId) {
  const { rows: [inv] } = await query(
    `SELECT i.order_id, u.reseller_id, o.billing_months FROM invoices i JOIN users u ON u.id = i.user_id
       LEFT JOIN orders o ON o.id = i.order_id WHERE i.id = $1`, [invoiceId]);
  if (!inv || !inv.reseller_id) return null;
  const months = Math.max(1, Number(inv.billing_months) || 1);
  const { rows: items } = await query(
    `SELECT it.quantity, COALESCE(rp.price_per_mailbox, p.price_per_mailbox, 0) AS rate
       FROM invoice_items it
       LEFT JOIN pricing p ON p.inbox_type = it.inbox_type
       LEFT JOIN reseller_pricing rp ON rp.inbox_type = it.inbox_type AND rp.reseller_id = $2
      WHERE it.invoice_id = $1`, [invoiceId, inv.reseller_id]);
  const cost = Math.round(items.reduce((t, it) => t + it.quantity * it.rate * months, 0) * 100) / 100;
  await query('UPDATE invoices SET reseller_cost = $1 WHERE id = $2', [cost, invoiceId]);
  return cost;
}

// "3 × Google Workspace mailboxes", or the service's name for an "Other" batch.
const whatLabel = (order) => (order.inbox_type === 'other'
  ? `${order.quantity > 1 ? `${order.quantity} × ` : ''}${order.batch_name || 'Other service'}`
  : `${order.quantity} × ${order.label} mailboxes`);

// A part added to a batch whose next renewal invoice already exists (unpaid):
// add the part's line to it, unless it has one of that type and size already.
async function addPartToUpcomingInvoices(partId) {
  const { rows: [part] } = await query('SELECT * FROM orders WHERE id = $1', [partId]);
  if (!part || !part.parent_order_id || part.status !== 'active') return 0;
  const { rows: invs } = await query(
    `SELECT i.id, o.batch_name, o.billing_months, i.period_start FROM invoices i JOIN orders o ON o.id = i.order_id
      WHERE i.order_id = $1 AND i.status = 'unpaid' AND i.period_start IS NOT NULL AND i.period_start >= $2`, [part.parent_order_id, today()]);
  let added = 0;
  for (const inv of invs) {
    const months = Math.max(1, Number(inv.billing_months) || 1);
    const { rows: [has] } = await query('SELECT 1 FROM invoice_items WHERE invoice_id = $1 AND inbox_type = $2 AND quantity = $3', [inv.id, part.inbox_type, part.quantity]);
    if (has) continue;
    await query(
      `INSERT INTO invoice_items (invoice_id, inbox_type, batch_name, description, quantity, unit_price, recurring, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM invoice_items WHERE invoice_id = $1))`,
      [inv.id, part.inbox_type, inv.batch_name || `Batch #${part.parent_order_id}`, `Renewal from ${prettyDate(inv.period_start)}`,
       part.quantity, part.price_per_mailbox * months, part.inbox_type === 'other']);
    await query('UPDATE invoices SET amount = (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM invoice_items WHERE invoice_id = $1) - discount WHERE id = $1', [inv.id]);
    await resellerCost(inv.id);
    added += 1;
  }
  return added;
}

// "3 × Google Workspace + 3 × Microsoft 365 mailboxes" for a batch with parts.
async function batchLabel(order) {
  const parts = await batchParts(order.id);
  return parts.length ? [order, ...parts].map(whatLabel).join(' + ') : whatLabel(order);
}

async function ensureRenewalInvoice(order, periodStart) {
  return createOrderInvoice(order, periodStart,
    `Batch #${order.id} renewal: ${await batchLabel(order)} (from ${prettyDate(periodStart)})`,
    `Renewal from ${prettyDate(periodStart)}`);
}

// ---- The billing run: roll renewals forward, issue renewal invoices and send
// the 7/3/1-day reminders. Safe to run as often as you like.

async function runBilling() {
  const now = today();
  const { rows: orders } = await query(
    `SELECT o.*, p.label, u.email, u.name,
            (SELECT po.status FROM orders po WHERE po.id = o.parent_order_id) AS parent_status
       FROM orders o
       JOIN pricing p ON p.inbox_type = o.inbox_type
       JOIN users u ON u.id = o.user_id
      WHERE o.status = 'active' AND o.next_billing_date IS NOT NULL`,
  );

  let sent = 0;
  for (const order of orders) {
    let billingDate = order.next_billing_date;
    const billingDay = order.billing_day || parse(billingDate).day;
    // A part of another active batch renews on that batch's invoice and reminders.
    const isPart = Boolean(order.parent_order_id) && order.parent_status === 'active';

    // Renewal dates that have arrived: make sure each has an invoice, then move on.
    while (billingDate <= now) {
      if (!isPart) await ensureRenewalInvoice(order, billingDate);
      billingDate = nextBillingDate(billingDate, billingDay, cycleMonths(order));
    }
    if (billingDate !== order.next_billing_date) {
      await query('UPDATE orders SET next_billing_date = $1 WHERE id = $2', [billingDate, order.id]);
    }

    const daysLeft = daysBetween(now, billingDate);
    if (isPart || daysLeft > REMINDER_DAYS[0]) continue;

    await ensureRenewalInvoice(order, billingDate);

    // The tightest reminder window we're in. If the service was asleep and
    // missed an earlier one, only this one goes out, with the real day count.
    const threshold = Math.min(...REMINDER_DAYS.filter((d) => daysLeft <= d));
    const claim = await query(
      `INSERT INTO reminders_sent (order_id, billing_date, days_before)
       SELECT $1, $2, d FROM unnest($3::int[]) AS d WHERE d >= $4
       ON CONFLICT DO NOTHING RETURNING days_before`,
      [order.id, billingDate, REMINDER_DAYS, threshold],
    );
    if (!claim.rows.some((r) => r.days_before === threshold)) continue;

    const { rows: [invoice] } = await query(
      'SELECT status, amount, notes FROM invoices WHERE order_id = $1 AND period_start = $2',
      [order.id, billingDate],
    );
    const dayWord = daysLeft === 1 ? '1 day' : `${daysLeft} days`;
    let body =
      `Your batch #${order.id} (${(await batchParts(order.id)).length ? await batchLabel(order) : order.inbox_type === 'other' ? whatLabel(order) : `${order.label}, ${order.quantity} mailboxes`}) will renew in ${dayWord}, ` +
      `on ${prettyDate(billingDate)}. Amount: ${money(invoice ? invoice.amount : cycleAmount(order))}.`;
    const domainNote = domainsLine(await subscriptionDomains(order.user_id, [order.id, ...(await batchParts(order.id)).map((p) => p.id)]), 'Domains on this batch');
    const paid = invoice && invoice.status === 'paid';
    const user = { id: order.user_id, email: order.email, name: order.name };
    const brand = paid || !invoice ? null : await brands.forClient(order.user_id);
    const buttons = paid || !invoice ? [] : payButtons(invoice, brand ? brand.paymentNote : '');
    if (paid) {
      body += ' We have already received your payment for this period. Thank you!';
    } else if (threshold === 1) {
      // The last reminder, still unpaid: the critical alert.
      const amount = money(invoice ? invoice.amount : [order, ...(await batchParts(order.id))].reduce((t, o) => t + cycleAmount(o), 0));
      body += ' Please make the payment if not made. Today is the last day to renew: if payment is not made by today, ' +
        'your accounts will be cancelled tomorrow. To keep your mailboxes active, please complete the payment now.';
      if (domainNote) body += `\n\n${domainNote}`;
      await notify(user, `Critical: batch #${order.id} will be deactivated tomorrow`, body, {
        always: true,
        buttons,
        subject: `URGENT: your mailboxes will be deactivated tomorrow (batch #${order.id} renewal unpaid)`,
        heading: 'Critical alert: your mailboxes expire tomorrow',
        alert: { title: 'Your mailboxes will be deactivated tomorrow', body: `The renewal of batch #${order.id} (${amount}) is still unpaid. Today is the last day to pay.` },
        emailExtra: 'Already paid? Reply to this email with a screenshot of the payment, or share it in your dedicated WhatsApp or ' +
          'Slack group with us (recommended), so we can confirm it and keep your mailboxes active.',
      });
      sent += 1;
      continue;
    }
    if (domainNote) body += `\n\n${domainNote}`;
    await notify(user, `Your batch will renew in ${dayWord}`, body, {
      always: true,
      buttons,
      emailExtra: paid ? '' : 'To confirm your payment, please reply to this email with a screenshot of the payment, ' +
        'or share it in your dedicated WhatsApp or Slack group with us (recommended).',
    });
    sent += 1;
  }
  const overdueAlerts = await alertUnpaidRenewals(now);
  return { checked: orders.length, remindersSent: sent, overdueAlerts, today: now };
}

// Owner alerts for invoices that should be cancelled for non-payment. Each
// invoice is alerted once (invoices.overdue_alert_at); invoices more than 14
// days old are skipped, so there's no flood of old alerts.
// - Renewal invoice: the day after its renewal date, if still unpaid.
// - New invoice (a new batch's first invoice, or one with no billing period):
//   NEW_INVOICE_DAYS days after its issue date, if still unpaid.
const NEW_INVOICE_DAYS = 3;

// A renewal invoice is issued ahead of its period, or follows an earlier invoice for the batch.
const IS_RENEWAL = `(i.period_start IS NOT NULL AND (i.period_start > COALESCE(i.issue_date, i.created_at::date)
  OR EXISTS (SELECT 1 FROM invoices e WHERE e.order_id = i.order_id AND e.period_start < i.period_start)))`;

async function alertUnpaidRenewals(now) {
  const { rows: [setting] } = await query("SELECT value FROM settings WHERE key = 'overdue_alert_emails'");
  const to = String(setting ? setting.value : (process.env.OVERDUE_ALERT_EMAILS || 'mithun@mithmill.com'))
    .split(/[\s,;]+/).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (!to.length) return 0;
  const { rows } = await query(
    `SELECT * FROM (
       SELECT i.id AS invoice_id, i.amount, i.sent_at, i.order_id, o.batch_name, o.quantity, o.inbox_type, p.label,
              u.id AS user_id, u.email, u.name, u.company, u.sold_by,
              (SELECT COALESCE(NULLIF(r.brand_name, ''), ru.email) FROM resellers r JOIN users ru ON ru.id = r.user_id WHERE r.user_id = u.reseller_id) AS reseller,
              ${IS_RENEWAL} AS renewal,
              CASE WHEN ${IS_RENEWAL} THEN i.period_start ELSE COALESCE(i.issue_date, i.created_at::date) END AS since
         FROM invoices i JOIN users u ON u.id = i.user_id
         LEFT JOIN orders o ON o.id = i.order_id LEFT JOIN pricing p ON p.inbox_type = o.inbox_type
        WHERE i.status = 'unpaid' AND i.overdue_alert_at IS NULL AND (o.id IS NULL OR o.status <> 'cancelled')
     ) x
     WHERE since >= ($1::date - 14)
       AND ((renewal AND since < $1) OR (NOT renewal AND since <= ($1::date - ${NEW_INVOICE_DAYS})))
       -- Renewals alerted before overdue_alert_at existed.
       AND NOT (renewal AND EXISTS (SELECT 1 FROM reminders_sent s WHERE s.order_id = x.order_id AND s.billing_date = x.since AND s.days_before = -1))
     ORDER BY since`, [now]);
  let sent = 0;
  for (const r of rows) {
    const claim = await query('UPDATE invoices SET overdue_alert_at = now() WHERE id = $1 AND overdue_alert_at IS NULL RETURNING 1', [r.invoice_id]);
    if (!claim.rows.length) continue;
    const who = r.company || r.name || r.email;
    const what = !r.order_id ? 'invoice' : r.inbox_type === 'other' ? (r.batch_name || 'Other service') : `${r.quantity} × ${r.label} mailboxes`;
    const batch = !r.order_id ? `Invoice #${r.invoice_id}` : r.batch_name ? `${r.batch_name} (batch #${r.order_id})` : `Batch #${r.order_id}`;
    const late = daysBetween(r.since, now);
    const domainNote = domainsLine(await subscriptionDomains(r.user_id, [r.order_id]));
    const ago = late === 1 ? '1 day' : `${late} days`;
    const link = APP_URL ? `${APP_URL}/#/admin/invoice/${r.invoice_id}` : '';
    const when = r.renewal
      ? `• Due / renewal date: ${prettyDate(r.since)} (${ago} ago)\n`
      : `• New invoice issued: ${prettyDate(r.since)} (unpaid for ${ago}; the limit is ${NEW_INVOICE_DAYS} days)\n` +
        `• Sent to the client: ${r.sent_at ? prettyDate(r.sent_at) : 'not yet (use Send invoice)'}\n`;
    const history = r.renewal
      ? 'The client was sent the 7, 3 and 1-day renewal reminders. The due date is over'
      : `This new invoice is past its ${NEW_INVOICE_DAYS}-day payment limit`;
    await sendMail({
      to: to.join(', '),
      subject: r.renewal
        ? `Payment not received: ${who}, due ${prettyDate(r.since)}`
        : `New invoice unpaid for ${ago}: ${who}, invoice #${r.invoice_id}`,
      text: `${who} (${r.email}) hasn't paid for ${batch}${r.order_id ? `: ${what}` : ''}.\n\n` +
        when +
        `• Unpaid invoice: #${r.invoice_id}, ${money(r.amount)}\n` +
        `${domainNote ? `• ${domainNote}\n` : ''}` +
        `${r.reseller ? `• Reseller's client: ${r.reseller}\n` : ''}${r.sold_by ? `• Sold by: ${r.sold_by}\n` : ''}` +
        `\n${history}, so you may want to cancel this subscription: ` +
        `open the invoice and click Cancel subscription (choose "No payment made" to email the client).${link ? `\n\nOpen the invoice: ${link}` : ''}\n\nMithmill`,
      heading: 'Payment not received: cancel the subscription?',
      alert: {
        title: `${who} hasn't paid`,
        body: r.renewal
          ? `${batch} was due on ${prettyDate(r.since)}. Invoice #${r.invoice_id} (${money(r.amount)}) is still unpaid.`
          : `New invoice #${r.invoice_id} (${money(r.amount)}) was issued on ${prettyDate(r.since)} and is still unpaid after ${ago}.`,
      },
      cta: link ? { label: 'Open invoice to cancel', url: link } : null,
      reason: 'You receive this because you are on the unpaid-invoice alert list (Settings).',
    });
    sent += 1;
  }
  return sent;
}

// The domains (and mailbox count) on a client's batches, for the notes in
// renewal, due and cancellation emails: the domains linked to those batches,
// else the ones written on them, else (when they're the client's only
// batches) all of the client's domains.
async function subscriptionDomains(userId, orderIds = []) {
  const ids = orderIds.filter(Boolean).map(Number);
  let { rows } = await query('SELECT domain FROM domains WHERE user_id = $1 AND order_id = ANY($2) ORDER BY domain', [userId, ids]);
  let list = rows.map((r) => r.domain);
  if (!list.length && ids.length) {
    ({ rows } = await query('SELECT domains FROM orders WHERE id = ANY($1)', [ids]));
    list = [...new Set(rows.flatMap((r) => String(r.domains || '').split(/[\s,;]+/))
      .map((d) => d.trim().toLowerCase().replace(/^www\./, '')).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].sort();
  }
  if (!list.length) {
    const { rows: [{ n }] } = await query("SELECT count(*)::int AS n FROM orders WHERE user_id = $1 AND status <> 'cancelled' AND NOT (id = ANY($2))", [userId, ids]);
    if (!n) list = (await query('SELECT domain FROM domains WHERE user_id = $1 ORDER BY domain', [userId])).rows.map((r) => r.domain);
  }
  if (!list.length) return { domains: [], mailboxes: 0 };
  const { rows: [{ m }] } = await query(
    "SELECT count(*)::int AS m FROM mailboxes WHERE user_id = $1 AND lower(split_part(email, '@', 2)) = ANY($2)", [userId, list]);
  return { domains: list, mailboxes: m };
}
// "Domains: a.com, b.com (12 mailboxes)", or '' when there are none.
function domainsLine(info, label = 'Domains') {
  if (!info || !info.domains.length) return '';
  const shown = info.domains.slice(0, 15).join(', ');
  const more = info.domains.length > 15 ? ` and ${info.domains.length - 15} more` : '';
  return `${label}: ${shown}${more}${info.mailboxes ? ` (${info.mailboxes} mailbox${info.mailboxes === 1 ? '' : 'es'})` : ''}`;
}

const UPDATE_HINT = 'Your subscription renews automatically on your card. If your card has expired or the payment ' +
  'didn\'t go through (for example, not enough funds), update your payment method so the renewal can be charged.';

// Buttons for the payment links in an invoice's notes: "Pay now" for a payment
// link, "Update payment method" for a Stripe subscription link. A white-label
// reseller's own payment details are used when the invoice has no link.
const payButtons = (inv, fallbackNote = '') => {
  let links = findPayLinks(inv.notes);
  if (!links.length && fallbackNote) links = findPayLinks(fallbackNote);
  const pays = links.filter((l) => l.kind === 'pay').length;
  return links.map((l) => (l.kind === 'update'
    ? { url: l.url, kind: 'update', label: 'Update payment method', hint: UPDATE_HINT }
    : { url: l.url, kind: 'pay', label: pays > 1 && l.method ? `Pay now with ${l.method}` : `Pay ${money(inv.amount)} now` }));
};

module.exports = {
  payButtons, whatLabel, periodsSince, resellerCost, subscriptionDomains, domainsLine, batchParts, batchLabel, addPartToUpcomingInvoices,
  PAYMENT_NOTE, today, nextBillingDate, daysBetween, prettyDate, money, notify, runBilling, createOrderInvoice,
  cycleMonths, cycleLabel, cycleAmount,
};

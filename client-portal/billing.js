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
    text: `Hi ${user.name || 'there'},\n\n${body}${buttons.length ? `\n\n${buttons.map((b) => `${b.hint ? `${b.hint}\n` : ''}${b.label}: ${b.url}`).join('\n')}` : ''}${emailExtra ? `\n\n${emailExtra}` : ''}${portal ? `\n\nOpen your portal: ${APP_URL}` : ''}${note ? `\n\n${note}` : ''}\n\n${name}`,
    heading: heading || title,
    alert,
    cta: portal ? { label: 'Open your portal', url: APP_URL } : null,
    buttons,
    after: emailExtra || undefined,
    note: note || undefined,
    brand,
    reason: reseller ? `You receive this because you have an active service with ${brand ? brand.name : 'MithMill'}.` : undefined,
  });
}

// ---- Invoices

// Issues the invoice for one billing period of a batch, with a matching line
// item. Does nothing if that period is already invoiced.
async function createOrderInvoice(order, periodStart, description, itemDescription) {
  const months = cycleMonths(order);
  const amount = cycleAmount(order);
  const { rows: [inv] } = await query(
    `INSERT INTO invoices (user_id, order_id, period_start, description, amount, due_date, issue_date, sold_by)
     VALUES ($1, $2, $3, $4, $5, $3, $6, $7)
     ON CONFLICT (order_id, period_start) WHERE order_id IS NOT NULL AND period_start IS NOT NULL
     DO NOTHING RETURNING id`,
    [order.user_id, order.id, periodStart, description, amount, today(), order.sold_by || ''],
  );
  if (inv) {
    await query(
      `INSERT INTO invoice_items (invoice_id, inbox_type, batch_name, description, quantity, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [inv.id, order.inbox_type, order.batch_name || `Batch #${order.id}`,
       months === 1 ? itemDescription : `${itemDescription} (${periodLabel(months)} × ${money(order.price_per_mailbox)}/month)`,
       order.quantity, order.price_per_mailbox * months],
    );
  }
  return inv;
}

// "3 × Google Workspace mailboxes", or the service's name for an "Other" batch.
const whatLabel = (order) => (order.inbox_type === 'other'
  ? `${order.quantity > 1 ? `${order.quantity} × ` : ''}${order.batch_name || 'Other service'}`
  : `${order.quantity} × ${order.label} mailboxes`);

function ensureRenewalInvoice(order, periodStart) {
  return createOrderInvoice(order, periodStart,
    `Batch #${order.id} renewal: ${whatLabel(order)} (from ${prettyDate(periodStart)})`,
    `Renewal from ${prettyDate(periodStart)}`);
}

// ---- The billing run: roll renewals forward, issue renewal invoices and send
// the 7/3/1-day reminders. Safe to run as often as you like.

async function runBilling() {
  const now = today();
  const { rows: orders } = await query(
    `SELECT o.*, p.label, u.email, u.name
       FROM orders o
       JOIN pricing p ON p.inbox_type = o.inbox_type
       JOIN users u ON u.id = o.user_id
      WHERE o.status = 'active' AND o.next_billing_date IS NOT NULL`,
  );

  let sent = 0;
  for (const order of orders) {
    let billingDate = order.next_billing_date;
    const billingDay = order.billing_day || parse(billingDate).day;

    // Renewal dates that have arrived: make sure each has an invoice, then move on.
    while (billingDate <= now) {
      await ensureRenewalInvoice(order, billingDate);
      billingDate = nextBillingDate(billingDate, billingDay, cycleMonths(order));
    }
    if (billingDate !== order.next_billing_date) {
      await query('UPDATE orders SET next_billing_date = $1 WHERE id = $2', [billingDate, order.id]);
    }

    const daysLeft = daysBetween(now, billingDate);
    if (daysLeft > REMINDER_DAYS[0]) continue;

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
      `Your batch #${order.id} (${order.inbox_type === 'other' ? whatLabel(order) : `${order.label}, ${order.quantity} mailboxes`}) will renew in ${dayWord}, ` +
      `on ${prettyDate(billingDate)}. Amount: ${money(invoice ? invoice.amount : cycleAmount(order))}.`;
    const paid = invoice && invoice.status === 'paid';
    const user = { id: order.user_id, email: order.email, name: order.name };
    const brand = paid || !invoice ? null : await brands.forClient(order.user_id);
    const buttons = paid || !invoice ? [] : payButtons(invoice, brand ? brand.paymentNote : '');
    if (paid) {
      body += ' We have already received your payment for this period. Thank you!';
    } else if (threshold === 1) {
      // The last reminder, still unpaid: the critical alert.
      const amount = money(invoice ? invoice.amount : cycleAmount(order));
      body += ' Please make the payment if not made. Today is the last day to renew: if payment is not made by today, ' +
        'your accounts will be cancelled tomorrow. To keep your mailboxes active, please complete the payment now.';
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
    await notify(user, `Your batch will renew in ${dayWord}`, body, {
      always: true,
      buttons,
      emailExtra: paid ? '' : 'To confirm your payment, please reply to this email with a screenshot of the payment, ' +
        'or share it in your dedicated WhatsApp or Slack group with us (recommended).',
    });
    sent += 1;
  }
  return { checked: orders.length, remindersSent: sent, today: now };
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
  payButtons, whatLabel,
  PAYMENT_NOTE, today, nextBillingDate, daysBetween, prettyDate, money, notify, runBilling, createOrderInvoice,
  cycleMonths, cycleLabel, cycleAmount,
};

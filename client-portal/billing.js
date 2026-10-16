const { query } = require('./db');
const { sendMail } = require('./mailer');

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

// Next month's date on `billingDay`, clamped to that month's length, so a
// batch activated on the 31st renews on Feb 28 and then on Mar 31 again.
function nextBillingDate(d, billingDay) {
  const { y, m } = parse(d);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const daysInMonth = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return fmt(ny, nm, Math.min(billingDay, daysInMonth));
}

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

async function notify(user, title, body) {
  await query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)', [user.id, title, body]);
  const link = APP_URL ? `\n\nOpen your portal: ${APP_URL}` : '';
  await sendMail({
    to: user.email,
    subject: title,
    text: `Hi ${user.name || 'there'},\n\n${body}${link}\n\n${PAYMENT_NOTE}\n\nMithmill`,
  });
}

// ---- Invoices

async function ensureRenewalInvoice(order, periodStart) {
  const amount = order.quantity * order.price_per_mailbox;
  await query(
    `INSERT INTO invoices (user_id, order_id, period_start, description, amount, due_date)
     VALUES ($1, $2, $3, $4, $5, $3)
     ON CONFLICT (order_id, period_start) WHERE order_id IS NOT NULL AND period_start IS NOT NULL
     DO NOTHING`,
    [order.user_id, order.id, periodStart,
     `Batch #${order.id} renewal: ${order.quantity} × ${order.label} mailboxes (from ${prettyDate(periodStart)})`,
     amount],
  );
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
      billingDate = nextBillingDate(billingDate, billingDay);
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
      'SELECT status, amount FROM invoices WHERE order_id = $1 AND period_start = $2',
      [order.id, billingDate],
    );
    const dayWord = daysLeft === 1 ? '1 day' : `${daysLeft} days`;
    let body =
      `Your batch #${order.id} (${order.label}, ${order.quantity} mailboxes) will renew in ${dayWord}, ` +
      `on ${prettyDate(billingDate)}. Amount: ${money(invoice ? invoice.amount : order.quantity * order.price_per_mailbox)}.`;
    if (invoice && invoice.status === 'paid') {
      body += ' We have already received your payment for this period. Thank you!';
    } else if (threshold === 1) {
      body += ' Please make the payment if not made.';
    }
    await notify({ id: order.user_id, email: order.email, name: order.name }, `Your batch will renew in ${dayWord}`, body);
    sent += 1;
  }
  return { checked: orders.length, remindersSent: sent, today: now };
}

module.exports = {
  PAYMENT_NOTE, today, nextBillingDate, daysBetween, prettyDate, money, notify, runBilling,
};

// How each mailbox type is sold: per mailbox, or per domain of up to N
// inboxes (pricing.per_domain). Cached from the pricing table; reloaded at
// boot and whenever prices are saved. Used to word emails and invoices.
const { query } = require('./db');

let perDomain = {};
async function load() {
  const { rows } = await query('SELECT inbox_type, per_domain FROM pricing');
  perDomain = Object.fromEntries(rows.map((r) => [r.inbox_type, Number(r.per_domain) || 0]));
}
const cap = (type) => perDomain[type] || 0;
const plural = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;
// "3 Azure domains (up to 99 inboxes each)" / "3 Google Workspace mailboxes"
const count = (type, n, label) => (cap(type)
  ? `${plural(n, `${label} domain`, `${label} domains`)} (up to ${cap(type)} inboxes each)`
  : `${n} ${label} mailboxes`);
// "3 × Azure domains (up to 99 inboxes each)" / "3 × Google Workspace mailboxes"
const times = (type, n, label) => (cap(type) ? `${n} × ${label} domains (up to ${cap(type)} inboxes each)` : `${n} × ${label} mailboxes`);

module.exports = { load, cap, count, times };

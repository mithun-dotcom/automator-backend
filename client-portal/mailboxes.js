// Mailbox logins delivered to clients: uploaded by the team as a CSV (email,
// password, admin, type, created), stored with the password encrypted, and
// shown in the client's portal with the password hidden until they click Show.
// The upload also fills in the client's domains (see server.js).
const { parseCsv, toCsv } = require('./onboarding');

const MAX_ROWS = 10000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The sample the team downloads (and the guide previews): two domains on
// different mailbox types, one admin mailbox each.
const SAMPLE = [['email', 'password', 'admin', 'type', 'created'],
  ['admin@acmegrowth.com', 'Ag#7kQ2m!vX', 'yes', 'Google Workspace', '2026-11-01'],
  ['john@acmegrowth.com', 'Jd$4pL9w@zR', '', 'Google Workspace', '2026-11-01'],
  ['sarah@acmegrowth.com', 'Sm!8tN3q#bK', '', 'Google Workspace', '2026-11-01'],
  ['admin@tryacmegrowth.com', 'Ta@5hV1r$eW', 'yes', 'Microsoft 365 (Admin)', '2026-11-02'],
  ['mike@tryacmegrowth.com', 'Mk#2xC6j!uP', '', 'Microsoft 365 (Admin)', '2026-11-02'],
  ['emma@tryacmegrowth.com', 'Em$9yF4s@gT', '', 'Microsoft 365 (Admin)', '2026-11-02']];
const TEMPLATE = toCsv(SAMPLE);
const DOMAIN_SAMPLE = [['domain', 'type'],
  ['acmegrowth.com', 'Google Workspace'], ['getacmegrowth.com', 'Google Workspace'],
  ['tryacmegrowth.com', 'Microsoft 365 (Admin)'], ['acmegrowthhq.com', '']];
const DOMAIN_TEMPLATE = toCsv(DOMAIN_SAMPLE);

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const EMAIL_COLS = ['email', 'emailaddress', 'mailbox', 'username', 'user', 'login', 'address', 'upn', 'userprincipalname'];
const PASS_COLS = ['password', 'pass', 'pwd', 'passwd'];
const ADMIN_COLS = ['admin', 'isadmin', 'role', 'adminemail'];
const TYPE_COLS = ['type', 'mailboxtype', 'inboxtype', 'product', 'plan', 'service', 'accounttype'];
const DATE_COLS = ['created', 'createdat', 'createdon', 'creationdate', 'datecreated', 'created_date', 'date', 'warmupstarted', 'warmupstart', 'warmupdate', 'started', 'startdate'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "2026-11-01", "01/11/2026" (day first unless that can't be), "1 Nov 2026",
// "Nov 1, 2026" -> "2026-11-01"; "" -> null; anything else -> undefined.
function parseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const ok = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y > 2000 && y < 2100
      ? dt.toISOString().slice(0, 10) : undefined;
  };
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const [a, b] = [+m[1], +m[2]];
    return b > 12 ? ok(y, a, b) : ok(y, b, a);
  }
  m = s.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i) || s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m) {
    const [day, mon] = /^\d/.test(m[1]) ? [+m[1], m[2]] : [+m[2], m[1]];
    const i = MONTHS.indexOf(mon.toLowerCase().slice(0, 3));
    return i === -1 ? undefined : ok(+m[3], i + 1, day);
  }
  return undefined;
}
const isAdminValue = (v) => /^(y|yes|true|1|x|✓|admin|administrator|superadmin|globaladmin)$/i.test(String(v).trim())
  || /admin/i.test(String(v));

// -> [{ email, password, is_admin, type, created }] or throws a message for
// the uploader. type is the raw text (matched to a mailbox type by the
// caller); created is YYYY-MM-DD or null. A header row is optional: without
// one, the columns are email, password, admin, type, created.
function parse(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The CSV file is empty');
  const all = parseCsv(text).filter((r) => r.some((v) => v.trim() !== ''));
  if (!all.length) throw new Error('The CSV file is empty');
  const head = all[0].map(norm);
  const find = (names) => head.findIndex((h) => names.includes(h));
  let cols = { email: find(EMAIL_COLS), password: find(PASS_COLS), admin: find(ADMIN_COLS), type: find(TYPE_COLS), created: find(DATE_COLS) };
  let body = all.slice(1);
  if (cols.email === -1 && EMAIL_RE.test(String(all[0][0]).trim())) {
    cols = { email: 0, password: 1, admin: 2, type: 3, created: 4 };
    body = all;
  }
  if (cols.email === -1) throw new Error('The CSV needs an "email" column (and "password"). Download the sample file.');
  if (cols.password === -1) throw new Error('The CSV needs a "password" column. Download the sample file.');
  if (!body.length) throw new Error('The CSV has no mailboxes under the header');
  if (body.length > MAX_ROWS) throw new Error(`The CSV has more than ${MAX_ROWS} rows`);
  const seen = new Set();
  return body.map((r, i) => {
    const email = String(r[cols.email] || '').trim().toLowerCase();
    const password = String(r[cols.password] || '').trim();
    if (!EMAIL_RE.test(email)) throw new Error(`Row ${i + 2}: "${email || '(empty)'}" isn't a valid email`);
    if (!password) throw new Error(`Row ${i + 2}: the password for ${email} is empty`);
    if (seen.has(email)) throw new Error(`Row ${i + 2}: ${email} is in the file twice`);
    seen.add(email);
    const created = cols.created === -1 ? null : parseDate(r[cols.created]);
    if (created === undefined) throw new Error(`Row ${i + 2}: "${r[cols.created]}" isn't a date. Use YYYY-MM-DD, e.g. 2026-11-01`);
    return {
      email,
      password: password.slice(0, 500),
      is_admin: cols.admin !== -1 && isAdminValue(r[cols.admin] || ''),
      type: cols.type === -1 ? '' : String(r[cols.type] || '').trim(),
      created,
    };
  });
}

module.exports = { parse, parseDate, SAMPLE, TEMPLATE, DOMAIN_SAMPLE, DOMAIN_TEMPLATE, toCsv };

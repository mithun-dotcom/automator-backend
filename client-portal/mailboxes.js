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

// Reads the dates people put in sheets -> "YYYY-MM-DD"; "" -> null; unreadable -> undefined.
//   2026-11-01, 2026/11/1, 01/11/2026 and 1-11-26 (day first unless that can't be),
//   8-sep-25, 8 Sep 25, 9 oct 26, 08-Sept-2025, 8/Sep/2025, 8th September 2025,
//   Sep 8 25, September 8, 2025, Sep-8-2025, Excel serial numbers (45908), with a time after.
const yearOf = (y) => (y.length <= 2 ? 2000 + Number(y) : Number(y));
function parseDate(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  const ok = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y > 2000 && y < 2100
      ? dt.toISOString().slice(0, 10) : undefined;
  };
  // Excel stores dates as days since 1899-12-30.
  if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 36000 && Number(s) < 73000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000).toISOString().slice(0, 10);
  }
  s = s.replace(/[t\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(z|am|pm|[+-]\d{2}:?\d{2})?$/, '').trim(); // drop a time
  s = s.replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*[,.]?\s+/, '');
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) {
    const y = yearOf(m[3]);
    const [a, b] = [+m[1], +m[2]];
    return b > 12 ? ok(y, a, b) : ok(y, b, a);
  }
  const SEP = '[\\s\\-/.,]+';
  // 8-sep-25, 8 september 2025
  m = s.match(new RegExp(`^(\\d{1,2})${SEP}([a-z]{3,9})\\.?${SEP}(\\d{2}|\\d{4})$`));
  if (m) { const i = monthIndex(m[2]); return i === -1 ? undefined : ok(yearOf(m[3]), i + 1, +m[1]); }
  // sep 8 25, september 8, 2025
  m = s.match(new RegExp(`^([a-z]{3,9})\\.?${SEP}(\\d{1,2})${SEP}(\\d{2}|\\d{4})$`));
  if (m) { const i = monthIndex(m[1]); return i === -1 ? undefined : ok(yearOf(m[3]), i + 1, +m[2]); }
  // 2025-sep-08
  m = s.match(new RegExp(`^(\\d{4})${SEP}([a-z]{3,9})\\.?${SEP}(\\d{1,2})$`));
  if (m) { const i = monthIndex(m[2]); return i === -1 ? undefined : ok(+m[1], i + 1, +m[3]); }
  return undefined;
}
function monthIndex(word) {
  const w = word.toLowerCase();
  const i = MONTHS.indexOf(w.slice(0, 3));
  if (i === -1) return -1;
  // "sept", "june", "september" are fine; reject words that only start like a month ("marketing").
  const FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  return FULL[i].startsWith(w) || w === 'sept' ? i : -1;
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

// Mailbox logins delivered to clients: uploaded by the team as a CSV (email,
// password, admin), stored with the password encrypted, and shown in the
// client's portal with the password hidden until they click Show.
const { parseCsv, toCsv } = require('./onboarding');

const MAX_ROWS = 10000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEMPLATE = toCsv([['email', 'password', 'admin'],
  ['admin@yourdomain.com', 'Example#Pass1', 'yes'],
  ['john@yourdomain.com', 'Example#Pass2', ''],
  ['sarah@yourdomain.com', 'Example#Pass3', '']]);

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const EMAIL_COLS = ['email', 'emailaddress', 'mailbox', 'username', 'user', 'login', 'address', 'upn', 'userprincipalname'];
const PASS_COLS = ['password', 'pass', 'pwd', 'passwd'];
const ADMIN_COLS = ['admin', 'isadmin', 'role', 'type', 'accounttype', 'adminemail'];
const isAdminValue = (v) => /^(y|yes|true|1|x|✓|admin|administrator|superadmin|globaladmin)$/i.test(String(v).trim())
  || /admin/i.test(String(v));

// -> [{ email, password, is_admin }] or throws a message for the uploader.
// A header row is optional: without one, the columns are email, password, admin.
function parse(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The CSV file is empty');
  const all = parseCsv(text).filter((r) => r.some((v) => v.trim() !== ''));
  if (!all.length) throw new Error('The CSV file is empty');
  const head = all[0].map(norm);
  const find = (names) => head.findIndex((h) => names.includes(h));
  let cols = { email: find(EMAIL_COLS), password: find(PASS_COLS), admin: find(ADMIN_COLS) };
  let body = all.slice(1);
  if (cols.email === -1 && EMAIL_RE.test(String(all[0][0]).trim())) {
    cols = { email: 0, password: 1, admin: 2 };
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
    return { email, password: password.slice(0, 500), is_admin: cols.admin !== -1 && isAdminValue(r[cols.admin] || '') };
  });
}

module.exports = { parse, TEMPLATE, toCsv };

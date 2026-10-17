// Onboarding CSV: the template clients fill in, parsing/validation, and
// encryption at rest (the sheet contains passwords).
const crypto = require('crypto');

const COLUMNS = [
  'Domain name',
  'Number of users per domain',
  'Full name',
  'Username',
  'Preferred password',
  'Domain access email/username',
  'Domain provider password',
  'Domain provider login URL',
  'Sequencer access email',
  'Sequencer access password',
  'Sequencer workspace name',
  'Profile picture drive link',
  'Domain forward',
];
const REQUIRED = ['Domain name', 'Full name', 'Username'];
const MAX_ROWS = 10000;

const SAMPLE_ROWS = [
  ['acme-mail.com', '2', 'John Smith', 'john', 'Str0ngPass!1', 'it@acme.com', 'registrar-password', 'https://dcc.godaddy.com', 'ops@acme.com', 'sequencer-password', 'Acme Outbound', 'https://drive.google.com/file/d/xxxx', 'https://acme.com'],
  ['acme-mail.com', '2', 'Jane Doe', 'jane.doe', 'Str0ngPass!2', 'it@acme.com', 'registrar-password', 'https://dcc.godaddy.com', 'ops@acme.com', 'sequencer-password', 'Acme Outbound', 'https://drive.google.com/file/d/yyyy', 'https://acme.com'],
];

const cell = (v) => (/[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (rows) => `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
const TEMPLATE = toCsv([COLUMNS, ...SAMPLE_ROWS]);

// RFC 4180 parser: quoted fields, escaped quotes, CRLF/LF, optional BOM.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

// Returns { rows: [{column: value}], domains: [...], users: n } or throws a
// message suitable for showing to the client.
function validate(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The CSV file is empty');
  const all = parseCsv(text).filter((r) => r.some((v) => v.trim() !== ''));
  if (all.length < 2) throw new Error('The CSV has no rows under the header. Add one row per mailbox user.');
  const header = all[0].map(norm);
  const index = {};
  for (const col of COLUMNS) {
    const i = header.indexOf(norm(col));
    if (i !== -1) index[col] = i;
  }
  const missing = REQUIRED.filter((c) => index[c] === undefined);
  if (missing.length) throw new Error(`The CSV is missing these columns: ${missing.join(', ')}. Please use the sample file.`);
  const body = all.slice(1);
  if (body.length > MAX_ROWS) throw new Error(`The CSV has more than ${MAX_ROWS} rows`);

  const rows = body.map((r) => Object.fromEntries(COLUMNS.map((c) => [c, index[c] === undefined ? '' : (r[index[c]] || '').trim()])));
  rows.forEach((r, i) => {
    const missingCells = REQUIRED.filter((c) => !r[c]);
    if (missingCells.length) throw new Error(`Row ${i + 2}: ${missingCells.join(', ')} ${missingCells.length > 1 ? 'are' : 'is'} empty`);
  });
  const domains = [...new Set(rows.map((r) => r['Domain name'].toLowerCase()))];
  return { rows, domains, users: rows.length };
}

// AES-256-GCM. DATA_ENCRYPTION_KEY (64 hex chars) if set, otherwise derived
// from SESSION_SECRET.
function key() {
  const hex = process.env.DATA_ENCRYPTION_KEY;
  if (hex && /^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  return crypto.createHash('sha256').update(`${process.env.SESSION_SECRET}:onboarding-data`).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function decrypt(buf) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

module.exports = { COLUMNS, TEMPLATE, toCsv, validate, encrypt, decrypt };

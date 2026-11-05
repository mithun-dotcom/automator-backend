const crypto = require('crypto');
const { SECRET_KEY } = require('./config');

const key = crypto.createHash('sha256').update(SECRET_KEY).digest();

function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}

function decrypt(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, data] = blob.split('.').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const hash = s => crypto.createHash('sha256').update(String(s).toLowerCase()).digest('hex').slice(0, 16);

module.exports = { encrypt, decrypt, hash };

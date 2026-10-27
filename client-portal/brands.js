// Email/invoice branding for resellers' clients. A client of a reseller with
// white-label on gets the reseller's name, logo, sender and payment details;
// everyone else gets MithMill's (brand = null).
const { query } = require('./db');
const onboarding = require('./onboarding');

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

function toBrand(r) {
  if (!r) return null;
  let smtp = null;
  if (r.smtp_host && r.smtp_user && r.smtp_pass) {
    try {
      smtp = { host: r.smtp_host, port: r.smtp_port || 465, user: r.smtp_user, pass: onboarding.decrypt(r.smtp_pass) };
    } catch (err) {
      console.error(`Reseller ${r.user_id}: SMTP password can't be read (${err.message})`);
    }
  }
  const name = r.brand_name || r.company || 'Your provider';
  return {
    resellerId: r.user_id,
    name,
    logoPath: r.logo_type ? `/brand/${r.user_id}/logo?v=${r.logo_version}` : null,
    logoUrl: r.logo_type && APP_URL ? `${APP_URL}/brand/${r.user_id}/logo?v=${r.logo_version}` : null,
    website: r.website || '',
    supportEmail: r.support_email || r.reply_to || '',
    paymentNote: r.payment_note || '',
    senderName: r.sender_name || name,
    senderEmail: r.sender_email || '',
    replyTo: r.reply_to || r.support_email || '',
    smtp,
  };
}

const SELECT = `SELECT r.*, u.company FROM resellers r JOIN users u ON u.id = r.user_id`;

// The branding a client's emails use: their reseller's when white-label is on.
async function forClient(userId) {
  const { rows: [r] } = await query(
    `${SELECT} WHERE r.white_label AND r.user_id = (SELECT reseller_id FROM users WHERE id = $1)`, [userId]);
  return toBrand(r);
}

// A reseller's branding regardless of the switch (for previews and tests).
async function forReseller(resellerId) {
  const { rows: [r] } = await query(`${SELECT} WHERE r.user_id = $1`, [resellerId]);
  return toBrand(r);
}

// The reseller a client belongs to (name only), white-label or not.
async function resellerOf(userId) {
  const { rows: [r] } = await query(
    `SELECT r.user_id, COALESCE(NULLIF(r.brand_name, ''), u.company, u.email) AS name
       FROM users c JOIN resellers r ON r.user_id = c.reseller_id JOIN users u ON u.id = r.user_id WHERE c.id = $1`, [userId]);
  return r || null;
}

module.exports = { forClient, forReseller, resellerOf };

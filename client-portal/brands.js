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
  // Their own domain if set, else the main portal with ?b=<id> (both show their brand).
  const portalUrl = r.custom_domain ? `https://${r.custom_domain}` : APP_URL ? `${APP_URL}/?b=${r.user_id}` : '';
  return {
    resellerId: r.user_id,
    customDomain: r.custom_domain || '',
    portalUrl,
    loginUrl: portalUrl ? `${portalUrl}#/login` : '',
    name,
    logoPath: r.logo_type ? `/brand/${r.user_id}/logo?v=${r.logo_version}` : null,
    logoUrl: r.logo_type && APP_URL ? `${APP_URL}/brand/${r.user_id}/logo?v=${r.logo_version}` : null,
    website: r.website || '',
    supportEmail: r.support_email || r.reply_to || '',
    // Paying through Mixxbee LLC (Mithmill's processor): our notice instead of their payment details.
    mixxbee: Boolean(r.use_mixxbee),
    paymentNote: r.use_mixxbee
      ? `Payments are processed by Mixxbee LLC on behalf of ${name}. "Mixxbee LLC" may appear on your card or bank statement.`
      : r.payment_note || '',
    senderName: r.sender_name || name,
    senderEmail: r.sender_email || '',
    replyTo: r.reply_to || r.support_email || '',
    smtp,
  };
}

const SELECT = `SELECT r.*, u.company FROM resellers r JOIN users u ON u.id = r.user_id`;

// The branding a client's emails use: their reseller's when white-label (or
// Mixxbee processing, which is white-label paid through us) is on.
async function forClient(userId) {
  const { rows: [r] } = await query(
    `${SELECT} WHERE (r.white_label OR r.use_mixxbee) AND r.user_id = (SELECT reseller_id FROM users WHERE id = $1)`, [userId]);
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

// The white-label reseller whose own domain this is (null if none).
async function forHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!h) return null;
  const { rows: [r] } = await query(`${SELECT} WHERE lower(r.custom_domain) = $1 AND (r.white_label OR r.use_mixxbee) AND r.active`, [h]);
  return toBrand(r);
}

module.exports = { forClient, forReseller, resellerOf, forHost };

const nodemailer = require('nodemailer');
const { render } = require('./emailTemplate');

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;

const makeTransport = ({ host, port, user, pass }) => nodemailer.createTransport({
  host,
  port: Number(port || 587),
  secure: Number(port) === 465,
  auth: user ? { user, pass } : undefined,
  // Fail fast so an unreachable mail server doesn't hang the admin's request.
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
});

const transport = SMTP_HOST ? makeTransport({ host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, pass: SMTP_PASS }) : null;

const enabled = () => Boolean(transport);

// White-label resellers can send through their own mail server; transports are
// reused per server/account/password.
const brandTransports = new Map();
function brandTransport(smtp) {
  const key = `${smtp.host}|${smtp.port}|${smtp.user}|${smtp.pass}`;
  if (!brandTransports.has(key)) brandTransports.set(key, makeTransport(smtp));
  return brandTransports.get(key);
}
const quoteName = (n) => `"${String(n).replace(/["\\\r\n]/g, '')}"`;

// Builds the branded HTML from the plain text: the button carries the main
// link (lines ending with it are dropped), the note gets its own box, and the
// text's own "Mithmill" sign-off gives way to the template's.
function toHtml({ subject, text, heading, cta, note, reason, preheader, html, after, htmlText, buttons, alert, brand }) {
  // With a pre-built block, `htmlText` is the intro shown above it; `text` stays the plain-text part.
  if (html) return render({ heading: heading || subject, text: htmlText, html, after, buttons, alert, cta, note, reason, brand, preheader: preheader || String(htmlText || '').replace(/\s+/g, ' ').slice(0, 140) });
  let body = String(text || '');
  if (note) body = body.split(note).join('');
  if (after) body = body.split(after).join(''); // shown below the Pay buttons instead
  if (cta && cta.url) body = body.split('\n').filter((l) => !l.trim().endsWith(cta.url)).join('\n');
  // Pay links get buttons; their "Pay with …: url" lines are dropped from the body.
  (buttons || []).forEach((b) => { body = body.split('\n').filter((l) => !l.trim().endsWith(b.url) && (!b.hint || l.trim() !== b.hint)).join('\n'); });
  body = body.replace(/\n+Mithmill\s*$/, '');
  if (brand && body.trimEnd().endsWith(`\n${brand.name}`)) body = body.trimEnd().slice(0, -brand.name.length);
  body = body.replace(/\n{3,}/g, '\n\n').trimEnd();
  return render({ heading: heading || subject, text: body, buttons, after, alert, cta, note, reason, brand, preheader: preheader || body.replace(/\s+/g, ' ').slice(0, 140) });
}

// Never throws: a failed email must not break an invite, order or reminder.
// Options: to, subject, text, and optionally heading, cta {label, url}, note, reason,
// and brand (a reseller's white-label branding from brands.js).
async function sendMail(opts) {
  const { to, subject } = opts;
  if (!transport) {
    console.log(`[mail disabled] to=${to} subject="${subject}"`);
    return false;
  }
  try {
    let text = opts.text || '';
    const missing = (opts.buttons || []).filter((b) => !text.includes(b.url));
    if (missing.length) text += `\n\n${missing.map((b) => `${b.hint ? `${b.hint}\n` : ''}${b.label}: ${b.url}`).join('\n')}`;
    if (opts.cta && opts.cta.url && !text.includes(opts.cta.url)) text += `\n\n${opts.cta.label}: ${opts.cta.url}`;
    const html = toHtml(opts);
    const { brand } = opts;
    if (brand && brand.smtp) {
      // The reseller's own mail server; if it fails, fall back to ours under their name.
      try {
        await brandTransport(brand.smtp).sendMail({
          from: `${quoteName(brand.senderName)} <${brand.senderEmail || brand.smtp.user}>`,
          replyTo: brand.replyTo || undefined, to, subject, text, html,
        });
        return true;
      } catch (err) {
        console.error(`[mail failed via reseller ${brand.resellerId} SMTP, using ours] to=${to}: ${err.message}`);
      }
    }
    await transport.sendMail({
      from: brand ? `${quoteName(brand.senderName)} <${SMTP_USER || SMTP_FROM}>` : SMTP_FROM || SMTP_USER,
      replyTo: brand && brand.replyTo ? brand.replyTo : undefined,
      to, subject, text, html,
    });
    return true;
  } catch (err) {
    console.error(`[mail failed] to=${to}: ${err.message}`);
    return false;
  }
}

module.exports = { sendMail, enabled, toHtml };

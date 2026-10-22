const nodemailer = require('nodemailer');
const { render } = require('./emailTemplate');

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;

const transport = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: Number(SMTP_PORT) === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      // Fail fast so an unreachable mail server doesn't hang the admin's request.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    })
  : null;

const enabled = () => Boolean(transport);

// Builds the branded HTML from the plain text: the button carries the main
// link (lines ending with it are dropped), the note gets its own box, and the
// text's own "Mithmill" sign-off gives way to the template's.
function toHtml({ subject, text, heading, cta, note, reason, preheader, html, after, htmlText }) {
  // With a pre-built block, `htmlText` is the intro shown above it; `text` stays the plain-text part.
  if (html) return render({ heading: heading || subject, text: htmlText, html, after, cta, note, reason, preheader: preheader || String(htmlText || '').replace(/\s+/g, ' ').slice(0, 140) });
  let body = String(text || '');
  if (note) body = body.split(note).join('');
  if (cta && cta.url) body = body.split('\n').filter((l) => !l.trim().endsWith(cta.url)).join('\n');
  body = body.replace(/\n+Mithmill\s*$/, '').replace(/\n{3,}/g, '\n\n');
  return render({ heading: heading || subject, text: body, cta, note, reason, preheader: preheader || body.replace(/\s+/g, ' ').slice(0, 140) });
}

// Never throws: a failed email must not break an invite, order or reminder.
// Options: to, subject, text, and optionally heading, cta {label, url}, note, reason.
async function sendMail(opts) {
  const { to, subject } = opts;
  if (!transport) {
    console.log(`[mail disabled] to=${to} subject="${subject}"`);
    return false;
  }
  try {
    let text = opts.text || '';
    if (opts.cta && opts.cta.url && !text.includes(opts.cta.url)) text += `\n\n${opts.cta.label}: ${opts.cta.url}`;
    await transport.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text, html: toHtml(opts) });
    return true;
  } catch (err) {
    console.error(`[mail failed] to=${to}: ${err.message}`);
    return false;
  }
}

module.exports = { sendMail, enabled, toHtml };

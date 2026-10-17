const nodemailer = require('nodemailer');

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

// Never throws: a failed email must not break an invite, order or reminder.
async function sendMail({ to, subject, text }) {
  if (!transport) {
    console.log(`[mail disabled] to=${to} subject="${subject}"`);
    return false;
  }
  try {
    await transport.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text });
    return true;
  } catch (err) {
    console.error(`[mail failed] to=${to}: ${err.message}`);
    return false;
  }
}

module.exports = { sendMail, enabled };

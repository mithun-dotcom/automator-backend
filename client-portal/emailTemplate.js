// Branded HTML for every email the portal sends. Table layout with inline
// styles so it renders the same in Gmail, Outlook and Apple Mail; a plain-text
// part is always sent alongside it.

// Footer links and contact details. Set at boot and whenever Settings change.
const brand = {
  appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
  website: 'https://mithmill.com',
  privacyUrl: 'https://mithmill.com/privacy-policy',
  termsUrl: 'https://mithmill.com/terms',
  supportEmail: 'support@mithmill.com',
};
function setBrand(values) {
  for (const [k, v] of Object.entries(values)) if (v) brand[k] = v;
}

const C = {
  navy: '#211c5c', navyDark: '#1a1748', ink: '#0f172a', text: '#334155', muted: '#64748b',
  faint: '#94a3b8', line: '#e2e8f0', bg: '#f5f7f6', gold: '#bd7722', goldBg: '#fdf8ec', goldLine: '#faedc9',
};
const FONT = "Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" style="color:${C.navy};word-break:break-all">$1</a>`);

// Plain text -> paragraphs, with "• " lines as a list. Lines that are just the
// button's URL are dropped (the button carries it).
function textToHtml(text, skipUrl) {
  const blocks = String(text || '').trim().split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split('\n').filter((l) => !(skipUrl && l.trim() === skipUrl));
    if (!lines.length) return '';
    if (lines.every((l) => /^\s*•/.test(l) || /^\s{2,}/.test(l))) {
      const items = [];
      lines.forEach((l) => {
        if (/^\s*•/.test(l)) items.push(l.replace(/^\s*•\s?/, ''));
        else if (items.length) items[items.length - 1] += `\n${l.trim()}`;
      });
      return `<ul style="margin:0 0 16px;padding-left:20px;color:${C.text}">${items.map((it) => `<li style="margin:4px 0;line-height:1.55">${linkify(esc(it)).replace(/\n/g, '<br>')}</li>`).join('')}</ul>`;
    }
    return `<p style="margin:0 0 16px;line-height:1.6;color:${C.text}">${linkify(esc(lines.join('\n'))).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

function button(cta) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr><td align="center" bgcolor="${C.navy}" style="border-radius:8px">
    <a href="${esc(cta.url)}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;background:${C.navy}">${esc(cta.label)}</a>
  </td></tr></table>
  <p style="margin:0 0 20px;font-size:12px;line-height:1.5;color:${C.faint}">Button not working? Paste this link into your browser:<br><a href="${esc(cta.url)}" style="color:${C.muted};word-break:break-all">${esc(cta.url)}</a></p>`;
}

/**
 * render({ heading, text, cta: {label, url}, note, preheader, reason })
 *  heading   big title at the top of the card
 *  text      body as plain text (paragraphs, "• " lists, links)
 *  cta       main button
 *  note      highlighted notice (e.g. the Mixxbee LLC payment note)
 *  reason    why they're getting this email (footer)
 *  html      optional pre-built HTML block (e.g. an invoice table), shown after the text
 *  after     optional plain text shown after that block
 */
function render({ heading, text, cta, note, preheader, reason, html, after }) {
  const logo = brand.appUrl ? `${brand.appUrl}/logo-full.png` : '';
  const links = [
    ['Website', brand.website], ['Client portal', brand.appUrl], ['Privacy policy', brand.privacyUrl], ['Terms', brand.termsUrl],
  ].filter(([, url]) => url).map(([label, url]) => `<a href="${esc(url)}" style="color:${C.muted};text-decoration:underline">${label}</a>`).join(' &nbsp;·&nbsp; ');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(heading || '')}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg}">${esc(preheader || '')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
      <tr><td style="height:6px;background:${C.navyDark};border-radius:12px 12px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>
      <tr><td style="background:#ffffff;border:1px solid ${C.line};border-top:0;border-radius:0 0 12px 12px;padding:32px 36px 28px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-bottom:24px;border-bottom:1px solid ${C.line}">
          ${logo ? `<img src="${esc(logo)}" width="180" alt="MithMill" style="display:block;width:180px;max-width:60%;height:auto;border:0">` : `<span style="font-size:22px;font-weight:700;color:${C.navy}">MithMill</span>`}
        </td></tr></table>
        ${heading ? `<h1 style="margin:28px 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:${C.ink}">${esc(heading)}</h1>` : '<div style="height:24px"></div>'}
        ${textToHtml(text, cta && cta.url)}
        ${html || ''}
        ${after ? textToHtml(after) : ''}
        ${cta ? button(cta) : ''}
        ${note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px"><tr><td style="background:${C.goldBg};border:1px solid ${C.goldLine};border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.55;color:${C.text}"><strong style="color:${C.gold}">Payment notice:</strong> ${esc(note)}</td></tr></table>` : ''}
        <p style="margin:24px 0 0;line-height:1.6;color:${C.text}">Best regards,<br><strong style="color:${C.ink}">The MithMill team</strong></p>
      </td></tr>
      <tr><td align="center" style="padding:24px 12px 8px;font-size:12px;line-height:1.7;color:${C.faint}">
        <div style="font-weight:600;color:${C.navy};font-size:13px">MithMill</div>
        <div>From Cold to Gold: Email Strategies That Shine</div>
        <div style="margin-top:8px">${links}</div>
        <div style="margin-top:8px">Questions? <a href="mailto:${esc(brand.supportEmail)}" style="color:${C.muted}">${esc(brand.supportEmail)}</a></div>
        <div style="margin-top:8px">Payments are collected by Mixxbee LLC, MithMill's billing company.</div>
        <div style="margin-top:8px">${esc(reason || 'You are receiving this email because you have an account on the MithMill client portal.')}</div>
        <div style="margin-top:8px">© ${new Date().getFullYear()} MithMill. All rights reserved.</div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

module.exports = { render, setBrand, brand, esc, C };

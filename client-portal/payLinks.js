// Finds payment links in an invoice's notes so emails and the invoice page can
// show them as Pay buttons. Known checkout domains (Stripe, Wise, bKash, ...)
// always count; any other link counts when its line names a payment method or
// says "pay". Each link is a 'pay' link (Pay now) or, for a Stripe
// subscription, an 'update' link (Update payment method). Bank details and IDs without a link stay as plain notes.

const PROVIDERS = [
  ['Stripe', /(^|\.)(stripe\.com|stripe\.link)$/],
  ['Wise', /(^|\.)(wise\.com|transferwise\.com)$/],
  ['bKash', /(^|\.)(bkash\.com|bka\.sh)$/],
  ['Binance Pay', /(^|\.)(binance\.com|binance\.me)$/],
  ['PayPal', /(^|\.)(paypal\.com|paypal\.me)$/],
  ['Payoneer', /(^|\.)payoneer\.com$/],
  ['Nagad', /(^|\.)nagad\.com\.bd$/],
  ['Razorpay', /(^|\.)(razorpay\.com|rzp\.io)$/],
  ['Square', /(^|\.)(square\.link|squareup\.com)$/],
  ['Lemon Squeezy', /(^|\.)lemonsqueezy\.com$/],
  ['Gumroad', /(^|\.)gumroad\.com$/],
  ['Revolut', /(^|\.)revolut\.(me|com)$/],
  ['Coinbase', /(^|\.)commerce\.coinbase\.com$/],
];
const NAMED = /\b(stripe|wise|bkash|binance|paypal|payoneer|nagad|rocket|razorpay|revolut|crypto|usdt|card)\b/i;
const PAY_WORD = /\bpay(ment|able)?\b/i;
// A Stripe link for keeping a subscription going rather than paying once:
// Stripe's customer portal, or a link whose line says so.
const RENEW_WORD = /\b(renew(al|s)?|recurring|subscription|auto[- ]?renew(al)?|update (your )?(card|payment))\b/i;
const isUpdateLink = (url, line, provider) => {
  if (provider !== 'Stripe') return false;
  try { if (new URL(url).hostname.toLowerCase() === 'billing.stripe.com') return true; } catch { return false; }
  return RENEW_WORD.test(line);
};

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

function providerOf(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const hit = PROVIDERS.find(([, re]) => re.test(host));
  return hit ? hit[0] : null;
}

// The method's name written before the link on its line, e.g. "bKash: https://…".
function labelBefore(line, url) {
  const before = line.slice(0, line.indexOf(url)).replace(/[\s:–—-]+$/, '').trim();
  if (!before || before.length > 40 || /https?:/i.test(before)) return null;
  return before.replace(/^(pay(ment)?\s*(link|via|with|by)?\s*[:-]?\s*)/i, '').trim() || null;
}

function findPayLinks(notes) {
  const links = [];
  const seen = new Set();
  for (const line of String(notes || '').split('\n')) {
    for (const raw of line.match(URL_RE) || []) {
      const url = raw.replace(/[.,;:!?]+$/, '');
      if (seen.has(url)) continue;
      const provider = providerOf(url);
      const named = labelBefore(line, raw);
      if (!provider && !(NAMED.test(line) || PAY_WORD.test(line))) continue;
      seen.add(url);
      const method = provider || (named && named.replace(/\s*(payments?\s*)?(link|url)?$/i, '').trim()) || null;
      const kind = isUpdateLink(url, line, provider) ? 'update' : 'pay';
      links.push({ url, method, kind });
    }
  }
  return links;
}

module.exports = { findPayLinks };

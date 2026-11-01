// DNS health of a client's sending domain for the mailbox provider it's set up
// on: MX, SPF, DMARC and DKIM. Also detects the provider from the MX records.
const dns = require('dns');

const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
if (process.env.DNS_SERVERS) resolver.setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));
// Swappable for tests.
const api = {
  mx: (d) => resolver.resolveMx(d),
  txt: (d) => resolver.resolveTxt(d),
  cname: (d) => resolver.resolveCname(d),
};

const PROVIDERS = {
  google: { name: 'Google Workspace', mx: /(^|\.)(google|googlemail)\.com$|^aspmx/i, spf: '_spf.google.com', dkim: 'google._domainkey' },
  microsoft: { name: 'Microsoft 365', mx: /\.mail\.protection\.outlook\.com$|\.outlook\.com$/i, spf: 'spf.protection.outlook.com', dkim: 'selector1._domainkey' },
  zoho: { name: 'Zoho', mx: /zoho\./i, spf: 'zoho', dkim: null },
};

// The provider a mailbox type is set up on (by its key/label), or null.
function providerOf(type) {
  const s = `${type && type.inbox_type} ${type && type.label}`;
  if (/google|gmail/i.test(s)) return 'google';
  if (/azure|m365|microsoft|outlook|office/i.test(s)) return 'microsoft';
  return null;
}

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// "https://www.Example.com/path" -> "www.example.com"; null if it isn't a domain.
function clean(raw) {
  let d = String(raw || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  if (d.includes('@')) return null;
  d = d.replace(/:\d+$/, '').replace(/^www\./, '');
  return DOMAIN_RE.test(d) ? d : null;
}

const quiet = async (fn) => {
  try { return await fn(); } catch (err) {
    if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ESERVFAIL'].includes(err.code)) return null;
    throw err;
  }
};
const txtOf = (recs) => (recs || []).map((r) => r.join(''));

// -> { status: ok|warning|error, detected, mx, spf, dmarc, dkim, issues: [] }
async function check(domain, expected) {
  const out = { detected: 'none', mx: [], spf: null, dmarc: null, dkim: null, issues: [] };
  try {
    const mx = await quiet(() => api.mx(domain));
    out.mx = (mx || []).sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase());
    const found = Object.entries(PROVIDERS).find(([, p]) => out.mx.some((h) => p.mx.test(h)));
    out.detected = found ? found[0] : out.mx.length ? 'other' : 'none';
    out.spf = txtOf(await quiet(() => api.txt(domain))).find((t) => /^v=spf1/i.test(t)) || null;
    out.dmarc = txtOf(await quiet(() => api.txt(`_dmarc.${domain}`))).find((t) => /^v=dmarc1/i.test(t)) || null;
    const p = PROVIDERS[expected || out.detected];
    if (p && p.dkim) {
      out.dkim = expected === 'microsoft' || (!expected && out.detected === 'microsoft')
        ? Boolean((await quiet(() => api.cname(`${p.dkim}.${domain}`)) || []).length)
        : txtOf(await quiet(() => api.txt(`${p.dkim}.${domain}`))).some((t) => /v=dkim1|p=/i.test(t));
    }

    const wrongMx = Boolean(out.mx.length && expected && out.detected !== expected);
    if (!out.mx.length) out.issues.push('No MX records: the domain can\'t receive email');
    else if (wrongMx) {
      out.issues.push(`MX points to ${PROVIDERS[out.detected] ? PROVIDERS[out.detected].name : 'another provider'}, not ${PROVIDERS[expected].name}`);
    }
    if (!out.spf) out.issues.push('No SPF record');
    else if (p && !out.spf.toLowerCase().includes(p.spf)) out.issues.push(`SPF doesn't include ${p.name} (include:${p.spf})`);
    if (!out.dmarc) out.issues.push('No DMARC record (_dmarc)');
    if (out.dkim === false) out.issues.push(`DKIM not set up (${p.dkim})`);
    out.status = !out.mx.length || wrongMx ? 'error' : out.issues.length ? 'warning' : 'ok';
  } catch (err) {
    out.status = 'error';
    out.issues.push(`DNS lookup failed (${err.code || err.message})`);
  }
  return out;
}

module.exports = { check, clean, providerOf, PROVIDERS, api };

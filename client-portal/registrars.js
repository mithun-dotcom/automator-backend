// Domain hosts (registrars) a client connects with their API keys, so the
// portal can point their domains' nameservers at Mithmill's Cloudflare.
// Each provider: fields to ask for, a test call (checks the keys), and
// setNameservers(creds, domain, nameservers). "manual" is any host without
// a usable API: the client changes the nameservers themselves.

const ua = 'Mithmill-Client-Portal/1.0';

class HostError extends Error {}

async function http(method, url, { headers = {}, body, form } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'User-Agent': ua, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : form,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new HostError(`Couldn't reach the domain host (${err.message})`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { ok: res.ok, status: res.status, data, text };
}

// The message a host put in its error answer, if any.
const errOf = (r) => {
  const d = r.data || {};
  const msg = d.message || d.detail || d.error || (d.errors && (d.errors[0] && (d.errors[0].message || d.errors[0].detail || d.errors[0]))) || '';
  return typeof msg === 'string' && msg ? msg : `HTTP ${r.status}`;
};
const must = (r, what) => {
  if (!r.ok) throw new HostError(`${what}: ${errOf(r)}`);
  return r;
};

// Namecheap only accepts API calls from whitelisted IPs: ours, looked up once.
let outboundIp = null;
async function myIp() {
  if (outboundIp) return outboundIp;
  const r = await http('GET', 'https://api.ipify.org?format=json');
  outboundIp = (r.data && r.data.ip) || '';
  return outboundIp;
}
const splitDomain = (d) => { const i = d.indexOf('.'); return [d.slice(0, i), d.slice(i + 1)]; };
const xmlError = (xml) => (xml.match(/<Error[^>]*>([^<]+)<\/Error>/i) || [])[1];

const PROVIDERS = {
  spaceship: {
    name: 'Spaceship',
    fields: [{ key: 'api_key', label: 'API key' }, { key: 'api_secret', label: 'API secret', secret: true }],
    help: 'Spaceship → API Manager → New API key. Give it access to "Domains" (read and write).',
    headers: (c) => ({ 'X-API-Key': c.api_key, 'X-API-Secret': c.api_secret }),
    async test(c) { must(await http('GET', 'https://spaceship.dev/api/v1/domains?take=1&skip=0', { headers: this.headers(c) }), 'Spaceship rejected the keys'); },
    async setNameservers(c, domain, ns) {
      must(await http('PUT', `https://spaceship.dev/api/v1/domains/${encodeURIComponent(domain)}/nameservers`,
        { headers: this.headers(c), body: { provider: 'custom', hosts: ns } }), 'Spaceship');
    },
  },
  godaddy: {
    name: 'GoDaddy',
    fields: [{ key: 'api_key', label: 'API key' }, { key: 'api_secret', label: 'API secret', secret: true }],
    help: 'developer.godaddy.com → API Keys → Create New API Key (choose Production). Note: GoDaddy only allows its API for accounts with 10+ domains or a Domain Pro plan.',
    headers: (c) => ({ Authorization: `sso-key ${c.api_key}:${c.api_secret}` }),
    async test(c) { must(await http('GET', 'https://api.godaddy.com/v1/domains?limit=1', { headers: this.headers(c) }), 'GoDaddy rejected the keys'); },
    async setNameservers(c, domain, ns) {
      must(await http('PATCH', `https://api.godaddy.com/v1/domains/${encodeURIComponent(domain)}`,
        { headers: this.headers(c), body: { nameServers: ns } }), 'GoDaddy');
    },
  },
  namecheap: {
    name: 'Namecheap',
    fields: [{ key: 'username', label: 'Namecheap username' }, { key: 'api_key', label: 'API key', secret: true }],
    help: 'Namecheap → Profile → Tools → Namecheap API Access → turn it on, copy the API key, and add our server IP to the whitelist (shown below).',
    needsIp: true,
    async call(c, command, extra = {}) {
      const ip = await myIp();
      const q = new URLSearchParams({ ApiUser: c.username, ApiKey: c.api_key, UserName: c.username, ClientIp: ip, Command: command, ...extra });
      const r = await http('GET', `https://api.namecheap.com/xml.response?${q}`);
      if (!/Status="OK"/i.test(r.text)) throw new HostError(`Namecheap: ${xmlError(r.text) || `HTTP ${r.status}`}`);
      return r;
    },
    async test(c) { await this.call(c, 'namecheap.domains.getList', { PageSize: '10' }); },
    async setNameservers(c, domain, ns) {
      const [sld, tld] = splitDomain(domain);
      await this.call(c, 'namecheap.domains.dns.setCustom', { SLD: sld, TLD: tld, Nameservers: ns.join(',') });
    },
  },
  hostinger: {
    name: 'Hostinger',
    fields: [{ key: 'api_token', label: 'API token', secret: true }],
    help: 'Hostinger hPanel → Profile → API → Generate token.',
    headers: (c) => ({ Authorization: `Bearer ${c.api_token}` }),
    async test(c) { must(await http('GET', 'https://developers.hostinger.com/api/domains/v1/portfolio', { headers: this.headers(c) }), 'Hostinger rejected the token'); },
    async setNameservers(c, domain, ns) {
      const body = Object.fromEntries(ns.slice(0, 4).map((n, i) => [`ns${i + 1}`, n]));
      must(await http('PUT', `https://developers.hostinger.com/api/domains/v1/portfolio/${encodeURIComponent(domain)}/nameservers`,
        { headers: this.headers(c), body }), 'Hostinger');
    },
  },
  namecom: {
    name: 'Name.com',
    fields: [{ key: 'username', label: 'Name.com username' }, { key: 'api_token', label: 'API token', secret: true }],
    help: 'Name.com → Account → Settings → Security → API Management → create a production token.',
    headers: (c) => ({ Authorization: `Basic ${Buffer.from(`${c.username}:${c.api_token}`).toString('base64')}` }),
    async test(c) { must(await http('GET', 'https://api.name.com/v4/domains?perPage=1', { headers: this.headers(c) }), 'Name.com rejected the token'); },
    async setNameservers(c, domain, ns) {
      must(await http('POST', `https://api.name.com/v4/domains/${encodeURIComponent(domain)}:setNameservers`,
        { headers: this.headers(c), body: { nameservers: ns } }), 'Name.com');
    },
  },
  dynadot: {
    name: 'Dynadot',
    fields: [{ key: 'api_key', label: 'API key', secret: true }],
    help: 'Dynadot → Tools → API → generate the production key (and allow our server IP if you set an IP list).',
    async call(c, command, extra = {}) {
      const q = new URLSearchParams({ key: c.api_key, command, ...extra });
      const r = await http('GET', `https://api.dynadot.com/api3.json?${q}`);
      const resp = r.data && Object.values(r.data).find((v) => v && typeof v === 'object' && 'ResponseCode' in v);
      if (!r.ok || !resp || String(resp.ResponseCode) !== '0') throw new HostError(`Dynadot: ${(resp && (resp.Error || resp.Status)) || `HTTP ${r.status}`}`);
      return resp;
    },
    async test(c) { await this.call(c, 'list_domain'); },
    async setNameservers(c, domain, ns) {
      await this.call(c, 'set_ns', { domain, ...Object.fromEntries(ns.slice(0, 13).map((n, i) => [`ns${i}`, n])) });
    },
  },
  porkbun: {
    name: 'Porkbun',
    fields: [{ key: 'api_key', label: 'API key' }, { key: 'secret_key', label: 'Secret API key', secret: true }],
    help: 'Porkbun → Account → API Access → Create API key, then turn on "API Access" for each domain.',
    auth: (c) => ({ apikey: c.api_key, secretapikey: c.secret_key }),
    async post(path, body) {
      const r = await http('POST', `https://api.porkbun.com/api/json/v3${path}`, { body });
      if (!r.ok || !r.data || r.data.status !== 'SUCCESS') throw new HostError(`Porkbun: ${(r.data && r.data.message) || `HTTP ${r.status}`}`);
      return r;
    },
    async test(c) { await this.post('/ping', this.auth(c)); },
    async setNameservers(c, domain, ns) { await this.post(`/domain/updateNs/${encodeURIComponent(domain)}`, { ...this.auth(c), ns }); },
  },
  manual: {
    name: 'Other host (manual)',
    fields: [{ key: 'host_name', label: 'Host name (e.g. DreamHost)', optional: true }],
    help: 'For hosts without an API we can use (DreamHost and others): we add the domain to Cloudflare and show you the two nameservers to set at your host yourself.',
    manual: true,
    async test() {},
  },
};

// What the browser may know about the providers (no functions).
const publicList = () => Object.entries(PROVIDERS).map(([key, p]) => ({
  key, name: p.name, help: p.help, manual: Boolean(p.manual), needsIp: Boolean(p.needsIp),
  fields: p.fields.map((f) => ({ key: f.key, label: f.label, secret: Boolean(f.secret), optional: Boolean(f.optional) })),
}));

// Only the fields the provider asks for, trimmed. Throws if one is missing.
function cleanCreds(provider, input) {
  const p = PROVIDERS[provider];
  if (!p) throw new HostError('Choose a domain host');
  const out = {};
  for (const f of p.fields) {
    const v = String((input || {})[f.key] || '').trim().slice(0, 500);
    if (!v && !f.optional) throw new HostError(`Enter the ${f.label}`);
    out[f.key] = v;
  }
  return out;
}

// "ab••••yz" for showing a saved key.
const mask = (v) => (!v ? '' : v.length <= 6 ? '••••' : `${v.slice(0, 3)}••••${v.slice(-2)}`);

module.exports = { PROVIDERS, publicList, cleanCreds, mask, myIp, HostError };

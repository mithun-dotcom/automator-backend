// DKIM Automator: Chrome extension worker.
// Polls the dashboard for Google Admin steps and performs them in a background tab of
// THIS Chrome, where the admin is already signed in. No passwords are handled here.
importScripts('config.js');

const VERSION = chrome.runtime.getManifest().version;
const DKIM_URL = 'https://admin.google.com/ac/apps/gmail/authenticateemail';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function settings() {
  const s = await chrome.storage.local.get(['serverUrl', 'key', 'enabled', 'agentId']);
  let agentId = s.agentId;
  if (!agentId) { agentId = crypto.randomUUID(); await chrome.storage.local.set({ agentId }); }
  return {
    serverUrl: String(s.serverUrl || self.DKIM_DEFAULTS.serverUrl || '').replace(/\/+$/, ''),
    key: s.key != null && s.key !== '' ? s.key : self.DKIM_DEFAULTS.key,
    enabled: s.enabled !== false,
    agentId,
  };
}

async function api(path, body) {
  const s = await settings();
  if (!s.serverUrl) throw new Error('Server URL not set');
  const r = await fetch(s.serverUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa('agent:' + (s.key || '')) },
    body: JSON.stringify({ agentId: s.agentId, version: VERSION, ...body }),
  });
  if (r.status === 401) throw new Error('Wrong access key (dashboard password)');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Server error ${r.status}`);
  return j;
}

async function setStatus(patch) {
  const { status = {} } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...status, ...patch, at: Date.now() } });
}
async function addLog(msg) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.push(`${new Date().toLocaleTimeString()}  ${msg}`);
  await chrome.storage.local.set({ log: log.slice(-60) });
}

// ── Work tab ────────────────────────────────────────────────────────────────
async function workTab() {
  const { tabId } = await chrome.storage.local.get('tabId');
  if (tabId) {
    try { const t = await chrome.tabs.get(tabId); if (t) return t; } catch {}
  }
  const t = await chrome.tabs.create({ url: 'about:blank', active: false, pinned: true });
  await chrome.storage.local.set({ tabId: t.id });
  return t;
}

function waitLoaded(tabId, timeout = 45000) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(fn); clearTimeout(timer); resolve(); };
    const fn = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(fn);
  });
}

async function navigate(tabId, url) {
  const p = waitLoaded(tabId);
  await chrome.tabs.update(tabId, { url });
  await p;
  await sleep(2500); // Admin console is a single-page app; let it render
  return chrome.tabs.get(tabId);
}

async function page(tabId, op, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: dkimPage, args: [op, ...args] });
  return res && res.result;
}

// ── One step ────────────────────────────────────────────────────────────────
class StepError extends Error { constructor(msg, kind, debug) { super(msg); this.kind = kind; this.debug = debug; } }

async function openForTenant(tabId, tenant, log) {
  // adminUrlOverride exists only for automated tests against a mock page
  const { adminUrlOverride } = await chrome.storage.local.get('adminUrlOverride');
  const base = adminUrlOverride || DKIM_URL;
  const url = `${base}?authuser=${encodeURIComponent(tenant)}`;
  let tab = await navigate(tabId, url);
  if (!tab.url.startsWith(new URL(base).origin + '/') || /\/signin|ServiceLogin|accounts\.google\.com/.test(tab.url)) {
    throw new StepError(`This Chrome is not signed in to Google Admin as ${tenant}`, 'auth', { url: tab.url });
  }
  const accounts = await page(tabId, 'account');
  if (accounts && accounts.length && !accounts.includes(tenant.toLowerCase())) {
    throw new StepError(`Google Admin opened as ${accounts[0]}, not ${tenant}. Sign in to ${tenant} in this Chrome too`, 'auth');
  }
  const ready = await page(tabId, 'waitPanel');
  if (!ready.ok) throw new StepError('Authenticate email page did not load (is Gmail enabled and is this account a super admin?)', undefined, ready.debug);
  log('Opened Gmail → Authenticate email');
}

async function selectDomain(tabId, domain, log) {
  const r = await page(tabId, 'select', [domain]);
  if (!r.ok) throw new StepError(`Domain ${domain} was not found in the "Selected domain" list of this tenant`, 'fatal', r.debug);
  await sleep(2500);
  log(`Selected ${domain}`);
}

async function runItem(item) {
  const logs = [];
  const log = m => { logs.push(m); addLog(`${item.domain}: ${m}`); };
  const tab = await workTab();
  try {
    await openForTenant(tab.id, item.tenant, log);
    await selectDomain(tab.id, item.domain, log);
    let p = await page(tab.id, 'read');
    log(`Google status: ${p.status}${p.txtValue ? ' (record exists)' : ''}`);

    if (item.action === 'generate') {
      if (p.status === 'authenticating' && !item.regenerate) {
        return { ok: true, result: { ...p, preserved: true }, log: logs };
      }
      if (!p.txtValue || item.regenerate) {
        log(`Generating ${item.keyLength}-bit key, selector "${item.selector}"`);
        p = await page(tab.id, 'generate', [item.selector, item.keyLength]);
        if (p.error) throw new StepError(p.error, undefined, p.debug);
      }
      if (!p.txtValue) {
        if (p.wait) throw new StepError('Google says to wait 24–72h after Gmail setup before generating DKIM', 'wait', p.debug);
        throw new StepError('Could not read the TXT record value from the page', undefined, p.debug);
      }
      log('Read TXT record');
      return { ok: true, result: p, log: logs };
    }

    // activate
    if (p.status !== 'authenticating') {
      log('Clicking Start authentication');
      p = await page(tab.id, 'start');
      if (p.status !== 'authenticating') {
        // the status sometimes only updates after a reload
        await openForTenant(tab.id, item.tenant, () => {});
        await selectDomain(tab.id, item.domain, () => {});
        const again = await page(tab.id, 'read');
        if (again.status === 'authenticating') p = again;
      }
    }
    if (p.status === 'authenticating') { log('Authentication started'); return { ok: true, result: p, log: logs }; }
    throw new StepError(`Google did not start authentication${p.message ? `: ${p.message}` : ''}`, 'activation', p.debug);
  } catch (e) {
    return { ok: false, error: e.message, kind: e.kind, debug: e.debug, log: logs };
  }
}

// ── Poll loop ───────────────────────────────────────────────────────────────
let busy = false;
async function poll() {
  if (busy) return;
  const s = await settings();
  if (!s.enabled || !s.serverUrl) { await setStatus({ connected: false, error: s.serverUrl ? 'Paused' : 'Set the server URL' }); return; }
  busy = true;
  try {
    for (let i = 0; i < 200; i++) {
      const { item } = await api('/api/agent/claim');
      await setStatus({ connected: true, error: null, current: item ? `${item.action} ${item.domain}` : null });
      if (!item) break;
      await addLog(`${item.domain}: ${item.action}…`);
      const out = await runItem(item);
      await addLog(`${item.domain}: ${out.ok ? '✓ done' : '✗ ' + out.error}`);
      await api('/api/agent/report', { jobId: item.jobId, domain: item.domain, action: item.action, ...out });
    }
  } catch (e) {
    await setStatus({ connected: false, error: e.message });
  } finally {
    busy = false;
    await setStatus({ current: null });
  }
}

chrome.alarms.create('poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'poll') poll(); });
chrome.runtime.onStartup.addListener(poll);
chrome.runtime.onInstalled.addListener(poll);
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg === 'poll') { poll().then(() => reply(true)); return true; }
});

// ── Runs INSIDE the admin.google.com page (must be self-contained) ──────────
async function dkimPage(op, a1, a2) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.offsetParent !== null;
  const text = () => (document.body ? document.body.innerText : '');
  const realClick = el => {
    const t = el.closest('button, [role="button"], [role="option"], [role="menuitem"], [role="radio"], a, li, label') || el;
    t.scrollIntoView({ block: 'center' });
    const o = { bubbles: true, cancelable: true, view: window };
    for (const ty of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) t.dispatchEvent(new MouseEvent(ty, o));
    t.click();
  };
  const findText = (texts, root = document) => {
    const els = [...root.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], span, div')].filter(vis);
    for (const t of texts) {
      const e = els.find(e => e.textContent.trim().toLowerCase() === t.toLowerCase());
      if (e) return e;
    }
    return null;
  };
  const waitFor = async (fn, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(300); }
    return null;
  };
  const debug = () => ({
    url: location.href,
    buttons: [...document.querySelectorAll('button, [role="button"]')].filter(vis).map(b => b.textContent.trim()).filter(Boolean).slice(0, 30),
    dropdowns: [...document.querySelectorAll('[role="listbox"], [role="combobox"], [aria-haspopup="listbox"], select')].map(e => e.textContent.trim().slice(0, 80)),
    text: text().slice(0, 700),
  });
  const read = () => {
    const t = text();
    let txt = null;
    for (const el of document.querySelectorAll('textarea, input')) if ((el.value || '').includes('v=DKIM1')) { txt = el.value.trim(); break; }
    if (!txt) { const m = t.match(/v=DKIM1;[^\n]+/); if (m) txt = m[0].trim(); }
    if (txt) txt = txt.replace(/\s+/g, ' ').replace(/; p= /, '; p=');
    const host = t.match(/\b([a-z0-9-]+)\._domainkey\b/i);
    const l = t.toLowerCase();
    const status = l.includes('authenticating email with dkim') ? 'authenticating' : l.includes('not authenticating') ? 'not_authenticating' : 'unknown';
    const wait = /(24|48)\s*(to|-|–)\s*72 hours|wait.{0,40}before.{0,40}(generat|dkim)|try again later/i.test(t);
    return { txtValue: txt, selector: host ? host[1] : null, status, wait };
  };
  const dropdownSel = '[role="listbox"], [role="combobox"], [aria-haspopup="listbox"]';

  if (op === 'account') {
    const labels = [...document.querySelectorAll('[aria-label*="Google Account" i]')].map(e => e.getAttribute('aria-label')).join(' ');
    return (labels.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || []).map(s => s.toLowerCase());
  }
  if (op === 'waitPanel') {
    const ok = await waitFor(() => /dkim|authenticate email/i.test(text()), 25000);
    await sleep(800);
    return { ok: !!ok, debug: ok ? null : debug() };
  }
  if (op === 'read') return read();

  if (op === 'select') {
    const d = String(a1).toLowerCase();
    const shown = () => [...document.querySelectorAll(dropdownSel + ', select')].some(c =>
      ((c.tagName === 'SELECT' ? c.options[c.selectedIndex]?.text : c.textContent) || '').toLowerCase().split(/[\s()]+/).includes(d));
    if (shown()) return { ok: true };
    for (const s of document.querySelectorAll('select')) {
      const o = [...s.options].find(o => o.text.toLowerCase().trim() === d || o.value.toLowerCase() === d);
      if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; }
    }
    const triggers = [...document.querySelectorAll(dropdownSel)].filter(vis);
    for (const trig of triggers) {
      realClick(trig);
      await sleep(900);
      const opts = [...document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], li')].filter(vis);
      const o = opts.find(e => e.textContent.toLowerCase().trim() === d) ||
                opts.find(e => e.textContent.toLowerCase().trim().split(/[\s()]+/).includes(d));
      if (o) { realClick(o); await sleep(1500); return { ok: true }; }
      document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
    }
    // single-domain tenants have no dropdown
    if (text().toLowerCase().split(/[\s()]+/).includes(d)) return { ok: true };
    return { ok: false, debug: debug() };
  }

  if (op === 'generate') {
    const btn = await waitFor(() => findText(['Generate new record']), 8000);
    if (!btn) return { ...read(), error: '"Generate new record" button not found', debug: debug() };
    realClick(btn);
    const dlg = await waitFor(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find(vis), 8000) || document;
    await sleep(500);
    for (const r of dlg.querySelectorAll('input[type="radio"], [role="radio"]')) {
      const lbl = ((r.closest('label') || r.parentElement || {}).textContent || '') + ' ' + (r.value || r.getAttribute('aria-label') || '');
      if (lbl.includes(String(a2))) { realClick(r); break; }
    }
    for (const s of dlg.querySelectorAll('select')) {
      const o = [...s.options].find(o => o.text.includes(String(a2)));
      if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    const input = [...dlg.querySelectorAll('input[type="text"], input:not([type])')].find(vis);
    if (input && a1) {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, a1);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(400);
    const go = [...dlg.querySelectorAll('button, [role="button"]')].filter(vis).find(b => b.textContent.trim().toLowerCase() === 'generate');
    if (!go) return { ...read(), error: '"Generate" button not found in the dialog', debug: debug() };
    realClick(go);
    const r = await waitFor(() => { const p = read(); return p.txtValue || p.wait ? p : null; }, 30000);
    return r || { ...read(), debug: debug() };
  }

  if (op === 'start') {
    const btn = await waitFor(() => findText(['Start authentication']), 8000);
    if (!btn) return { ...read(), message: '"Start authentication" button not found', debug: debug() };
    realClick(btn);
    const ok = await waitFor(() => read().status === 'authenticating', 20000);
    if (ok) return read();
    const m = text().match(/[^\n]*(dns record|could not|couldn.t|unable|doesn.t match|not found|error)[^\n]*/i);
    return { ...read(), message: m ? m[0].trim().slice(0, 200) : null, debug: debug() };
  }
  return null;
}

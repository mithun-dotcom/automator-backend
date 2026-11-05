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

const isSignInUrl = u => /accounts\.google\.com|\/signin|ServiceLogin|\/AddSession/.test(u);

async function adminBase() {
  // overrides exist only for automated tests against a mock page
  const o = await chrome.storage.local.get(['adminUrlOverride', 'signinUrlOverride']);
  return { base: o.adminUrlOverride || DKIM_URL, signin: o.signinUrlOverride || 'https://accounts.google.com/AddSession' };
}

async function accountOk(tabId, tenant) {
  const accounts = await page(tabId, 'account');
  return !accounts || !accounts.length || accounts.includes(tenant.toLowerCase()) ? true : accounts[0];
}

async function openForTenant(tabId, item, log) {
  const { base } = await adminBase();
  const tenant = item.tenant;
  const url = `${base}?authuser=${encodeURIComponent(tenant)}`;
  const tab = await navigate(tabId, url);
  const onAdmin = tab.url.startsWith(new URL(base).origin + '/') && !isSignInUrl(tab.url);
  const ok = onAdmin ? await accountOk(tabId, tenant) : false;
  if (ok !== true) {
    if (!item.password) {
      throw new StepError(ok
        ? `Google Admin opened as ${ok}, not ${tenant}. Sign in to ${tenant} in this Chrome (or add its password to the job)`
        : `This Chrome is not signed in as ${tenant}. Sign in to it here, or add its password to the job`, 'auth', { url: tab.url });
    }
    await signIn(tabId, item, log);
  }
  const ready = await page(tabId, 'waitPanel');
  if (!ready.ok) throw new StepError('Authenticate email page did not load (is Gmail enabled and is this account a super admin?)', undefined, ready.debug);
  log('Opened Gmail → Authenticate email');
}

// Sign in to Google with the job's admin email + password, in this tab.
async function signIn(tabId, item, log) {
  const { base, signin } = await adminBase();
  const cont = `${base}?authuser=${encodeURIComponent(item.tenant)}`;
  log(`Signing in as ${item.tenant}`);
  await navigate(tabId, `${signin}?Email=${encodeURIComponent(item.tenant)}&continue=${encodeURIComponent(cont)}`);
  for (let step = 0; step < 20; step++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url.startsWith(new URL(base).origin + '/') && !isSignInUrl(tab.url)) {
      const ok = await accountOk(tabId, item.tenant);
      if (ok !== true) throw new StepError(`Signed in, but Google Admin opened as ${ok} instead of ${item.tenant}`, 'auth');
      log('Signed in');
      return;
    }
    const st = await page(tabId, 'signin', [item.tenant, item.password]).catch(() => ({ action: 'none' }));
    if (st.action === 'error') throw new StepError(st.message, 'auth', st.debug);
    if (st.action === 'challenge') { await waitForHuman(tabId, item, st.message, log); continue; }
    if (st.action !== 'none') log(`Sign-in: ${st.action}${st.clicked ? ` (${st.clicked})` : ''}`);
    await sleep(st.action === 'none' ? 2000 : 3500);
    if (step === 12) await navigate(tabId, cont); // nudge towards the admin console
  }
  throw new StepError('Google sign-in did not finish', 'auth');
}

// Google wants a human (CAPTCHA, code, approve on phone). Bring the tab forward and wait.
async function waitForHuman(tabId, item, message, log) {
  log(`Google asks: ${message}. Waiting for you in Chrome…`);
  await setStatus({ needsYou: `${item.tenant}: ${message}` });
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true }).catch(() => {});
  chrome.notifications?.create(`dkim-${Date.now()}`, {
    type: 'basic', iconUrl: 'icon.png', priority: 2, requireInteraction: true,
    title: 'DKIM Automator needs you', message: `Finish Google sign-in for ${item.tenant}: ${message}. Do it in the pinned tab and don't close it.`,
  });
  const { base } = await adminBase();
  const end = Date.now() + 4 * 60 * 1000;
  while (Date.now() < end) {
    await sleep(3000);
    const t = await chrome.tabs.get(tabId);
    if (t.url.startsWith(new URL(base).origin + '/') && !isSignInUrl(t.url)) break;
    const st = await page(tabId, 'signin', ['', '', true]).catch(() => null); // inspect only
    if (st && st.action !== 'challenge') break;
  }
  await setStatus({ needsYou: null });
  const t = await chrome.tabs.get(tabId);
  const st = await page(tabId, 'signin', ['', '', true]).catch(() => null);
  if (st && st.action === 'challenge' && isSignInUrl(t.url))
    throw new StepError(`Google asked for a check (${message}) and it wasn't completed in time. Complete it in Chrome, then press Retry`, 'auth');
  log('Check completed, continuing');
}

async function signOutAll(tabId, log) {
  await navigate(tabId, 'https://accounts.google.com/Logout');
  await navigate(tabId, 'about:blank');
  log('Signed out of Google');
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
  for (let attempt = 0; ; attempt++) {
    const out = await runItemOnce(item, log, logs);
    // the pinned work tab was closed mid-step: reopen it and start the step again (once)
    if (!out.ok && /No tab with id|tab was closed|Frame with ID|No frame/i.test(out.error || '') && attempt === 0) {
      log('The DKIM tab was closed — reopening it and starting again (please leave the pinned tab open)');
      await chrome.storage.local.remove('tabId');
      logs.length = 0;
      continue;
    }
    return out;
  }
}

async function runItemOnce(item, log, logs) {
  const tab = await workTab();
  try {
    await openForTenant(tab.id, item, log);
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
        await openForTenant(tab.id, item, () => {});
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
      const { signOut } = await chrome.storage.local.get('signOut');
      if (signOut && item.signOutAfter) {
        const tab = await workTab();
        await signOutAll(tab.id, m => addLog(`${item.tenant}: ${m}`)).catch(() => {});
      }
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
async function dkimPage(op, a1, a2, a3) {
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

  if (op === 'signin') {
    const [email, pw, inspectOnly] = [a1, a2, a3];
    const t = text();
    const q = sel => [...document.querySelectorAll(sel)].filter(vis);
    const set = (el, v) => {
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const next = () => {
      // prefer the real <button> inside Google's #identifierNext / #passwordNext wrappers
      const b = [...document.querySelectorAll('#identifierNext button, #passwordNext button')].find(vis)
        || [...document.querySelectorAll('#identifierNext, #passwordNext')].find(vis)
        || findText(['Next', 'Continue', 'Sign in']);
      if (b) realClick(b);
      else { const f = document.activeElement && document.activeElement.form; f && (f.requestSubmit ? f.requestSubmit() : f.submit()); }
    };
    if (/wrong password|password was changed/i.test(t)) return { action: 'error', message: `Wrong password for ${email || 'this account'}` };
    if (/couldn.t find your google account/i.test(t)) return { action: 'error', message: `Google account not found: ${email}` };
    if (/couldn.t sign you in|this browser or app may not be secure/i.test(t)) return { action: 'error', message: 'Google refused this sign-in ("Couldn\'t sign you in"). Sign in manually once in this Chrome, then press Retry' };
    if (q('img#captchaimg, img[src*="Captcha"], img[alt*="CAPTCHA" i]').length || /type the text you hear or see/i.test(t))
      return { action: 'challenge', message: 'type the CAPTCHA characters' };
    if (q('input[type="tel"], input[name="totpPin"], input[name="Pin"], input[autocomplete="one-time-code"], input#idvPin').length)
      return { action: 'challenge', message: 'enter the verification code' };
    if (/choose how you want to sign in|choose a way to verify|try another way/i.test(t) && !q('input[type="password"]').length)
      return { action: 'challenge', message: 'choose a verification method' };
    const pwEl = q('input[type="password"], input[name="Passwd"]')[0];
    if (!pwEl && /verify it.s you|confirm it.s you|check your phone|tap yes/i.test(t))
      return { action: 'challenge', message: 'confirm it\'s you (e.g. tap Yes on your phone)' };
    if (inspectOnly) return { action: 'ok' };
    if (pwEl) {
      if (!pw) return { action: 'error', message: 'Google asks for the password but the job has none for this account' };
      set(pwEl, pw); await sleep(300); next(); return { action: 'password' };
    }
    const em = q('input[type="email"], #identifierId')[0];
    if (em) { if (em.value.toLowerCase() !== String(email).toLowerCase()) set(em, email); await sleep(300); next(); return { action: 'email' }; }
    const acc = [...document.querySelectorAll('[data-identifier], [data-email]')]
      .find(e => (e.getAttribute('data-identifier') || e.getAttribute('data-email') || '').toLowerCase() === String(email).toLowerCase());
    if (acc) { realClick(acc); return { action: 'account chooser' }; }
    const inter = findText(['I understand', 'Accept', 'I agree', 'Not now', 'Skip', 'Done', 'Confirm', 'Continue', 'Use another account']);
    if (inter) { const c = inter.textContent.trim(); realClick(inter); return { action: 'clicked', clicked: c }; }
    return { action: 'none', debug: debug() };
  }

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

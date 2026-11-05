// Google Admin console automation for DKIM (Apps → Google Workspace → Gmail → Authenticate email).
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { CHROME_PATH, HEADLESS, DATA_DIR, BROWSER_IDLE_CLOSE_MS } = require('./config');
const { encrypt, decrypt, hash } = require('./secure');

const DKIM_URL = process.env.GOOGLE_DKIM_URL || 'https://admin.google.com/ac/apps/gmail/authenticateemail'; // override only for tests
const SESS_DIR = path.join(DATA_DIR, 'sessions');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');
fs.mkdirSync(SESS_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });

const delay = ms => new Promise(r => setTimeout(r, ms));

// Errors that should not be retried automatically
class AuthChallengeError extends Error { constructor(m) { super(m); this.kind = 'auth'; } }
// Google asked us to wait (new tenant 24-72h rule) — retry much later
class GoogleWaitError extends Error { constructor(m) { super(m); this.kind = 'wait'; } }

// ── Shared browser, one isolated context per tenant ─────────────────────────
let browser = null;
let browserUsers = 0;
let idleTimer = null;
const contexts = new Map(); // tenantKey -> { context, page, loggedIn, challenge }
const CHALLENGE_TTL_MS = 15 * 60 * 1000; // keep a paused sign-in open this long for the admin to answer

async function getBrowser() {
  clearTimeout(idleTimer);
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: HEADLESS,
    defaultViewport: { width: 1366, height: 900 },
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--no-zygote', '--disable-extensions', '--disable-blink-features=AutomationControlled',
      '--lang=en-US',
    ],
  });
  browser.on('disconnected', () => { browser = null; contexts.clear(); });
  return browser;
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (browserUsers > 0 || !browser) return;
    if ([...contexts.values()].some(c => c.challenge && Date.now() - c.challenge.at < CHALLENGE_TTL_MS)) return scheduleIdleClose();
    for (const [k, c] of contexts) { await saveCookies(k, c.page).catch(() => {}); }
    await browser.close().catch(() => {});
    browser = null; contexts.clear();
  }, BROWSER_IDLE_CLOSE_MS);
}

const sessFile = key => path.join(SESS_DIR, `${key}.json`);
async function saveCookies(key, page) {
  const cookies = await page.cookies('https://admin.google.com', 'https://accounts.google.com', 'https://www.google.com');
  fs.writeFileSync(sessFile(key), encrypt(JSON.stringify(cookies)));
}
async function loadCookies(key, page) {
  try {
    const raw = decrypt(fs.readFileSync(sessFile(key), 'utf8'));
    if (raw) await page.setCookie(...JSON.parse(raw));
  } catch {}
}
function resetChallenge(email) {
  const c = contexts.get(hash(email));
  if (c) c.challenge = null;
}

function clearSession(email) {
  const key = hash(email);
  try { fs.unlinkSync(sessFile(key)); } catch {}
  const c = contexts.get(key);
  if (c) { c.loggedIn = false; c.context.close().catch(() => {}); contexts.delete(key); }
}

async function getTenantPage(email) {
  const key = hash(email);
  const b = await getBrowser();
  let c = contexts.get(key);
  if (c && !c.page.isClosed()) return { key, ...c, entry: c };
  const context = await b.createBrowserContext();
  const page = await context.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  // Images must load: Google's sign-in challenges (CAPTCHA) are images.
  await page.setRequestInterception(true);
  page.on('request', r => (['media'].includes(r.resourceType()) ? r.abort() : r.continue()));
  await loadCookies(key, page);
  c = { context, page, loggedIn: false, challenge: null, key };
  contexts.set(key, c);
  return { key, ...c, entry: c };
}

// ── DOM helpers ─────────────────────────────────────────────────────────────
async function clickByText(page, texts, timeout = 8000) {
  texts = [].concat(texts).map(t => t.toLowerCase());
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const ok = await page.evaluate(texts => {
      const els = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], span, div'))
        .filter(e => e.offsetParent !== null);
      for (const t of texts) {
        const exact = els.find(e => e.textContent.trim().toLowerCase() === t);
        if (exact) { (exact.closest('button,[role="button"],a') || exact).click(); return true; }
      }
      return false;
    }, texts);
    if (ok) { await delay(800); return true; }
    await delay(400);
  }
  return false;
}

async function typeInto(page, selectors, value, timeout = 6000) {
  for (const sel of [].concat(selectors)) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout });
      await page.click(sel, { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type(sel, value, { delay: 40 });
      return true;
    } catch {}
  }
  return false;
}

const bodyText = page => page.evaluate(() => document.body ? document.body.innerText : '');

// Submit the current sign-in step: Enter, and if the page did not move, click Next.
async function submitStep(page) {
  const before = page.url() + '|' + (await bodyText(page)).length;
  const nav = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 6000 }).catch(() => null);
  await page.keyboard.press('Enter');
  const moved = await nav;
  if (moved) return;
  await delay(800);
  const after = page.url() + '|' + (await bodyText(page)).length;
  if (after !== before) return;
  const nav2 = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }).catch(() => null);
  if (await clickByText(page, ['Next', 'Continue', 'Verify', 'Submit', 'Done'], 2000)) await nav2;
}

async function screenshot(page, label) {
  try {
    const name = `${Date.now()}-${label.replace(/[^a-z0-9.-]/gi, '_')}.png`;
    await page.screenshot({ path: path.join(DEBUG_DIR, name), fullPage: true });
    // keep the last 40 screenshots
    const files = fs.readdirSync(DEBUG_DIR).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 40))) fs.unlinkSync(path.join(DEBUG_DIR, f));
    return name;
  } catch { return null; }
}

// ── Login ───────────────────────────────────────────────────────────────────
// Sign-in is a resumable loop. When Google shows something only a human should answer
// (CAPTCHA, verification code, account-recovery choice) the page is kept open and an
// AuthChallengeError with `challenge` is thrown. The admin sees a live screenshot in the
// dashboard and answers via answerChallenge(); the loop then continues from that page.
function onAdmin(url) {
  return url.includes('admin.google.com') && !url.includes('accounts.google.com');
}

async function inspectSignIn(page) {
  return page.evaluate(() => {
    const vis = el => el && el.offsetParent !== null;
    const text = document.body ? document.body.innerText : '';
    const q = s => Array.from(document.querySelectorAll(s)).filter(vis);
    const email = q('input[type="email"], #identifierId')[0];
    const password = q('input[type="password"], input[name="Passwd"]')[0];
    const captcha = q('img#captchaimg, img[src*="Captcha"], img[alt*="CAPTCHA" i]').length > 0 ||
                    /type the text you hear or see/i.test(text);
    const codeInput = q('input[type="tel"], input[name="totpPin"], input[name="Pin"], input[autocomplete="one-time-code"], input#idvPin')[0];
    const lower = text.toLowerCase();
    return {
      url: location.href,
      hasEmail: !!email, emailValue: email ? email.value : '',
      hasPassword: !!password,
      captcha,
      code: !!codeInput,
      choice: /choose how you want to sign in|try another way|choose a way to verify/i.test(text) && !codeInput && !password,
      wrongPassword: /wrong password/i.test(text),
      noAccount: /couldn.t find your google account/i.test(text),
      blocked: /couldn.t sign you in|this browser or app may not be secure/i.test(text),
      verify: /verify it.s you|2-step verification|confirm it.s you/i.test(lower),
      prompt: (text.match(/[^\n]*(google sent|enter the code|check your phone|tap yes|open the gmail app)[^\n]*/i) || [null])[0],
    };
  });
}

async function challengeShot(page) {
  return page.screenshot({ type: 'png' }).catch(() => null);
}

async function pause(entry, page, type, message) {
  entry.challenge = { type, message, at: Date.now() };
  const shot = await screenshot(page, `challenge-${type}`);
  const e = new AuthChallengeError(message + (shot ? ` [debug: ${shot}]` : ''));
  e.challenge = { type, message };
  throw e;
}

async function dismissInterstitials(page) {
  // New accounts: "Welcome to your new account" / ToS speedbump, recovery-info prompts
  return clickByText(page, ['I understand', 'Accept', 'Not now', 'Skip', 'Confirm', 'Done', 'Continue'], 1500);
}

async function advanceSignIn(entry, page, email, password, log) {
  let typedPassword = false;
  for (let step = 0; step < 12; step++) {
    await delay(1200);
    if (onAdmin(page.url())) {
      entry.loggedIn = true; entry.challenge = null;
      await saveCookies(entry.key, page);
      log('Signed in to Google Admin');
      return page;
    }
    const st = await inspectSignIn(page);

    if (st.noAccount) throw new AuthChallengeError('Google account not found');
    if (st.wrongPassword) throw new AuthChallengeError('Wrong Google Admin password — retry with the correct one');
    if (st.blocked) await pause(entry, page, 'blocked', 'Google refused this sign-in from the server ("Couldn\'t sign you in"). Try again later or sign in once from a trusted device first');
    if (st.captcha) await pause(entry, page, 'captcha', 'Google is showing a CAPTCHA — type the characters shown');
    if (st.code) await pause(entry, page, 'code', st.prompt || 'Google is asking for a verification code — enter it');
    if (st.choice) await pause(entry, page, 'choice', 'Google wants you to choose a verification method — type the option text exactly as shown (e.g. "Get a verification code")');

    if (st.hasPassword) {
      if (typedPassword) { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => {}); continue; }
      await typeInto(page, ['input[type="password"]', 'input[name="Passwd"]'], password, 4000);
      typedPassword = true;
      await submitStep(page);
      continue;
    }
    if (st.hasEmail) {
      if (st.emailValue.toLowerCase() !== email.toLowerCase())
        await typeInto(page, ['input[type="email"]', '#identifierId'], email, 4000);
      await submitStep(page);
      continue;
    }
    if (st.verify) await pause(entry, page, 'verify', st.prompt || 'Google needs you to confirm this sign-in (e.g. tap Yes on your phone). Do it, then press Continue');
    // account chooser / interstitials
    if (await clickByText(page, [email, 'Use another account'], 1500)) continue;
    if (await dismissInterstitials(page)) continue;
    // nothing recognised: try going to the admin console directly
    await page.goto(DKIM_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  }
  await pause(entry, page, 'unknown', 'Sign-in stopped on an unexpected page — look at the screenshot, type what is needed (or leave empty) and press Continue');
}

async function ensureLoggedIn(email, password, log) {
  const t = await getTenantPage(email);
  const { page, entry } = t;
  entry.key = t.key;
  if (entry.loggedIn) return page;
  if (entry.challenge) {
    throw Object.assign(new AuthChallengeError(`Waiting for admin: ${entry.challenge.message}`), { challenge: entry.challenge });
  }
  await page.goto(DKIM_URL, { waitUntil: 'networkidle2', timeout: 45000 });
  if (onAdmin(page.url())) { entry.loggedIn = true; log('Reused saved Google session'); return page; }
  log('Signing in to Google Admin');
  return advanceSignIn(entry, page, email, password, log);
}

// Live screenshot of a paused sign-in (PNG buffer) or null.
async function challengeImage(email) {
  const c = contexts.get(hash(email));
  if (!c || !c.challenge || c.page.isClosed()) return null;
  return challengeShot(c.page);
}

function challengeState(email) {
  const c = contexts.get(hash(email));
  if (!c || !c.challenge) return null;
  if (Date.now() - c.challenge.at > CHALLENGE_TTL_MS) { c.challenge = null; return null; }
  return c.challenge;
}

// Apply the admin's answer to the paused page and continue signing in.
// Resolves { loggedIn: true } or throws AuthChallengeError with the next challenge.
async function answerChallenge(creds, answer, log) {
  const c = contexts.get(hash(creds.email));
  if (!c || !c.challenge || c.page.isClosed()) throw new Error('No sign-in is waiting for an answer (it may have expired). Press Retry to start again.');
  const { page } = c;
  const type = c.challenge.type;
  answer = String(answer || '').trim();
  browserUsers++;
  try {
    if (answer) {
      if (type === 'choice' || type === 'unknown') {
        if (!(await clickByText(page, [answer], 3000))) {
          // maybe it's text for an input
          await page.keyboard.type(answer, { delay: 50 });
          await submitStep(page);
        }
      } else {
        const sel = type === 'captcha'
          ? ['input[name="ca"]', 'input[aria-label*="text you hear" i]', 'input#ca']
          : ['input[type="tel"]', 'input[name="totpPin"]', 'input[name="Pin"]', 'input[autocomplete="one-time-code"]', 'input#idvPin'];
        let ok = await typeInto(page, sel, answer, 2000);
        if (!ok) { // fallback: the focused / last visible text input
          ok = await page.evaluate(() => {
            const i = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent && !['hidden', 'email', 'checkbox', 'radio'].includes(i.type)).pop();
            if (i) { i.focus(); return true; } return false;
          });
          if (ok) await page.keyboard.type(answer, { delay: 50 });
        }
        if (!ok) throw new Error('Could not find the input box on the Google page');
        await submitStep(page);
      }
    } else {
      // e.g. admin approved on phone: nothing to type, just wait for Google to move on
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
    }
    c.challenge = null;
    await advanceSignIn(c, page, creds.email, creds.password, log);
    return { loggedIn: true };
  } finally {
    browserUsers--;
    scheduleIdleClose();
  }
}

// ── Authenticate email page ─────────────────────────────────────────────────
async function openDkimPage(page) {
  await page.goto(DKIM_URL, { waitUntil: 'networkidle2', timeout: 45000 });
  if (!onAdmin(page.url())) throw Object.assign(new Error('Session expired'), { kind: 'session' });
  // wait for the panel to render
  for (let i = 0; i < 20; i++) {
    const t = await bodyText(page);
    if (/dkim|authenticate email|selected domain/i.test(t)) break;
    await delay(500);
  }
  await delay(1000);
}

async function currentDomainShown(page, domain) {
  return page.evaluate(d => {
    const cands = Array.from(document.querySelectorAll('[role="listbox"], [role="combobox"], [aria-haspopup="listbox"], select'));
    for (const c of cands) {
      const v = (c.tagName === 'SELECT' ? c.options[c.selectedIndex]?.text : c.textContent) || '';
      if (v.toLowerCase().trim().includes(d)) return true;
    }
    return false;
  }, domain);
}

async function selectDomain(page, domain) {
  const d = domain.toLowerCase();
  if (await currentDomainShown(page, d)) return true;

  // native <select>
  const native = await page.evaluate(d => {
    for (const s of document.querySelectorAll('select')) {
      const o = Array.from(s.options).find(o => o.text.toLowerCase().trim() === d || o.value.toLowerCase() === d);
      if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }
    }
    return false;
  }, d);
  if (native) { await delay(2500); return true; }

  // custom dropdown(s): open each candidate, look for the option
  const count = await page.evaluate(() =>
    document.querySelectorAll('[role="listbox"], [role="combobox"], [aria-haspopup="listbox"]').length);
  for (let i = 0; i < count; i++) {
    await page.evaluate(i => {
      const el = document.querySelectorAll('[role="listbox"], [role="combobox"], [aria-haspopup="listbox"]')[i];
      el && el.click();
    }, i);
    await delay(900);
    const picked = await page.evaluate(d => {
      const opts = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li'))
        .filter(e => e.offsetParent !== null);
      const o = opts.find(e => e.textContent.toLowerCase().trim() === d) ||
                opts.find(e => e.textContent.toLowerCase().trim().split(/\s+/).includes(d));
      if (o) { o.click(); return true; }
      return false;
    }, d);
    if (picked) { await delay(2500); return true; }
    await page.keyboard.press('Escape');
    await delay(300);
  }

  // single-domain tenants may show plain text
  return (await bodyText(page)).toLowerCase().includes(d);
}

async function readPanel(page) {
  return page.evaluate(() => {
    const text = document.body.innerText;
    let txt = null;
    for (const el of document.querySelectorAll('textarea, input')) {
      if ((el.value || '').includes('v=DKIM1')) { txt = el.value.trim(); break; }
    }
    if (!txt) { const m = text.match(/v=DKIM1;[^\n]+/); if (m) txt = m[0].trim(); }
    const host = text.match(/\b([a-z0-9-]+)\._domainkey\b/i);
    const l = text.toLowerCase();
    let status = 'unknown';
    if (l.includes('authenticating email with dkim')) status = 'authenticating';
    else if (l.includes('not authenticating')) status = 'not_authenticating';
    const wait = /(24|48)\s*(to|-|–)\s*72 hours|wait.{0,40}before.{0,40}(generat|dkim)|try again later/i.test(text);
    return { txtValue: txt, selector: host ? host[1] : null, status, wait, snippet: text.slice(0, 400) };
  });
}

async function generateRecord(page, selector, keyLength) {
  if (!(await clickByText(page, ['Generate new record', 'Generate New Record'], 8000)))
    throw new Error('"Generate new record" button not found');
  await delay(1500);

  await page.evaluate(bits => {
    const root = document.querySelector('[role="dialog"]') || document;
    for (const r of root.querySelectorAll('input[type="radio"], [role="radio"]')) {
      const lbl = ((r.closest('label') || r.parentElement || {}).textContent || '') + ' ' + (r.value || r.getAttribute('aria-label') || '');
      if (lbl.includes(String(bits))) { r.click(); return; }
    }
    for (const s of root.querySelectorAll('select')) {
      const o = Array.from(s.options).find(o => o.text.includes(String(bits)));
      if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return; }
    }
  }, keyLength);
  await delay(300);

  const hasInput = await page.evaluate(() => {
    const root = document.querySelector('[role="dialog"]') || document;
    const i = Array.from(root.querySelectorAll('input[type="text"], input:not([type])')).find(i => i.offsetParent !== null);
    if (i) { i.focus(); i.select && i.select(); return true; }
    return false;
  });
  if (hasInput) {
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(selector, { delay: 40 });
  }

  const confirmed = await page.evaluate(() => {
    const root = document.querySelector('[role="dialog"]') || document;
    const b = Array.from(root.querySelectorAll('button, [role="button"]'))
      .find(b => b.offsetParent !== null && b.textContent.trim().toLowerCase() === 'generate');
    if (b) { b.click(); return true; }
    return false;
  });
  if (!confirmed) throw new Error('"Generate" confirm button not found in dialog');

  for (let i = 0; i < 20; i++) {
    await delay(1000);
    const p = await readPanel(page);
    if (p.txtValue || p.wait) return p;
  }
  return readPanel(page);
}

// ── Public operations (each takes a log fn) ─────────────────────────────────
async function withTenant(creds, label, fn, log) {
  browserUsers++;
  let page;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      page = await ensureLoggedIn(creds.email, creds.password, log);
      try { return await fn(page); }
      catch (e) {
        if (e.kind === 'session' && attempt === 0) { clearSession(creds.email); log('Session expired, signing in again'); continue; }
        throw e;
      }
    }
  } catch (e) {
    if (page && !e.kind) {
      const shot = await screenshot(page, label);
      if (shot) e.message += ` [debug: ${shot}]`;
    }
    throw e;
  } finally {
    browserUsers--;
    scheduleIdleClose();
  }
}

// Generate (or read existing) DKIM record for a domain.
async function generate(creds, domain, { selector, keyLength, regenerate }, log) {
  return withTenant(creds, `gen-${domain}`, async page => {
    await openDkimPage(page);
    if (!(await selectDomain(page, domain))) throw Object.assign(new Error(`Domain ${domain} is not in this Google Workspace tenant`), { kind: 'fatal' });
    let p = await readPanel(page);
    log(`Google status: ${p.status}${p.txtValue ? ', existing record found' : ''}`);
    if (p.status === 'authenticating' && !regenerate) return { ...p, preserved: true };
    if (!p.txtValue || regenerate) {
      log(`Generating ${keyLength}-bit key, selector "${selector}"`);
      p = await generateRecord(page, selector, keyLength);
    }
    if (!p.txtValue && p.wait) throw new GoogleWaitError('Google says this tenant must wait (24-72h after Gmail setup) before DKIM can be generated');
    if (!p.txtValue) throw new Error('Could not read the DKIM TXT value from the page');
    return p;
  }, log);
}

// Click "Start authentication". Returns final panel state.
async function startAuthentication(creds, domain, log) {
  return withTenant(creds, `start-${domain}`, async page => {
    await openDkimPage(page);
    if (!(await selectDomain(page, domain))) throw Object.assign(new Error(`Domain ${domain} not found in tenant`), { kind: 'fatal' });
    let p = await readPanel(page);
    if (p.status === 'authenticating') return p;
    if (!(await clickByText(page, ['Start authentication', 'START AUTHENTICATION'], 8000)))
      throw new Error('"Start authentication" button not found');
    for (let i = 0; i < 15; i++) {
      await delay(1000);
      p = await readPanel(page);
      if (p.status === 'authenticating') return p;
    }
    const txt = await bodyText(page);
    const m = txt.match(/[^\n]*(dns record|could not|couldn.t|unable|doesn.t match|not found)[^\n]*/i);
    const err = new Error(`Google did not start authentication${m ? `: ${m[0].trim()}` : ''}`);
    err.kind = 'activation';
    throw err;
  }, log);
}

async function verifyLogin(creds, log) {
  return withTenant(creds, 'login', async () => true, log);
}

// ── Simulation (no Google calls) for testing the pipeline ──────────────────
const fake = {};
const sim = {
  async generate(creds, domain, { selector }, log) {
    await delay(1500);
    log('[simulate] generated record');
    fake[domain] = fake[domain] || `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA${Buffer.from(domain).toString('base64').replace(/=/g, '')}SIMULATED`;
    return { txtValue: fake[domain], selector, status: 'not_authenticating' };
  },
  async startAuthentication(creds, domain, log) { await delay(1500); log('[simulate] authentication started'); return { status: 'authenticating' }; },
  async verifyLogin() { return true; },
};

module.exports = { generate, startAuthentication, verifyLogin, clearSession, resetChallenge, answerChallenge, challengeImage, challengeState, sim, DEBUG_DIR, AuthChallengeError, GoogleWaitError };

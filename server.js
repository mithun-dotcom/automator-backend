const express = require('express');
const puppeteer = require('puppeteer-core');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

let sseClients = [];

function sendStatus(message, type = 'info', progress = null) {
  const data = { message, type, progress, timestamp: new Date().toISOString() };
  console.log(`[${type.toUpperCase()}] ${message}`);
  sseClients.forEach(res => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  });
}

app.get('/status-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

app.get('/', (req, res) => res.json({ status: 'MithMill Automator backend running' }));

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Find system Chromium path on Render (Linux) ───────────────────────────────
function getChromiumPath() {
  const paths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ];
  const fs = require('fs');
  for (const p of paths) {
    try { fs.accessSync(p); return p; } catch (e) {}
  }
  return null;
}

// ── Launch low-memory browser ─────────────────────────────────────────────────
async function launchBrowser() {
  const executablePath = getChromiumPath();
  if (!executablePath) throw new Error('No system Chromium found. Install chromium on the server.');

  console.log('Using Chromium at:', executablePath);

  return await puppeteer.launch({
    executablePath,
    headless: 'new',
    // Small viewport saves memory
    defaultViewport: { width: 1024, height: 768 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--single-process',
      '--no-zygote',
      // Memory saving flags
      '--disable-extensions',
      '--disable-plugins',
      '--disable-images',           // Don't load images — saves memory & bandwidth
      '--disable-javascript-harmony-shipping',
      '--memory-pressure-off',
      '--max_old_space_size=256',   // Limit V8 heap to 256MB
      '--js-flags=--max-old-space-size=256',
    ],
  });
}

// ── Open a new page with resource blocking ────────────────────────────────────
async function newPage(browser) {
  const page = await browser.newPage();

  // Block images, fonts, media to save memory and speed up loading
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Remove webdriver flag
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return page;
}

// ── Wait for form inputs to appear ───────────────────────────────────────────
async function waitForInputs(page, minCount = 2, maxWait = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const count = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input'))
        .filter(i => i.offsetParent !== null && i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio')
        .length
    );
    if (count >= minCount) { console.log(`Form ready: ${count} inputs`); return count; }
    await delay(1000);
  }
  throw new Error(`Form did not render in ${maxWait / 1000}s`);
}

// ── Fill nth visible text input ───────────────────────────────────────────────
async function fillNthInput(page, n, value, label) {
  const found = await page.evaluate((n) => {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(i => i.offsetParent !== null && i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio' && i.type !== 'password');
    const el = inputs[n];
    if (!el) return null;
    el.focus(); el.click();
    return { id: el.id, name: el.name, placeholder: el.placeholder };
  }, n);

  if (!found) { console.log(`✗ ${label} (index ${n}): not found`); return false; }

  await delay(150);
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await delay(80);
  await page.keyboard.type(value, { delay: 70 });
  console.log(`✓ ${label}: "${value}" → ${JSON.stringify(found)}`);
  return true;
}

// ── Select domain dropdown ────────────────────────────────────────────────────
async function selectDomain(page, domain) {
  sendStatus(`Selecting @${domain}...`, 'info');

  // Try native <select> first
  const r1 = await page.evaluate((domain) => {
    const selects = Array.from(document.querySelectorAll('select')).filter(s => s.offsetParent !== null);
    for (const sel of selects) {
      const match = Array.from(sel.options).find(o =>
        o.text.toLowerCase().includes(domain.toLowerCase()) ||
        o.value.toLowerCase().includes(domain.toLowerCase())
      );
      if (match) {
        sel.value = match.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, text: match.text };
      }
    }
    // Log all selects for debugging
    return { ok: false, selects: selects.map(s => Array.from(s.options).map(o => o.text)) };
  }, domain);

  console.log('Domain select result:', JSON.stringify(r1));
  if (r1.ok) { await delay(400); sendStatus(`✓ @${domain} selected`, 'success'); return; }

  // Try page.select() via Puppeteer
  try {
    const handles = await page.$$('select');
    for (const h of handles) {
      const vis = await page.evaluate(el => !!el.offsetParent, h);
      if (!vis) continue;
      const opts = await page.evaluate(el =>
        Array.from(el.options).map(o => ({ v: o.value, t: o.text })), h
      );
      const match = opts.find(o =>
        o.t.toLowerCase().includes(domain.toLowerCase()) ||
        o.v.toLowerCase().includes(domain.toLowerCase())
      );
      if (match) {
        await page.select('select', match.v);
        await delay(400);
        sendStatus(`✓ @${domain} selected via page.select()`, 'success');
        return;
      }
    }
  } catch (e) { console.log('page.select error:', e.message); }

  // Try clicking a custom dropdown element showing the domain
  const r3 = await page.evaluate((domain) => {
    const re = /^@?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const el = Array.from(document.querySelectorAll('*')).find(e =>
      e.offsetParent !== null && e.children.length <= 2 && re.test(e.textContent.trim())
    );
    if (el) { el.click(); return { clicked: true, text: el.textContent.trim() }; }
    return { clicked: false };
  }, domain);

  if (r3.clicked) {
    await delay(800);
    const picked = await page.evaluate((domain) => {
      const opts = Array.from(document.querySelectorAll('li,[role="option"],[role="menuitem"]'))
        .filter(el => el.offsetParent !== null && el.textContent.toLowerCase().includes(domain.toLowerCase()));
      if (opts.length > 0) { opts[0].click(); return opts[0].textContent.trim(); }
      return null;
    }, domain);
    if (picked) { await delay(400); sendStatus(`✓ @${domain} selected`, 'success'); return; }
  }

  sendStatus(`⚠ Could not select @${domain}`, 'warn');
}

// ── Click Create password radio and fill password ─────────────────────────────
async function fillPassword(page, password) {
  // Click "Create password" radio (second radio button)
  const radioResult = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
      .filter(r => r.offsetParent !== null);
    for (const r of radios) {
      const txt = ((r.closest('label') || r.parentElement || {}).textContent || '').toLowerCase();
      if (txt.includes('create')) { r.click(); return `clicked: ${txt.substring(0, 30)}`; }
    }
    if (radios.length >= 2) { radios[1].click(); return 'clicked 2nd radio (fallback)'; }
    return `no radio (${radios.length} found)`;
  });
  console.log('Radio:', radioResult);
  await delay(1200);

  // Fill password field
  try {
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 5000 });
    await page.click('input[type="password"]', { clickCount: 3 });
    await delay(100);
    await page.type('input[type="password"]', password, { delay: 70 });
    console.log('✓ Password filled');
  } catch (e) {
    console.log('Password field not found after radio click:', e.message);
  }

  // Uncheck "Ask user to change password"
  await page.evaluate(() => {
    const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .filter(c => c.offsetParent !== null);
    for (const cb of cbs) {
      const txt = ((cb.closest('label') || cb.parentElement || {}).textContent || '').toLowerCase();
      if ((txt.includes('change') || txt.includes('reset')) && cb.checked) {
        cb.click();
        console.log('Unchecked change-password checkbox');
      }
    }
  });
}

// ── Submit form ───────────────────────────────────────────────────────────────
async function submitForm(page) {
  const result = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(b => b.offsetParent !== null);
    console.log('Buttons:', btns.map(b => b.textContent.trim().substring(0, 30)));
    for (const b of btns) {
      const t = b.textContent.trim().toUpperCase();
      if (t.includes('ADD') || t.includes('SAVE') || t.includes('CREATE')) {
        if (!t.includes('CANCEL')) { b.click(); return `clicked: ${t}`; }
      }
    }
    // Last non-cancel button
    const nc = btns.filter(b => !b.textContent.trim().toUpperCase().includes('CANCEL'));
    if (nc.length > 0) { nc[nc.length - 1].click(); return `last button: ${nc[nc.length - 1].textContent.trim()}`; }
    return 'no button found';
  });
  console.log('Submit:', result);
}

// ── Google Admin login ────────────────────────────────────────────────────────
async function loginGoogleAdmin(page, email, password) {
  sendStatus('Logging in to Google Admin...', 'info');
  await page.goto('https://admin.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  for (const sel of ['input[type="email"]', '#identifierId']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 5000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, email, { delay: 80 });
      await page.keyboard.press('Enter');
      await delay(3000); break;
    } catch (e) {}
  }
  for (const sel of ['input[type="password"]', 'input[name="Passwd"]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 6000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, password, { delay: 80 });
      await page.keyboard.press('Enter');
      await delay(4000); break;
    } catch (e) {}
  }
  try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }); } catch (e) {}

  const url = page.url();
  if (url.includes('admin.google.com') && !url.includes('signin')) {
    sendStatus('✓ Logged in to Google Admin', 'success'); return;
  }
  const txt = await page.evaluate(() => document.body.innerText);
  if (txt.includes('2-Step') || txt.includes('verification'))
    throw new Error('2FA detected — disable it first.');
  throw new Error('Google Admin login failed.');
}

// ── Create one user ───────────────────────────────────────────────────────────
async function createGoogleUser(page, user) {
  await page.goto('https://admin.google.com/ac/users/new', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  // Scroll to trigger lazy render
  await page.evaluate(() => { window.scrollTo(0, 300); });
  await delay(500);
  await page.evaluate(() => { window.scrollTo(0, 0); });

  // Wait for form
  await waitForInputs(page, 2, 20000);

  // Debug dump
  const dump = await page.evaluate(() => ({
    inputs: Array.from(document.querySelectorAll('input'))
      .filter(i => i.offsetParent !== null)
      .map(i => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, ariaLabel: i.getAttribute('aria-label') })),
    selects: Array.from(document.querySelectorAll('select'))
      .map(s => ({ id: s.id, visible: !!s.offsetParent, opts: Array.from(s.options).map(o => o.text) })),
    buttons: Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(b => b.offsetParent !== null)
      .map(b => b.textContent.trim().substring(0, 30)),
  }));
  console.log('DUMP:', JSON.stringify(dump));

  // Fill fields by index
  await fillNthInput(page, 0, user.firstName, 'firstName');  await delay(350);
  await fillNthInput(page, 1, user.lastName, 'lastName');    await delay(350);
  await fillNthInput(page, 2, user.username, 'username');    await delay(600);

  // Domain
  await selectDomain(page, user.domain);
  await delay(600);

  // Scroll to password section
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(800);

  // Password
  await fillPassword(page, user.password);
  await delay(400);

  // Submit
  await submitForm(page);
  await delay(3500);

  console.log('After submit:', page.url());
}

// ── Smartlead login ───────────────────────────────────────────────────────────
async function loginSmartlead(page, email, password) {
  sendStatus('Logging in to Smartlead...', 'info');
  await page.goto('https://app.smartlead.ai/login', { waitUntil: 'networkidle2', timeout: 25000 });
  await delay(3000);

  const url = page.url();
  if (url.includes('app.smartlead.ai') && !url.includes('login')) {
    sendStatus('✓ Already logged in', 'success'); return;
  }

  for (const sel of ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="mail" i]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 4000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, email, { delay: 80 }); break;
    } catch (e) {}
  }
  await delay(300);
  for (const sel of ['input[type="password"]', 'input[name="password"]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 4000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, password, { delay: 80 }); break;
    } catch (e) {}
  }
  await delay(300);

  let submitted = false;
  for (const txt of ['Log in', 'Login', 'Sign in', 'Sign In']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')]`);
      if (btns.length > 0) { await btns[0].click(); submitted = true; break; }
    } catch (e) {}
  }
  if (!submitted) {
    try { const b = await page.$('button[type="submit"]'); if (b) { await b.click(); submitted = true; } } catch (e) {}
  }
  if (!submitted) await page.keyboard.press('Enter');

  await delay(5000);
  try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }); } catch (e) {}

  const finalUrl = page.url();
  console.log('Smartlead final URL:', finalUrl);
  if (finalUrl.includes('app.smartlead.ai') && !finalUrl.includes('login')) {
    sendStatus('✓ Logged in to Smartlead', 'success'); return;
  }
  throw new Error(`Smartlead login failed. URL: ${finalUrl}`);
}

// ── Connect one account to Smartlead ─────────────────────────────────────────
async function connectAccountToSmartlead(browser, page, email, password) {
  await page.goto('https://app.smartlead.ai/app/email-accounts', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  for (const txt of ['Add Account', 'Connect Account', 'Add Email Account', '+ Add', 'Add Mailbox']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')] | //a[contains(., '${txt}')]`);
      if (btns.length > 0) { await btns[0].click(); await delay(1500); break; }
    } catch (e) {}
  }
  await delay(800);
  for (const txt of ['Google', 'Gmail', 'Connect with Google', 'Google Workspace']) {
    try {
      const els = await page.$x(`//button[contains(., '${txt}')] | //div[@role='button'][contains(., '${txt}')] | //a[contains(., '${txt}')]`);
      if (els.length > 0) { await els[0].click(); await delay(2000); break; }
    } catch (e) {}
  }

  const popup = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OAuth popup did not open')), 15000);
    browser.once('targetcreated', async target => { clearTimeout(timer); resolve(await target.page()); });
  });

  await popup.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await delay(2000);

  for (const sel of ['input[type="email"]', '#identifierId']) {
    try {
      await popup.waitForSelector(sel, { visible: true, timeout: 5000 });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, email, { delay: 80 });
      await popup.keyboard.press('Enter');
      await delay(2500); break;
    } catch (e) {}
  }
  for (const sel of ['input[type="password"]', 'input[name="Passwd"]']) {
    try {
      await popup.waitForSelector(sel, { visible: true, timeout: 6000 });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, password, { delay: 80 });
      await popup.keyboard.press('Enter');
      await delay(3000); break;
    } catch (e) {}
  }
  try {
    const allow = await popup.$x('//button[contains(., "Allow")] | //button[contains(., "Continue")]');
    if (allow.length > 0) { await allow[0].click(); await delay(2000); }
  } catch (e) {}
  try { await popup.close(); } catch (e) {}
}

// ── /run ─────────────────────────────────────────────────────────────────────
app.post('/run', async (req, res) => {
  const { users, googleEmail, googlePassword, smartleadEmail, smartleadPassword } = req.body;
  if (!users?.length)     return res.status(400).json({ error: 'No users provided' });
  if (!googleEmail)       return res.status(400).json({ error: 'Google Admin email required' });
  if (!googlePassword)    return res.status(400).json({ error: 'Google Admin password required' });
  if (!smartleadEmail)    return res.status(400).json({ error: 'Smartlead email required' });
  if (!smartleadPassword) return res.status(400).json({ error: 'Smartlead password required' });
  const missing = users.find(u => !u.domain?.trim());
  if (missing) return res.status(400).json({ error: `User "${missing.username}" has no domain.` });

  res.json({ ok: true, total: users.length });

  (async () => {
    let browser;
    try {
      sendStatus('Launching browser...', 'info', 0);
      browser = await launchBrowser();

      // ── Phase 1: Create users ──────────────────────────────────────────────
      sendStatus('Phase 1: Creating users in Google Admin...', 'info', 2);
      {
        const page = await newPage(browser);
        await loginGoogleAdmin(page, googleEmail, googlePassword);

        for (let i = 0; i < users.length; i++) {
          const user = users[i];
          const fullEmail = `${user.username}@${user.domain}`;
          const pct = Math.round(2 + (i / users.length) * 48);
          sendStatus(`[${i + 1}/${users.length}] Creating: ${fullEmail}`, 'info', pct);
          try {
            await createGoogleUser(page, user);
            sendStatus(`✓ Created: ${fullEmail}`, 'success', pct + 1);
          } catch (e) {
            sendStatus(`✗ Failed: ${fullEmail} — ${e.message}`, 'error', pct);
            console.error(e.stack);
          }
          // Force GC between users
          if (global.gc) global.gc();
        }
        await page.close();
      }
      sendStatus('Phase 1 complete.', 'success', 50);

      // ── Phase 2: Connect to Smartlead ──────────────────────────────────────
      sendStatus('Phase 2: Connecting to Smartlead...', 'info', 52);
      {
        const page = await newPage(browser);
        await loginSmartlead(page, smartleadEmail, smartleadPassword);

        for (let i = 0; i < users.length; i++) {
          const user = users[i];
          const fullEmail = `${user.username}@${user.domain}`;
          const pct = 52 + Math.round((i / users.length) * 46);
          sendStatus(`[${i + 1}/${users.length}] Connecting: ${fullEmail}`, 'info', pct);
          try {
            await connectAccountToSmartlead(browser, page, fullEmail, user.password);
            sendStatus(`✓ Connected: ${fullEmail}`, 'success', pct + 1);
          } catch (e) {
            sendStatus(`✗ Failed: ${fullEmail} — ${e.message}`, 'error', pct);
          }
          if (global.gc) global.gc();
        }
        await page.close();
      }

      sendStatus('🎉 All done!', 'success', 100);
    } catch (e) {
      sendStatus(`❌ Fatal error: ${e.message}`, 'error');
      console.error('Fatal:', e.stack);
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (global.gc) global.gc();
    }
  })();
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`\n✅ MithMill Automator backend running on port ${PORT}\n`));

const express = require('express');
const puppeteer = require('puppeteer');
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

// ── Launch browser ────────────────────────────────────────────────────────────
async function launchBrowser() {
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900', '--single-process', '--no-zygote',
  ];
  try {
    const b = await puppeteer.launch({ headless: 'new', args, defaultViewport: { width: 1280, height: 900 } });
    console.log('Launched with bundled Chromium'); return b;
  } catch (e) { console.log('Bundled Chromium failed:', e.message); }
  for (const ep of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    try {
      const b = await puppeteer.launch({ headless: 'new', executablePath: ep, args, defaultViewport: { width: 1280, height: 900 } });
      console.log('Launched with', ep); return b;
    } catch (e) {}
  }
  throw new Error('Could not launch any Chrome/Chromium browser.');
}

// ── Wait for the new user form to fully render ────────────────────────────────
// The form is a React SPA — we must wait for actual input elements to appear
async function waitForForm(page) {
  console.log('Waiting for form to render...');

  // Scroll down to trigger lazy rendering
  await page.evaluate(() => window.scrollTo(0, 500));
  await delay(1000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(1000);

  // Wait until we see at least 2 visible text inputs (First name + Last name)
  let attempts = 0;
  while (attempts < 20) {
    const inputCount = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input'))
        .filter(i => i.offsetParent !== null && i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio')
        .length
    );
    console.log(`Form render attempt ${attempts + 1}: ${inputCount} visible inputs`);
    if (inputCount >= 2) {
      console.log('Form is ready with', inputCount, 'inputs');
      return inputCount;
    }
    await delay(1000);
    attempts++;
  }
  throw new Error('Form did not render after 20 seconds — Google Admin may be blocked or not loading');
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
    throw new Error('Google Admin 2FA detected — disable it first.');
  throw new Error('Google Admin login failed.');
}

// ── Create one user ───────────────────────────────────────────────────────────
async function createGoogleUser(page, user) {
  await page.goto('https://admin.google.com/ac/users/new', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  // Wait for form to fully render
  const inputCount = await waitForForm(page);

  // Full dump after form is ready
  const dump = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, select, textarea'))
      .filter(i => i.offsetParent !== null)
      .map(i => ({
        tag: i.tagName, type: i.type || '', name: i.name || '',
        id: i.id || '', placeholder: i.placeholder || '',
        ariaLabel: i.getAttribute('aria-label') || '',
        value: i.value || '', class: i.className.substring(0, 40)
      }));
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(b => b.offsetParent !== null)
      .map(b => b.textContent.trim().substring(0, 40));
    return { inputs, buttons };
  });
  console.log('FORM DUMP inputs:', JSON.stringify(dump.inputs));
  console.log('FORM DUMP buttons:', JSON.stringify(dump.buttons));

  // Get all visible text inputs in order
  const visibleInputs = dump.inputs.filter(i =>
    i.tag === 'INPUT' && i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio'
  );
  console.log('Visible text inputs count:', visibleInputs.length);

  // ── Fill fields by position (most reliable since we know the form layout) ──
  // Position 0 = First name, 1 = Last name, 2 = Primary email (username)
  await fillNthInput(page, 0, user.firstName, 'First name');
  await delay(400);
  await fillNthInput(page, 1, user.lastName, 'Last name');
  await delay(400);
  await fillNthInput(page, 2, user.username, 'Primary email');
  await delay(800);

  // ── Select domain ──────────────────────────────────────────────────────────
  await selectDomain(page, user.domain);
  await delay(800);

  // ── Scroll down to see password section ───────────────────────────────────
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(1000);

  // ── Re-dump after scroll to see password section ──────────────────────────
  const dump2 = await page.evaluate(() => ({
    inputs: Array.from(document.querySelectorAll('input'))
      .filter(i => i.offsetParent !== null)
      .map(i => ({ type: i.type, name: i.name, id: i.id, ariaLabel: i.getAttribute('aria-label') })),
    buttons: Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(b => b.offsetParent !== null)
      .map(b => b.textContent.trim().substring(0, 40))
  }));
  console.log('AFTER SCROLL inputs:', JSON.stringify(dump2.inputs));
  console.log('AFTER SCROLL buttons:', JSON.stringify(dump2.buttons));

  // ── Click "Create password" radio ─────────────────────────────────────────
  const radioResult = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
      .filter(r => r.offsetParent !== null);
    console.log('Radios:', radios.length, radios.map(r => {
      const p = r.closest('label') || r.parentElement;
      return p ? p.textContent.trim().substring(0, 40) : r.id;
    }));
    for (const r of radios) {
      const p = r.closest('label') || r.parentElement;
      const txt = (p ? p.textContent : '').toLowerCase();
      if (txt.includes('create')) { r.click(); return 'create radio clicked'; }
    }
    if (radios.length >= 2) { radios[1].click(); return 'second radio (fallback)'; }
    return `no radio found (${radios.length} total)`;
  });
  console.log('Radio result:', radioResult);
  await delay(1500);

  // ── Fill password (appears after clicking Create password) ────────────────
  const pwdResult = await page.evaluate((pwd) => {
    const pwdInputs = Array.from(document.querySelectorAll('input[type="password"]'))
      .filter(i => i.offsetParent !== null);
    console.log('Password inputs:', pwdInputs.length);
    if (pwdInputs.length > 0) {
      pwdInputs[0].focus();
      pwdInputs[0].click();
      return { found: true, id: pwdInputs[0].id };
    }
    return { found: false };
  }, user.password);
  console.log('Password input result:', JSON.stringify(pwdResult));

  if (pwdResult.found) {
    await delay(200);
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.type(user.password, { delay: 80 });
    sendStatus(`Password filled`, 'info');
  } else {
    // Try clicking Create password first
    const createPwdBtnResult = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*')).filter(el =>
        el.offsetParent !== null &&
        el.textContent.trim().toLowerCase().includes('create password') &&
        el.children.length <= 3
      );
      if (all.length > 0) { all[0].click(); return all[0].textContent.trim(); }
      return null;
    });
    console.log('Create password button:', createPwdBtnResult);
    if (createPwdBtnResult) {
      await delay(1500);
      try {
        await page.waitForSelector('input[type="password"]', { visible: true, timeout: 5000 });
        await page.click('input[type="password"]', { clickCount: 3 });
        await page.type('input[type="password"]', user.password, { delay: 80 });
      } catch (e) { console.log('Password fill after button click failed:', e.message); }
    }
  }
  await delay(500);

  // ── Uncheck "Ask user to change password" ─────────────────────────────────
  await page.evaluate(() => {
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .filter(c => c.offsetParent !== null);
    for (const cb of checkboxes) {
      const p = cb.closest('label') || cb.parentElement;
      const txt = (p ? p.textContent : '').toLowerCase();
      if (txt.includes('change') || txt.includes('reset')) {
        if (cb.checked) { cb.click(); console.log('Unchecked change-password checkbox'); }
      }
    }
  });
  await delay(400);

  // ── Submit ─────────────────────────────────────────────────────────────────
  const submitResult = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(b => b.offsetParent !== null);
    console.log('Submit buttons:', buttons.map(b => b.textContent.trim().substring(0, 30)));
    for (const b of buttons) {
      const txt = b.textContent.trim().toUpperCase();
      if (txt.includes('ADD') && txt.includes('USER')) { b.click(); return `clicked: ${txt}`; }
      if (txt === 'SAVE' || txt === 'CREATE') { b.click(); return `clicked: ${txt}`; }
    }
    // Last non-cancel button
    const nonCancel = buttons.filter(b => !b.textContent.trim().toUpperCase().includes('CANCEL'));
    if (nonCancel.length > 0) {
      const last = nonCancel[nonCancel.length - 1];
      last.click();
      return `clicked last: ${last.textContent.trim()}`;
    }
    return 'no submit button found';
  });
  console.log('Submit result:', submitResult);
  await delay(4000);
  console.log('After submit URL:', page.url());
}

// ── Fill nth visible text input ───────────────────────────────────────────────
async function fillNthInput(page, n, value, label) {
  const result = await page.evaluate((n, val) => {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(i => i.offsetParent !== null && i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio' && i.type !== 'password');
    const el = inputs[n];
    if (!el) return { ok: false, total: inputs.length };
    el.focus(); el.click();
    return { ok: true, id: el.id, name: el.name, placeholder: el.placeholder, ariaLabel: el.getAttribute('aria-label') };
  }, n, value);

  console.log(`fillNthInput(${n}, "${label}"):`, JSON.stringify(result));

  if (result.ok) {
    await delay(150);
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await delay(100);
    await page.keyboard.press('Backspace');
    await page.keyboard.type(value, { delay: 80 });
    console.log(`✓ ${label} filled`);
    return true;
  }
  console.log(`✗ ${label} not found (total inputs: ${result.total})`);
  return false;
}

// ── Select domain ─────────────────────────────────────────────────────────────
async function selectDomain(page, domain) {
  sendStatus(`Selecting domain @${domain}...`, 'info');

  // Method 1: native <select>
  const r1 = await page.evaluate((domain) => {
    const selects = Array.from(document.querySelectorAll('select'));
    console.log('Selects found:', selects.length, selects.map(s => ({
      id: s.id, visible: !!s.offsetParent,
      options: Array.from(s.options).map(o => o.text)
    })));
    for (const sel of selects) {
      if (!sel.offsetParent) continue;
      const match = Array.from(sel.options).find(o =>
        o.text.toLowerCase().includes(domain.toLowerCase()) ||
        o.value.toLowerCase().includes(domain.toLowerCase())
      );
      if (match) {
        sel.value = match.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: match.text };
      }
    }
    return { ok: false };
  }, domain);
  console.log('Select method 1:', JSON.stringify(r1));
  if (r1.ok) { await delay(500); sendStatus(`✓ Domain @${domain} selected`, 'success'); return; }

  // Method 2: Puppeteer page.select()
  try {
    const selects = await page.$$('select');
    for (const s of selects) {
      const vis = await page.evaluate(el => !!el.offsetParent, s);
      if (!vis) continue;
      const opts = await page.evaluate(el => Array.from(el.options).map(o => ({ v: o.value, t: o.text })), s);
      console.log('page.select() options:', JSON.stringify(opts));
      const match = opts.find(o => o.t.toLowerCase().includes(domain.toLowerCase()) || o.v.toLowerCase().includes(domain.toLowerCase()));
      if (match) {
        await page.select('select', match.v);
        await delay(500);
        sendStatus(`✓ Domain @${domain} selected via page.select()`, 'success');
        return;
      }
    }
  } catch (e) { console.log('page.select() error:', e.message); }

  // Method 3: look for domain text directly on page and click it
  const r3 = await page.evaluate((domain) => {
    // Find the domain shown next to @ — could be a div, span, or custom element
    const allVisible = Array.from(document.querySelectorAll('*')).filter(el =>
      el.offsetParent !== null && el.children.length <= 2
    );
    // Find element showing any domain (contains a dot, no spaces)
    const domainRe = /^@?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const candidates = allVisible.filter(el => domainRe.test(el.textContent.trim()));
    console.log('Domain candidates:', candidates.map(c => ({ tag: c.tagName, text: c.textContent.trim(), role: c.getAttribute('role') })));
    if (candidates.length > 0) {
      candidates[0].click();
      return { clicked: true, text: candidates[0].textContent.trim() };
    }
    return { clicked: false };
  }, domain);
  console.log('Method 3:', JSON.stringify(r3));

  if (r3.clicked) {
    await delay(1000);
    const picked = await page.evaluate((domain) => {
      const opts = Array.from(document.querySelectorAll('li, [role="option"], [role="menuitem"], [role="listitem"]'))
        .filter(el => el.offsetParent !== null);
      console.log('Dropdown items:', opts.map(o => o.textContent.trim()));
      const match = opts.find(o => o.textContent.trim().toLowerCase().includes(domain.toLowerCase()));
      if (match) { match.click(); return match.textContent.trim(); }
      return null;
    }, domain);
    if (picked) {
      await delay(400);
      sendStatus(`✓ Domain @${domain} selected via dropdown`, 'success');
      return;
    }
  }

  sendStatus(`⚠ Domain @${domain} not selected — check Render logs`, 'warn');
}

// ── Smartlead login ───────────────────────────────────────────────────────────
async function loginSmartlead(page, email, password) {
  sendStatus('Logging in to Smartlead...', 'info');
  await page.goto('https://app.smartlead.ai/login', { waitUntil: 'networkidle2', timeout: 25000 });
  await delay(3000);

  const url = page.url();
  if (url.includes('app.smartlead.ai') && !url.includes('login')) {
    sendStatus('✓ Already logged in to Smartlead', 'success'); return;
  }

  for (const sel of ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="mail" i]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 4000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, email, { delay: 80 });
      break;
    } catch (e) {}
  }
  await delay(400);
  for (const sel of ['input[type="password"]', 'input[name="password"]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 4000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, password, { delay: 80 });
      break;
    } catch (e) {}
  }
  await delay(400);

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

  if (finalUrl.includes('app.smartlead.ai') && !finalUrl.includes('login') && !finalUrl.includes('sign-in')) {
    sendStatus('✓ Logged in to Smartlead', 'success'); return;
  }
  throw new Error(`Smartlead login failed. URL: ${finalUrl}`);
}

// ── Connect account to Smartlead ──────────────────────────────────────────────
async function connectAccountToSmartlead(browser, page, email, password) {
  await page.goto('https://app.smartlead.ai/app/email-accounts', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  for (const txt of ['Add Account', 'Connect Account', 'Add Email Account', '+ Add', 'Add Mailbox']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')] | //a[contains(., '${txt}')]`);
      if (btns.length > 0) { await btns[0].click(); await delay(1500); break; }
    } catch (e) {}
  }
  await delay(1000);
  for (const txt of ['Google', 'Gmail', 'Connect with Google', 'Google Workspace']) {
    try {
      const els = await page.$x(`//button[contains(., '${txt}')] | //div[@role='button'][contains(., '${txt}')] | //a[contains(., '${txt}')]`);
      if (els.length > 0) { await els[0].click(); await delay(2000); break; }
    } catch (e) {}
  }

  const popup = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OAuth popup did not open within 15s')), 15000);
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
      sendStatus('Launching headless browser...', 'info', 0);
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      sendStatus('Phase 1: Creating users in Google Admin...', 'info', 2);
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
          console.error('Error:', e.stack);
        }
      }
      sendStatus('Phase 1 complete. Starting Smartlead...', 'success', 50);

      sendStatus('Phase 2: Connecting accounts to Smartlead...', 'info', 52);
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
      }
      sendStatus('🎉 All done!', 'success', 100);
    } catch (e) {
      sendStatus(`❌ Fatal error: ${e.message}`, 'error');
      console.error('Fatal:', e.stack);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  })();
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`\n✅ MithMill Automator backend running on port ${PORT}\n`));

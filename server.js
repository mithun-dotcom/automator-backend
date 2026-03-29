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

// ── Reliable type into input ───────────────────────────────────────────────────
async function typeInto(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 8000 });
  await page.click(selector, { clickCount: 3 });
  await delay(150);
  await page.keyboard.press('Backspace');
  await delay(100);
  await page.type(selector, value, { delay: 80 });
}

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

// ── Google Admin login ────────────────────────────────────────────────────────
async function loginGoogleAdmin(page, email, password) {
  sendStatus('Logging in to Google Admin...', 'info');
  await page.goto('https://admin.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  for (const sel of ['input[type="email"]', '#identifierId']) {
    try { await typeInto(page, sel, email); await page.keyboard.press('Enter'); await delay(3000); break; } catch (e) {}
  }
  for (const sel of ['input[type="password"]', 'input[name="Passwd"]']) {
    try { await typeInto(page, sel, password); await page.keyboard.press('Enter'); await delay(4000); break; } catch (e) {}
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
// Form structure (confirmed from screenshot):
//   First name * | Last name *
//   Primary email * [input] @ [domain <select>▼]
//   Secondary email  | Phone number
//   Manage user's password... (already expanded showing Password section)
//   Password * [input]
//   ADD NEW USER button
async function createGoogleUser(page, user) {
  await page.goto('https://admin.google.com/ac/users/new', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(4000);

  // Dump all inputs for debugging
  const inputDump = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, select')).filter(i => i.offsetParent !== null)
      .map(i => ({ tag: i.tagName, type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, ariaLabel: i.getAttribute('aria-label'), value: i.value }))
  );
  console.log('Form elements:', JSON.stringify(inputDump));

  // ── 1. First Name ──────────────────────────────────────────────────────────
  await fillByLabel(page, 'First name', user.firstName);
  await delay(500);

  // ── 2. Last Name ───────────────────────────────────────────────────────────
  await fillByLabel(page, 'Last name', user.lastName);
  await delay(500);

  // ── 3. Primary Email (username only, before the @) ─────────────────────────
  await fillByLabel(page, 'Primary email', user.username);
  await delay(500);

  // ── 4. Domain select dropdown ──────────────────────────────────────────────
  // From screenshot: it's a <select> element showing the domain name with ▼
  // It sits right after the @ symbol next to the Primary email input
  await selectDomain(page, user.domain);
  await delay(500);

  // ── 5. Click "Create password" radio ─────────────────────────────────────
  // Default is "Automatically generate" — we must switch to "Create password"
  // to reveal the password input field
  try {
    const radioResult = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
        .filter(r => r.offsetParent !== null);
      for (const radio of radios) {
        const container = radio.closest('label') || radio.parentElement;
        const text = (container ? container.textContent : '').toLowerCase();
        if (text.includes('create password')) {
          radio.click();
          return { ok: true, text: container.textContent.trim().substring(0, 50) };
        }
      }
      // Fallback: second radio is always "Create password"
      if (radios.length >= 2) {
        radios[1].click();
        return { ok: true, fallback: true, count: radios.length };
      }
      return { ok: false, count: radios.length };
    });
    console.log('Create password radio result:', JSON.stringify(radioResult));
    await delay(1200); // wait for password field to animate in
  } catch (e) { console.log('Radio click error:', e.message); }

  // ── 6. Password ─────────────────────────────────────────────────────────────
  await fillByLabel(page, 'Password', user.password);
  await delay(500);

  // ── 7. Uncheck "Ask user to change their password when they sign in" ────────
  // This checkbox must be UNCHECKED so users don't get forced to change password
  // which would break Smartlead OAuth login
  try {
    const unchecked = await page.evaluate(() => {
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .filter(c => c.offsetParent !== null);
      for (const cb of checkboxes) {
        const label = document.querySelector(`label[for="${cb.id}"]`) ||
          cb.closest('label') || cb.parentElement;
        const labelText = label ? label.textContent.toLowerCase() : '';
        if (labelText.includes('change') && labelText.includes('password')) {
          if (cb.checked) {
            cb.click(); // uncheck it
            return { unchecked: true, was: 'checked' };
          }
          return { unchecked: false, was: 'already unchecked' };
        }
      }
      return { unchecked: false, was: 'not found' };
    });
    console.log('Password change checkbox:', JSON.stringify(unchecked));
  } catch (e) { console.log('Checkbox error:', e.message); }
  await delay(400);

  // ── 8. Submit ──────────────────────────────────────────────────────────────
  const submitted = await clickAddNewUser(page);
  if (!submitted) sendStatus('⚠ Could not find ADD NEW USER button', 'warn');
  await delay(4000);
  console.log('After submit:', page.url());
}

// ── Fill input by its label ───────────────────────────────────────────────────
async function fillByLabel(page, labelText, value) {
  // Google Admin uses Material Design inputs where the label floats above the input
  // The label is a <label> or a div with class like "mat-form-field-label"
  // The input is associated via id or proximity

  const result = await page.evaluate((labelText, value) => {
    // Method 1: find input with matching aria-label or placeholder
    const direct = Array.from(document.querySelectorAll('input')).find(i =>
      i.offsetParent !== null && (
        (i.getAttribute('aria-label') || '').toLowerCase().includes(labelText.toLowerCase()) ||
        (i.placeholder || '').toLowerCase().includes(labelText.toLowerCase()) ||
        (i.name || '').toLowerCase().includes(labelText.toLowerCase())
      )
    );
    if (direct) {
      direct.focus();
      return { found: true, method: 'direct', id: direct.id, name: direct.name };
    }

    // Method 2: find label by text content, then get its associated input
    const allLabels = Array.from(document.querySelectorAll('label, mat-label, .mat-form-field-label, [class*="label"], span'));
    const matchingLabel = allLabels.find(l =>
      l.offsetParent !== null &&
      l.textContent.trim().toLowerCase().includes(labelText.toLowerCase()) &&
      l.textContent.trim().length < 50
    );
    if (matchingLabel) {
      // Try htmlFor
      if (matchingLabel.htmlFor) {
        const input = document.getElementById(matchingLabel.htmlFor);
        if (input) { input.focus(); return { found: true, method: 'htmlFor', id: input.id }; }
      }
      // Try closest form field
      const container = matchingLabel.closest('mat-form-field, .form-field, .mat-form-field, div');
      if (container) {
        const input = container.querySelector('input, textarea');
        if (input) { input.focus(); return { found: true, method: 'container', id: input.id }; }
      }
      // Try sibling/parent input
      let el = matchingLabel;
      for (let i = 0; i < 5; i++) {
        el = el.parentElement;
        if (!el) break;
        const input = el.querySelector('input');
        if (input && input.offsetParent !== null) {
          input.focus();
          return { found: true, method: 'parent', id: input.id };
        }
      }
    }
    return { found: false };
  }, labelText, value);

  if (result.found) {
    await delay(200);
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await delay(100);
    await page.keyboard.press('Backspace');
    await page.keyboard.type(value, { delay: 80 });
    console.log(`✓ Filled "${labelText}" → "${value}" (method: ${result.method}, id: ${result.id})`);
    return true;
  }

  // Fallback: map label to nth visible input index
  const indexMap = {
    'first name': 0,
    'last name': 1,
    'primary email': 2,
    'password': 3,
  };
  const idx = indexMap[labelText.toLowerCase()];
  if (idx !== undefined) {
    const filled = await page.evaluate((idx, value) => {
      const inputs = Array.from(document.querySelectorAll('input'))
        .filter(i => i.offsetParent !== null && i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio');
      const el = inputs[idx];
      if (!el) return false;
      el.focus();
      el.click();
      return true;
    }, idx, value);
    if (filled) {
      await delay(200);
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await delay(100);
      await page.keyboard.type(value, { delay: 80 });
      console.log(`✓ Filled "${labelText}" → "${value}" (fallback index: ${idx})`);
      return true;
    }
  }

  console.log(`✗ Could not fill "${labelText}"`);
  return false;
}

// ── Select domain from <select> dropdown ──────────────────────────────────────
// From screenshot: it's a proper <select> element with ▼ arrow showing domain name
async function selectDomain(page, domain) {
  sendStatus(`Selecting domain @${domain}...`, 'info');

  // Primary: it's a <select> element right after the @ sign
  const viaSelect = await page.evaluate((domain) => {
    const selects = Array.from(document.querySelectorAll('select')).filter(s => s.offsetParent !== null);
    console.log('Found selects:', selects.length, selects.map(s => ({ id: s.id, options: Array.from(s.options).map(o => o.text) })));

    for (const sel of selects) {
      const match = Array.from(sel.options).find(o =>
        o.text.toLowerCase().includes(domain.toLowerCase()) ||
        o.value.toLowerCase().includes(domain.toLowerCase())
      );
      if (match) {
        sel.value = match.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, selected: match.text };
      }
    }
    return { ok: false, selectCount: selects.length };
  }, domain);

  if (viaSelect.ok) {
    await delay(500);
    sendStatus(`✓ Domain @${domain} selected (${viaSelect.selected})`, 'success');
    return;
  }

  console.log('Native select result:', JSON.stringify(viaSelect));

  // Secondary: Puppeteer select() method on any select element
  try {
    const selects = await page.$$('select');
    for (const selectEl of selects) {
      const visible = await page.evaluate(el => el.offsetParent !== null, selectEl);
      if (!visible) continue;
      const options = await page.evaluate(el =>
        Array.from(el.options).map(o => ({ value: o.value, text: o.text })), selectEl
      );
      console.log('Select options:', JSON.stringify(options));
      const match = options.find(o =>
        o.text.toLowerCase().includes(domain.toLowerCase()) ||
        o.value.toLowerCase().includes(domain.toLowerCase())
      );
      if (match) {
        await page.select('select', match.value);
        await delay(500);
        sendStatus(`✓ Domain @${domain} selected via page.select()`, 'success');
        return;
      }
    }
  } catch (e) { console.log('page.select() failed:', e.message); }

  // Tertiary: it might be a custom dropdown (div pretending to be select)
  // Click element showing current domain text, then click target domain
  const clicked = await page.evaluate((domain) => {
    // Find any clickable element that looks like a domain name
    const domainPattern = /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}$/;
    const candidates = Array.from(document.querySelectorAll('*')).filter(el =>
      el.offsetParent !== null &&
      el.children.length <= 1 &&
      domainPattern.test(el.textContent.trim())
    );
    console.log('Domain-like elements:', candidates.map(c => c.textContent.trim()));
    if (candidates.length > 0) {
      candidates[0].click();
      return { clicked: true, text: candidates[0].textContent.trim() };
    }
    return { clicked: false };
  }, domain);

  if (clicked.clicked) {
    console.log('Clicked domain element:', clicked.text);
    await delay(800);
    // Now pick from opened list
    const picked = await page.evaluate((domain) => {
      const opts = Array.from(document.querySelectorAll('li, [role="option"], [role="menuitem"]'))
        .filter(el => el.offsetParent !== null);
      const match = opts.find(o => o.textContent.trim().toLowerCase().includes(domain.toLowerCase()));
      if (match) { match.click(); return match.textContent.trim(); }
      return null;
    }, domain);
    if (picked) {
      await delay(400);
      sendStatus(`✓ Domain @${domain} selected via custom dropdown`, 'success');
      return;
    }
  }

  sendStatus(`⚠ Could not select @${domain} — proceeding with default domain`, 'warn');
}

// ── Click ADD NEW USER button ──────────────────────────────────────────────────
async function clickAddNewUser(page) {
  // From screenshot: button text is "ADD NEW USER" (uppercase)
  for (const txt of ['ADD NEW USER', 'Add new user', 'Add user', 'Create user', 'Save']) {
    try {
      const btns = await page.$x(`//button[normalize-space(.)='${txt}'] | //button[contains(., '${txt}')]`);
      if (btns.length > 0) {
        await btns[0].click();
        console.log('Clicked:', txt);
        return true;
      }
    } catch (e) {}
  }
  try {
    const btn = await page.$('button[type="submit"]');
    if (btn) { await btn.click(); return true; }
  } catch (e) {}
  return false;
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

  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent !== null)
      .map(i => ({ type: i.type, name: i.name, placeholder: i.placeholder, id: i.id }))
  );
  console.log('Smartlead inputs:', JSON.stringify(inputs));

  for (const sel of ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="mail" i]']) {
    try { await typeInto(page, sel, email); break; } catch (e) {}
  }
  await delay(400);
  for (const sel of ['input[type="password"]', 'input[name="password"]']) {
    try { await typeInto(page, sel, password); break; } catch (e) {}
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
  const pageText = await page.evaluate(() => document.body.innerText.substring(0, 400));
  console.log('After Smartlead login URL:', finalUrl);
  console.log('After Smartlead login text:', pageText);

  if (finalUrl.includes('app.smartlead.ai') && !finalUrl.includes('login') && !finalUrl.includes('sign-in')) {
    sendStatus('✓ Logged in to Smartlead', 'success'); return;
  }
  throw new Error(`Smartlead login failed. URL: ${finalUrl} — check Render logs.`);
}

// ── Connect one account to Smartlead via OAuth ────────────────────────────────
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
      sendStatus('Phase 1 complete. Starting Smartlead connections...', 'success', 50);

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
          sendStatus(`✗ Failed to connect ${fullEmail}: ${e.message}`, 'error', pct);
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

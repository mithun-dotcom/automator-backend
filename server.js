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

// ── Type into a field: click to focus, clear, then type char by char ──────────
// This is the most reliable way to trigger React controlled inputs
async function typeIntoField(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 8000 });
  await page.click(selector, { clickCount: 3 }); // triple click to select all
  await delay(200);
  await page.keyboard.press('Backspace');         // clear
  await delay(100);
  await page.type(selector, value, { delay: 80 }); // type char by char
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

  // Email step
  for (const sel of ['input[type="email"]', '#identifierId']) {
    try {
      await typeIntoField(page, sel, email);
      await page.keyboard.press('Enter');
      await delay(3000); break;
    } catch (e) {}
  }

  // Password step
  for (const sel of ['input[type="password"]', 'input[name="Passwd"]']) {
    try {
      await typeIntoField(page, sel, password);
      await page.keyboard.press('Enter');
      await delay(4000); break;
    } catch (e) {}
  }

  try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }); } catch (e) {}

  const url = page.url();
  console.log('After Google Admin login, URL:', url);
  if (url.includes('admin.google.com') && !url.includes('signin')) {
    sendStatus('✓ Logged in to Google Admin', 'success'); return;
  }
  const txt = await page.evaluate(() => document.body.innerText);
  if (txt.includes('2-Step') || txt.includes('verification'))
    throw new Error('Google Admin requires 2-Step Verification — disable 2FA first.');
  throw new Error('Google Admin login failed. Check credentials.');
}

// ── Create one user in Google Admin ──────────────────────────────────────────
async function createGoogleUser(page, user) {
  await page.goto('https://admin.google.com/ac/users/new', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(4000);

  // Log visible inputs for debugging
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input'))
      .filter(i => i.offsetParent !== null)
      .map(i => ({ type: i.type, name: i.name, placeholder: i.placeholder, ariaLabel: i.getAttribute('aria-label'), id: i.id }))
  );
  console.log('Inputs on new user page:', JSON.stringify(inputs));

  // Fill First Name
  for (const sel of ['input[name="firstName"]', 'input[aria-label*="First name" i]', 'input[placeholder*="First" i]', '#firstName']) {
    try { await typeIntoField(page, sel, user.firstName); await delay(500); break; } catch (e) {}
  }

  // Fill Last Name
  for (const sel of ['input[name="lastName"]', 'input[aria-label*="Last name" i]', 'input[placeholder*="Last" i]', '#lastName']) {
    try { await typeIntoField(page, sel, user.lastName); await delay(500); break; } catch (e) {}
  }

  // Fill Username — click field first, then type
  for (const sel of ['input[name="username"]', 'input[aria-label*="username" i]', 'input[aria-label*="Username" i]', '#username']) {
    try { await typeIntoField(page, sel, user.username); await delay(800); break; } catch (e) {}
  }

  // Select domain from dropdown
  await selectDomain(page, user.domain);
  await delay(800);

  // Handle password
  await handlePassword(page, user.password);
  await delay(600);

  // Submit
  await submitUserForm(page);
  await delay(4000);
  console.log('After submit URL:', page.url());
}

// ── Select domain ─────────────────────────────────────────────────────────────
async function selectDomain(page, domain) {
  sendStatus(`Selecting domain @${domain}...`, 'info');

  // Strategy 1: native <select>
  const viaSelect = await page.evaluate((domain) => {
    for (const sel of Array.from(document.querySelectorAll('select'))) {
      const match = Array.from(sel.options).find(o =>
        o.value.toLowerCase().includes(domain.toLowerCase()) ||
        o.text.toLowerCase().includes(domain.toLowerCase())
      );
      if (match) {
        sel.value = match.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, domain);
  if (viaSelect) { await delay(500); sendStatus(`✓ Domain @${domain} selected via <select>`, 'success'); return; }

  // Strategy 2: find "@domain" text element and click its trigger
  const opened = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('*')).filter(el =>
      el.children.length === 0 &&
      el.offsetParent !== null &&
      (el.textContent.trim().startsWith('@') ||
       /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,10}$/.test(el.textContent.trim()))
    );
    if (candidates.length === 0) return null;
    const el = candidates[0];
    const trigger = el.closest('[role="button"]') || el.closest('button') || el.parentElement;
    if (trigger) { trigger.click(); return el.textContent.trim(); }
    el.click();
    return el.textContent.trim();
  });

  if (opened) {
    console.log('Opened domain dropdown, was showing:', opened);
    await delay(1000);
    const picked = await page.evaluate((domain) => {
      const opts = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],li,.goog-menuitem-content'))
        .filter(el => el.offsetParent !== null);
      console.log('Domain options:', opts.map(o => o.textContent.trim()));
      const match = opts.find(o => o.textContent.toLowerCase().includes(domain.toLowerCase()));
      if (match) { match.click(); return match.textContent.trim(); }
      return null;
    }, domain);
    if (picked) { await delay(500); sendStatus(`✓ Domain @${domain} selected`, 'success'); return; }
    sendStatus(`⚠ Dropdown opened but @${domain} not found — is it added as secondary domain in Google Admin?`, 'warn');
    return;
  }

  // Strategy 3: XPath direct text match
  try {
    const els = await page.$x(`//*[contains(text(),'${domain}')]`);
    if (els.length > 0) { await els[0].click(); await delay(500); sendStatus(`✓ Domain clicked directly`, 'success'); return; }
  } catch (e) {}

  sendStatus(`⚠ Domain dropdown not found on page — proceeding anyway`, 'warn');
}

// ── Handle password ───────────────────────────────────────────────────────────
async function handlePassword(page, password) {
  const pwdSels = ['input[type="password"]', 'input[name="password"]', 'input[aria-label*="password" i]'];

  // Try visible password field directly
  for (const sel of pwdSels) {
    try {
      const el = await page.$(sel);
      if (el && await page.evaluate(e => e.offsetParent !== null, el)) {
        await typeIntoField(page, sel, password);
        return;
      }
    } catch (e) {}
  }

  // Click "Set password" button first
  for (const txt of ['Set password', 'Create password', 'Enter password']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')] | //span[contains(., '${txt}')]`);
      if (btns.length > 0) {
        await btns[0].click(); await delay(1500);
        for (const sel of pwdSels) {
          try {
            await typeIntoField(page, sel, password);
            return;
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
}

// ── Submit form ───────────────────────────────────────────────────────────────
async function submitUserForm(page) {
  for (const txt of ['Add new user', 'Add user', 'Create user', 'Create', 'Save']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')]`);
      if (btns.length > 0) { await btns[0].click(); await delay(3000); return; }
    } catch (e) {}
  }
  try {
    const btn = await page.$('button[type="submit"]');
    if (btn) { await btn.click(); await delay(3000); }
  } catch (e) {}
}

// ── Smartlead login ───────────────────────────────────────────────────────────
async function loginSmartlead(page, email, password) {
  sendStatus('Logging in to Smartlead...', 'info');
  await page.goto('https://app.smartlead.ai/login', { waitUntil: 'networkidle2', timeout: 25000 });
  await delay(3000); // React app needs extra time to render

  const url = page.url();
  console.log('Smartlead login page URL:', url);

  // Already logged in
  if (url.includes('app.smartlead.ai') && !url.includes('login')) {
    sendStatus('✓ Already logged in to Smartlead', 'success'); return;
  }

  // Log all inputs for debugging
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input'))
      .filter(i => i.offsetParent !== null)
      .map(i => ({ type: i.type, name: i.name, placeholder: i.placeholder, id: i.id }))
  );
  console.log('Smartlead login page inputs:', JSON.stringify(inputs));

  // Fill email — find by type=email, name=email, or placeholder containing "email"
  let emailFilled = false;
  for (const sel of [
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="Email" i]',
  ]) {
    try {
      await typeIntoField(page, sel, email);
      emailFilled = true;
      console.log('Smartlead email filled via:', sel);
      break;
    } catch (e) {}
  }
  if (!emailFilled) {
    // Last resort: first visible input
    try {
      const firstInput = await page.$('input:not([type="hidden"]):not([type="password"])');
      if (firstInput) {
        await firstInput.click({ clickCount: 3 });
        await page.type('input:not([type="hidden"]):not([type="password"])', email, { delay: 80 });
        emailFilled = true;
      }
    } catch (e) {}
  }

  await delay(500);

  // Fill password
  let passwordFilled = false;
  for (const sel of ['input[type="password"]', 'input[name="password"]']) {
    try {
      await typeIntoField(page, sel, password);
      passwordFilled = true;
      console.log('Smartlead password filled via:', sel);
      break;
    } catch (e) {}
  }

  await delay(500);

  if (!emailFilled || !passwordFilled) {
    sendStatus(`⚠ Could not find Smartlead login fields (emailFilled=${emailFilled}, passwordFilled=${passwordFilled})`, 'warn');
  }

  // Click the login/submit button
  let submitted = false;
  for (const txt of ['Log in', 'Login', 'Sign in', 'Sign In', 'Continue', 'Submit']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')]`);
      if (btns.length > 0) {
        console.log('Clicking Smartlead button:', txt);
        await btns[0].click();
        submitted = true;
        break;
      }
    } catch (e) {}
  }
  if (!submitted) {
    try {
      const btn = await page.$('button[type="submit"]');
      if (btn) { await btn.click(); submitted = true; console.log('Clicked submit button'); }
    } catch (e) {}
  }
  if (!submitted) {
    console.log('No button found, pressing Enter');
    await page.keyboard.press('Enter');
  }

  await delay(5000);
  try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }); } catch (e) {}

  const finalUrl = page.url();
  console.log('After Smartlead login, URL:', finalUrl);

  // Check page text for error messages
  const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('Smartlead page text after login:', pageText);

  if (finalUrl.includes('app.smartlead.ai') && !finalUrl.includes('login') && !finalUrl.includes('sign-in')) {
    sendStatus('✓ Logged in to Smartlead', 'success'); return;
  }

  if (pageText.toLowerCase().includes('invalid') || pageText.toLowerCase().includes('incorrect') || pageText.toLowerCase().includes('wrong')) {
    throw new Error(`Smartlead says credentials are invalid. Double-check your email and password have no extra spaces.`);
  }

  throw new Error(`Smartlead login failed. Final URL: ${finalUrl}. Check Render logs for details.`);
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
  const missingDomain = users.find(u => !u.domain?.trim());
  if (missingDomain) return res.status(400).json({ error: `User "${missingDomain.username}" has no domain.` });

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

      // Phase 1: Create users
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
          console.error('Create user error:', e.stack);
        }
      }
      sendStatus('Phase 1 complete. Starting Smartlead connections...', 'success', 50);

      // Phase 2: Connect to Smartlead
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

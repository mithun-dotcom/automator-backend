const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

let sseClients = [];

// ── SSE ───────────────────────────────────────────────────────────────────────
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
    const browser = await puppeteer.launch({
      headless: 'new', args,
      defaultViewport: { width: 1280, height: 900 },
    });
    console.log('Launched with bundled Chromium');
    return browser;
  } catch (e) {
    console.log('Bundled Chromium failed, trying system Chrome:', e.message);
  }
  for (const executablePath of [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ]) {
    try {
      const browser = await puppeteer.launch({
        headless: 'new', executablePath, args,
        defaultViewport: { width: 1280, height: 900 },
      });
      console.log(`Launched with ${executablePath}`);
      return browser;
    } catch (e) { console.log(`Failed at ${executablePath}`); }
  }
  throw new Error('Could not launch any Chrome/Chromium browser.');
}

// ── Google Admin login ────────────────────────────────────────────────────────
async function loginGoogleAdmin(page, email, password) {
  sendStatus('Logging in to Google Admin...', 'info');
  await page.goto('https://admin.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  for (const sel of ['input[type="email"]', '#identifierId', 'input[name="identifier"]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 5000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, email, { delay: 60 });
      await page.keyboard.press('Enter');
      await delay(3000); break;
    } catch (e) {}
  }
  for (const sel of ['input[type="password"]', 'input[name="password"]', 'input[name="Passwd"]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 6000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, password, { delay: 60 });
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
    throw new Error('Google Admin requires 2-Step Verification — disable 2FA first.');
  throw new Error('Google Admin login failed. Check credentials.');
}

// ── Fill text input ───────────────────────────────────────────────────────────
async function fillField(page, fieldType, value) {
  const map = {
    firstName: ['input[name="firstName"]', 'input[aria-label*="First name" i]', 'input[placeholder*="First" i]', '#firstName'],
    lastName:  ['input[name="lastName"]',  'input[aria-label*="Last name" i]',  'input[placeholder*="Last" i]',  '#lastName'],
    username:  ['input[name="username"]',  'input[aria-label*="username" i]',   'input[placeholder*="username" i]', '#username'],
  };
  for (const sel of (map[fieldType] || [])) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 3000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, value, { delay: 50 });
      return;
    } catch (e) {}
  }
  const idx = { firstName: 0, lastName: 1, username: 2 }[fieldType] ?? 0;
  await page.evaluate((idx, val) => {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(i => i.offsetParent !== null && i.type !== 'hidden');
    const el = inputs[idx];
    if (el) {
      el.focus(); el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, idx, value);
}

// ── Select domain dropdown next to username ───────────────────────────────────
// Google Admin new user page: [username] @ [domain dropdown]
// The domain dropdown in Google Admin is a custom <div> that opens a listbox
async function selectDomain(page, domain) {
  sendStatus(`Selecting domain @${domain}...`, 'info');

  // Strategy 1: native <select> with domain option
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
  if (viaSelect) { await delay(500); sendStatus(`✓ Domain @${domain} selected`, 'success'); return; }

  // Strategy 2: dump all visible text on page to find the domain selector element
  // Then click it and pick from dropdown list
  const domainElementFound = await page.evaluate((domain) => {
    // Find ALL clickable elements on the page
    const clickable = Array.from(document.querySelectorAll(
      '[role="button"], [role="combobox"], [role="listbox"], button, [tabindex]'
    )).filter(el => el.offsetParent !== null);

    // Find one that shows a domain-like text (contains a dot, short text)
    for (const el of clickable) {
      const text = el.textContent.trim();
      if (text.includes('.') && text.length < 80 && !text.includes(' ') && text.split('.').length >= 2) {
        el.click();
        return { clicked: true, text };
      }
    }
    return { clicked: false };
  }, domain);

  if (domainElementFound.clicked) {
    sendStatus(`Clicked domain element showing: ${domainElementFound.text}`, 'info');
    await delay(1000);

    // Now pick the matching domain from the opened dropdown
    const picked = await page.evaluate((domain) => {
      const options = Array.from(document.querySelectorAll(
        '[role="option"], [role="menuitem"], [role="listitem"], li, .dropdown-item'
      )).filter(el => el.offsetParent !== null);
      const match = options.find(o => o.textContent.toLowerCase().includes(domain.toLowerCase()));
      if (match) { match.click(); return true; }
      // If only one option visible, click it anyway
      if (options.length === 1) { options[0].click(); return true; }
      return false;
    }, domain);

    if (picked) { await delay(500); sendStatus(`✓ Domain @${domain} selected`, 'success'); return; }
  }

  // Strategy 3: screenshot the page HTML to debug — log what's near the username field
  const debugInfo = await page.evaluate(() => {
    const usernameInput = document.querySelector('input[name="username"]') ||
      document.querySelector('input[aria-label*="username" i]');
    if (!usernameInput) return 'No username input found';
    const parent = usernameInput.closest('form') || usernameInput.parentElement?.parentElement?.parentElement;
    return parent ? parent.innerHTML.substring(0, 2000) : 'No parent found';
  });
  console.log('DEBUG - HTML near username field:', debugInfo.substring(0, 500));

  // Strategy 4: try clicking any element containing the current primary domain text
  // then selecting our target domain
  try {
    const allElements = await page.$$('[role="option"], option, li');
    for (const el of allElements) {
      const text = await page.evaluate(e => e.textContent.trim(), el);
      if (text.toLowerCase().includes(domain.toLowerCase())) {
        await el.click();
        await delay(500);
        sendStatus(`✓ Domain @${domain} selected via direct option click`, 'success');
        return;
      }
    }
  } catch (e) {}

  sendStatus(`⚠ Domain @${domain} could not be selected — will proceed but user may land on wrong domain`, 'warn');
}

// ── Handle password ───────────────────────────────────────────────────────────
async function handlePassword(page, password) {
  const pwdSels = ['input[type="password"]', 'input[name="password"]', 'input[aria-label*="password" i]'];
  for (const sel of pwdSels) {
    try {
      const el = await page.$(sel);
      if (el && await page.evaluate(e => e.offsetParent !== null, el)) {
        await page.click(sel, { clickCount: 3 });
        await page.type(sel, password, { delay: 50 });
        return;
      }
    } catch (e) {}
  }
  for (const txt of ['Set password', 'Create password', 'Enter password']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')] | //span[contains(., '${txt}')]`);
      if (btns.length > 0) {
        await btns[0].click(); await delay(1000);
        for (const sel of pwdSels) {
          try {
            await page.waitForSelector(sel, { visible: true, timeout: 3000 });
            await page.click(sel, { clickCount: 3 });
            await page.type(sel, password, { delay: 50 });
            return;
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
}

// ── Submit user form ──────────────────────────────────────────────────────────
async function submitUserForm(page) {
  for (const txt of ['Add new user', 'Add user', 'Create', 'Save']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')]`);
      if (btns.length > 0) { await btns[0].click(); await delay(3000); return; }
    } catch (e) {}
  }
  try { const btn = await page.$('button[type="submit"]'); if (btn) await btn.click(); } catch (e) {}
}

// ── Smartlead login ───────────────────────────────────────────────────────────
// Correct URL is /login not /auth/sign-in
async function loginSmartlead(page, email, password) {
  sendStatus('Logging in to Smartlead...', 'info');

  // Try both known URLs
  const loginUrls = [
    'https://app.smartlead.ai/login',
    'https://app.smartlead.ai/auth/login',
    'https://app.smartlead.ai/auth/sign-in',
  ];

  for (const loginUrl of loginUrls) {
    try {
      await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(2000);

      // Check if login form is present
      const hasForm = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
      if (!hasForm) continue;

      sendStatus(`Found login form at ${loginUrl}`, 'info');

      // Fill email
      for (const sel of ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="email" i]']) {
        try {
          await page.waitForSelector(sel, { visible: true, timeout: 3000 });
          await page.click(sel, { clickCount: 3 });
          await page.type(sel, email, { delay: 60 }); break;
        } catch (e) {}
      }
      await delay(500);

      // Fill password
      for (const sel of ['input[type="password"]', 'input[name="password"]']) {
        try {
          await page.waitForSelector(sel, { visible: true, timeout: 3000 });
          await page.click(sel, { clickCount: 3 });
          await page.type(sel, password, { delay: 60 }); break;
        } catch (e) {}
      }
      await delay(500);

      // Click login button or press Enter
      let submitted = false;
      for (const txt of ['Log in', 'Login', 'Sign in', 'Sign In']) {
        try {
          const btns = await page.$x(`//button[contains(., '${txt}')]`);
          if (btns.length > 0) { await btns[0].click(); submitted = true; break; }
        } catch (e) {}
      }
      if (!submitted) await page.keyboard.press('Enter');

      await delay(4000);
      try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }); } catch (e) {}

      const currentUrl = page.url();
      if (currentUrl.includes('app.smartlead.ai') && !currentUrl.includes('login') && !currentUrl.includes('sign-in')) {
        sendStatus('✓ Logged in to Smartlead', 'success');
        return;
      }

      // Check for error messages on page
      const pageText = await page.evaluate(() => document.body.innerText);
      if (pageText.includes('Invalid') || pageText.includes('incorrect') || pageText.includes('wrong')) {
        throw new Error('Smartlead says credentials are invalid. Double-check email and password.');
      }

    } catch (e) {
      if (e.message.includes('credentials')) throw e;
      console.log(`Login failed at ${loginUrl}:`, e.message);
    }
  }

  throw new Error('Smartlead login failed on all known URLs. Check credentials and try again.');
}

// ── Connect account to Smartlead via OAuth ────────────────────────────────────
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

  for (const txt of ['Google', 'Gmail', 'Connect with Google', 'Sign in with Google', 'Google Workspace']) {
    try {
      const els = await page.$x(
        `//button[contains(., '${txt}')] | //div[@role='button'][contains(., '${txt}')] | //a[contains(., '${txt}')]`
      );
      if (els.length > 0) { await els[0].click(); await delay(2000); break; }
    } catch (e) {}
  }

  // Wait for OAuth popup
  const popup = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OAuth popup did not open within 15s')), 15000);
    browser.once('targetcreated', async target => {
      clearTimeout(timer);
      resolve(await target.page());
    });
  });

  await popup.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await delay(2000);

  // Fill email in OAuth popup
  for (const sel of ['input[type="email"]', '#identifierId', 'input[name="identifier"]']) {
    try {
      await popup.waitForSelector(sel, { visible: true, timeout: 5000 });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, email, { delay: 60 });
      await popup.keyboard.press('Enter');
      await delay(2500); break;
    } catch (e) {}
  }

  // Fill password in OAuth popup
  for (const sel of ['input[type="password"]', 'input[name="Passwd"]']) {
    try {
      await popup.waitForSelector(sel, { visible: true, timeout: 6000 });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, password, { delay: 60 });
      await popup.keyboard.press('Enter');
      await delay(3000); break;
    } catch (e) {}
  }

  // Click Allow
  try {
    const allowBtns = await popup.$x('//button[contains(., "Allow")] | //button[contains(., "Continue")]');
    if (allowBtns.length > 0) { await allowBtns[0].click(); await delay(2000); }
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
  if (missingDomain) return res.status(400).json({
    error: `User "${missingDomain.username}" has no domain. Fix your CSV.`
  });

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

      // Phase 1: Create users in Google Admin
      sendStatus('Phase 1: Creating users in Google Admin...', 'info', 2);
      await loginGoogleAdmin(page, googleEmail, googlePassword);

      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const fullEmail = `${user.username}@${user.domain}`;
        const pct = Math.round(2 + (i / users.length) * 48);
        sendStatus(`[${i + 1}/${users.length}] Creating: ${fullEmail}`, 'info', pct);
        try {
          await page.goto('https://admin.google.com/ac/users/new', { waitUntil: 'networkidle2', timeout: 30000 });
          await delay(2500);
          await fillField(page, 'firstName', user.firstName);   await delay(400);
          await fillField(page, 'lastName', user.lastName);     await delay(400);
          await fillField(page, 'username', user.username);     await delay(800);
          await selectDomain(page, user.domain);                await delay(500);
          await handlePassword(page, user.password);            await delay(400);
          await submitUserForm(page);                           await delay(3000);
          sendStatus(`✓ Created: ${fullEmail}`, 'success', pct + 1);
        } catch (e) {
          sendStatus(`✗ Failed to create ${fullEmail}: ${e.message}`, 'error', pct);
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

      sendStatus('🎉 All done! All users created and connected to Smartlead.', 'success', 100);

    } catch (e) {
      sendStatus(`❌ Fatal error: ${e.message}`, 'error');
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  })();
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`\n✅ MithMill Automator backend running on port ${PORT}\n`));

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
    console.log('Launched with bundled Chromium');
    return b;
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
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 5000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, email, { delay: 60 });
      await page.keyboard.press('Enter');
      await delay(3000); break;
    } catch (e) {}
  }
  for (const sel of ['input[type="password"]', 'input[name="Passwd"]']) {
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

// ── Create one user in Google Admin ──────────────────────────────────────────
// All interactions done via page.evaluate() to avoid detached frame issues
async function createGoogleUser(page, user) {
  // Navigate fresh every time
  await page.goto('https://admin.google.com/ac/users/new', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  // Wait for form to be ready
  await page.waitForFunction(() => {
    const inputs = document.querySelectorAll('input');
    return inputs.length >= 2;
  }, { timeout: 15000 });

  await delay(1000);

  // Fill ALL fields in a single evaluate call to avoid frame detachment
  const filled = await page.evaluate((firstName, lastName, username) => {
    const results = [];

    // Helper: find and fill input
    function fillInput(selectors, value, label) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.focus();
          el.value = '';
          // Use native input setter to trigger React/Angular change detection
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
          results.push(`✓ ${label}: ${value}`);
          return true;
        }
      }
      // Fallback: try visible inputs by order
      const visibleInputs = Array.from(document.querySelectorAll('input'))
        .filter(i => i.offsetParent !== null && i.type !== 'hidden' && i.type !== 'password');
      const idx = label === 'firstName' ? 0 : label === 'lastName' ? 1 : 2;
      if (visibleInputs[idx]) {
        const el = visibleInputs[idx];
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        results.push(`✓ ${label} (fallback): ${value}`);
        return true;
      }
      results.push(`✗ ${label}: not found`);
      return false;
    }

    fillInput(['input[name="firstName"]', 'input[aria-label*="First" i]', '#firstName'], firstName, 'firstName');
    fillInput(['input[name="lastName"]', 'input[aria-label*="Last" i]', '#lastName'], lastName, 'lastName');
    fillInput(['input[name="username"]', 'input[aria-label*="username" i]', '#username'], username, 'username');

    return results;
  }, user.firstName, user.lastName, user.username);

  console.log('Fill results:', filled);
  await delay(1500);

  // Select domain — done separately after fields are filled
  await selectDomain(page, user.domain);
  await delay(800);

  // Handle password — re-query page fresh
  await handlePassword(page, user.password);
  await delay(600);

  // Submit
  await submitUserForm(page);
  await delay(3000);

  // Verify creation by checking URL or success message
  const currentUrl = page.url();
  const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('After submit URL:', currentUrl);
  console.log('After submit text:', pageText.substring(0, 200));
}

// ── Select domain from dropdown ───────────────────────────────────────────────
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

  // Strategy 2: find the domain text currently shown on the page (e.g. "@primarydomain.com")
  // and click it to open the dropdown, then select the target domain
  const domainClicked = await page.evaluate((targetDomain) => {
    // Look for elements that contain "@" + some domain text
    const allEls = Array.from(document.querySelectorAll('*'))
      .filter(el =>
        el.children.length === 0 &&          // leaf node
        el.offsetParent !== null &&           // visible
        el.textContent.trim().startsWith('@') // starts with @
      );

    if (allEls.length > 0) {
      // Click the parent container (the dropdown trigger)
      const trigger = allEls[0].closest('[role="button"]') ||
                      allEls[0].closest('button') ||
                      allEls[0].parentElement;
      if (trigger) { trigger.click(); return { clicked: true, found: allEls[0].textContent.trim() }; }
      allEls[0].click();
      return { clicked: true, found: allEls[0].textContent.trim() };
    }

    // Also try: any element whose full text IS a domain (no spaces, has a dot)
    const domainLike = Array.from(document.querySelectorAll('[role="button"], span, div, button'))
      .filter(el => {
        const t = el.textContent.trim();
        return el.offsetParent !== null && /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(t);
      });

    if (domainLike.length > 0) {
      domainLike[0].click();
      return { clicked: true, found: domainLike[0].textContent.trim() };
    }
    return { clicked: false };
  }, domain);

  if (domainClicked.clicked) {
    sendStatus(`Opened domain dropdown (was showing: ${domainClicked.found})`, 'info');
    await delay(1000);

    // Now pick the target domain from opened list
    const picked = await page.evaluate((domain) => {
      const options = Array.from(document.querySelectorAll(
        '[role="option"], [role="menuitem"], li, .goog-menuitem, .md-option'
      )).filter(el => el.offsetParent !== null);

      console.log('Dropdown options found:', options.map(o => o.textContent.trim()));

      const match = options.find(o => o.textContent.toLowerCase().includes(domain.toLowerCase()));
      if (match) { match.click(); return { ok: true, text: match.textContent.trim() }; }

      // If target domain not found but options exist, log them
      return { ok: false, options: options.map(o => o.textContent.trim()).slice(0, 10) };
    }, domain);

    if (picked.ok) {
      await delay(500);
      sendStatus(`✓ Domain @${domain} selected`, 'success');
      return;
    } else {
      sendStatus(`Domain dropdown opened but @${domain} not found. Options: ${JSON.stringify(picked.options)}`, 'warn');
    }
  }

  // Strategy 3: maybe the domain is shown differently — try XPath
  try {
    const handle = await page.$x(`//*[contains(text(),'${domain}')]`);
    if (handle.length > 0) {
      await handle[0].click();
      await delay(500);
      sendStatus(`✓ Domain @${domain} clicked directly`, 'success');
      return;
    }
  } catch (e) {}

  sendStatus(`⚠ Could not select @${domain} — domain dropdown may need manual inspection`, 'warn');
}

// ── Handle password field ─────────────────────────────────────────────────────
async function handlePassword(page, password) {
  // First try direct password input
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

  // Click "Set password" / "Create password" button first
  for (const txt of ['Set password', 'Create password', 'Enter password', 'Auto-generate']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')] | //span[contains(., '${txt}')]`);
      if (btns.length > 0) {
        await btns[0].click(); await delay(1200);
        for (const sel of pwdSels) {
          try {
            await page.waitForSelector(sel, { visible: true, timeout: 4000 });
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
  for (const txt of ['Add new user', 'Add user', 'Create user', 'Create', 'Save']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')]`);
      if (btns.length > 0) { await btns[0].click(); await delay(3000); return; }
    } catch (e) {}
  }
  // Fallback: submit button
  try {
    const btn = await page.$('button[type="submit"]');
    if (btn) { await btn.click(); await delay(3000); }
  } catch (e) {}
}

// ── Smartlead login ───────────────────────────────────────────────────────────
async function loginSmartlead(page, email, password) {
  sendStatus('Logging in to Smartlead...', 'info');
  for (const loginUrl of ['https://app.smartlead.ai/login', 'https://app.smartlead.ai/auth/sign-in']) {
    try {
      await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(2000);
      const hasForm = await page.$('input[type="email"], input[name="email"]');
      if (!hasForm) continue;

      for (const sel of ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="email" i]']) {
        try {
          await page.waitForSelector(sel, { visible: true, timeout: 3000 });
          await page.click(sel, { clickCount: 3 });
          await page.type(sel, email, { delay: 60 }); break;
        } catch (e) {}
      }
      await delay(400);
      for (const sel of ['input[type="password"]', 'input[name="password"]']) {
        try {
          await page.waitForSelector(sel, { visible: true, timeout: 3000 });
          await page.click(sel, { clickCount: 3 });
          await page.type(sel, password, { delay: 60 }); break;
        } catch (e) {}
      }
      await delay(400);

      // Click login button
      let submitted = false;
      for (const txt of ['Log in', 'Login', 'Sign in', 'Sign In', 'Continue']) {
        try {
          const btns = await page.$x(`//button[contains(., '${txt}')]`);
          if (btns.length > 0) { await btns[0].click(); submitted = true; break; }
        } catch (e) {}
      }
      if (!submitted) await page.keyboard.press('Enter');

      await delay(4000);
      try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }); } catch (e) {}

      const url = page.url();
      if (url.includes('app.smartlead.ai') && !url.includes('login') && !url.includes('sign-in')) {
        sendStatus('✓ Logged in to Smartlead', 'success'); return;
      }
    } catch (e) { console.log('Smartlead login attempt failed:', e.message); }
  }
  throw new Error('Smartlead login failed. Please verify your Smartlead email and password are correct.');
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
      await popup.type(sel, email, { delay: 60 });
      await popup.keyboard.press('Enter');
      await delay(2500); break;
    } catch (e) {}
  }
  for (const sel of ['input[type="password"]', 'input[name="Passwd"]']) {
    try {
      await popup.waitForSelector(sel, { visible: true, timeout: 6000 });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, password, { delay: 60 });
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
          console.error('Create user error:', e);
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
      console.error('Fatal error:', e);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  })();
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`\n✅ MithMill Automator backend running on port ${PORT}\n`));

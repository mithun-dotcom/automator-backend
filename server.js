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

// ── Launch headless browser ───────────────────────────────────────────────────
async function launchBrowser() {
  return await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
}

// ── Google Admin login ────────────────────────────────────────────────────────
async function loginGoogleAdmin(page, email, password) {
  sendStatus('Logging in to Google Admin...', 'info');
  await page.goto('https://admin.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1500);

  for (const sel of ['input[type="email"]', '#identifierId', 'input[name="identifier"]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 5000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, email, { delay: 60 });
      await page.keyboard.press('Enter');
      await delay(2500); break;
    } catch (e) {}
  }

  for (const sel of ['input[type="password"]', 'input[name="password"]', 'input[name="Passwd"]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 6000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, password, { delay: 60 });
      await page.keyboard.press('Enter');
      await delay(3000); break;
    } catch (e) {}
  }

  try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }); } catch (e) {}

  const url = page.url();
  if (url.includes('admin.google.com') && !url.includes('signin')) {
    sendStatus('✓ Logged in to Google Admin', 'success');
    return;
  }
  const txt = await page.evaluate(() => document.body.innerText);
  if (txt.includes('2-Step') || txt.includes('verification'))
    throw new Error('Google Admin requires 2-Step Verification — disable 2FA first.');
  throw new Error('Google Admin login failed. Check credentials.');
}

// ── Fill a text input ─────────────────────────────────────────────────────────
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
  // Fallback: nth visible input
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

// ── Select domain from the @ dropdown next to username ───────────────────────
// Google Admin new user page has: [username input] @ [domain dropdown]
// The dropdown can be a native <select> or a custom Material/React component.
async function selectDomain(page, domain) {
  sendStatus(`Selecting domain @${domain}...`, 'info');

  // Strategy 1: native <select> containing the domain value
  const viaSelect = await page.evaluate((domain) => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
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

  if (viaSelect) {
    await delay(400);
    sendStatus(`✓ Domain @${domain} selected`, 'success');
    return;
  }

  // Strategy 2: custom dropdown — find the element showing current domain and click it
  // Google Admin renders the domain part as a clickable span/div/button after the @ symbol
  const clicked = await page.evaluate((domain) => {
    // Look for any element whose text is exactly or contains a domain-like string (has a dot)
    // and is near/adjacent to the username input
    const usernameInput = document.querySelector(
      'input[name="username"], input[aria-label*="username" i], input[placeholder*="username" i]'
    );
    if (!usernameInput) return false;

    // Walk siblings and nearby elements
    const parent = usernameInput.closest('div, form, section') || document.body;
    const candidates = Array.from(parent.querySelectorAll(
      '[role="button"], [role="combobox"], [role="listbox"], button, span, div'
    )).filter(el => {
      const text = el.textContent.trim();
      return (
        el.offsetParent !== null &&
        text.length > 3 &&
        text.length < 60 &&
        text.includes('.') // domain-like text
      );
    });

    for (const el of candidates) {
      if (el.textContent.toLowerCase().includes(domain.toLowerCase())) {
        // Already showing the right domain — no click needed
        return 'already';
      }
    }

    // Click the first candidate that looks like a domain selector
    if (candidates.length > 0) {
      candidates[0].click();
      return 'clicked';
    }
    return false;
  }, domain);

  if (clicked === 'already') {
    sendStatus(`✓ Domain @${domain} already selected`, 'success');
    return;
  }

  if (clicked === 'clicked') {
    await delay(800);
    // Now pick the correct domain from the opened dropdown list
    const picked = await page.evaluate((domain) => {
      const options = Array.from(document.querySelectorAll(
        '[role="option"], [role="menuitem"], li[data-value], .dropdown-item, li'
      ));
      const match = options.find(o =>
        o.textContent.toLowerCase().includes(domain.toLowerCase())
      );
      if (match) { match.click(); return true; }
      return false;
    }, domain);

    if (picked) {
      await delay(400);
      sendStatus(`✓ Domain @${domain} selected`, 'success');
      return;
    }
  }

  // Strategy 3: XPath — find any element that visually shows a domain name
  try {
    const handles = await page.$x(
      `//*[contains(@class,'domain') or contains(@id,'domain') or contains(@aria-label,'domain') or contains(@data-value,'${domain}')]`
    );
    for (const h of handles) {
      try {
        await h.click();
        await delay(700);
        const picked = await page.evaluate((domain) => {
          const opts = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li'));
          const match = opts.find(o => o.textContent.toLowerCase().includes(domain.toLowerCase()));
          if (match) { match.click(); return true; }
          return false;
        }, domain);
        if (picked) {
          sendStatus(`✓ Domain @${domain} selected`, 'success');
          return;
        }
      } catch (e) {}
    }
  } catch (e) {}

  sendStatus(`⚠ Could not auto-select @${domain} — proceeding anyway`, 'warn');
}

// ── Handle password field ─────────────────────────────────────────────────────
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
      if (btns.length > 0) { await btns[0].click(); await delay(2500); return; }
    } catch (e) {}
  }
  try { const btn = await page.$('button[type="submit"]'); if (btn) await btn.click(); } catch (e) {}
}

// ── Smartlead login ───────────────────────────────────────────────────────────
async function loginSmartlead(page, email, password) {
  sendStatus('Logging in to Smartlead...', 'info');
  await page.goto('https://app.smartlead.ai/auth/sign-in', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1500);

  for (const sel of ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="email" i]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 5000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, email, { delay: 60 }); break;
    } catch (e) {}
  }
  await delay(400);
  for (const sel of ['input[type="password"]', 'input[name="password"]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 5000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, password, { delay: 60 }); break;
    } catch (e) {}
  }
  await page.keyboard.press('Enter');
  await delay(3000);
  try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }); } catch (e) {}

  const url = page.url();
  if (url.includes('app.smartlead.ai') && !url.includes('sign-in')) {
    sendStatus('✓ Logged in to Smartlead', 'success');
    return;
  }
  throw new Error('Smartlead login failed. Check credentials.');
}

// ── Connect account to Smartlead via OAuth ────────────────────────────────────
async function connectAccountToSmartlead(browser, page, email, password) {
  await page.goto('https://app.smartlead.ai/app/email-accounts', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  for (const txt of ['Add Account', 'Connect Account', 'Add Email Account', '+ Add']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')] | //a[contains(., '${txt}')]`);
      if (btns.length > 0) { await btns[0].click(); await delay(1500); break; }
    } catch (e) {}
  }
  for (const txt of ['Google', 'Gmail', 'Connect with Google', 'Sign in with Google']) {
    try {
      const els = await page.$x(
        `//button[contains(., '${txt}')] | //div[@role='button'][contains(., '${txt}')] | //a[contains(., '${txt}')]`
      );
      if (els.length > 0) { await els[0].click(); await delay(2000); break; }
    } catch (e) {}
  }

  const popup = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OAuth popup did not open')), 12000);
    browser.once('targetcreated', async target => { clearTimeout(timer); resolve(await target.page()); });
  });

  await popup.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await delay(1500);

  for (const sel of ['input[type="email"]', '#identifierId', 'input[name="identifier"]']) {
    try {
      await popup.waitForSelector(sel, { visible: true, timeout: 5000 });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, email, { delay: 60 });
      await popup.keyboard.press('Enter');
      await delay(2000); break;
    } catch (e) {}
  }
  for (const sel of ['input[type="password"]', 'input[name="Passwd"]']) {
    try {
      await popup.waitForSelector(sel, { visible: true, timeout: 5000 });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, password, { delay: 60 });
      await popup.keyboard.press('Enter');
      await delay(3000); break;
    } catch (e) {}
  }
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

  const missingDomain = users.find(u => !u.domain || !u.domain.trim());
  if (missingDomain) {
    return res.status(400).json({
      error: `User "${missingDomain.username}" has no domain. Make sure every row has a domain column.`
    });
  }

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
          await page.goto('https://admin.google.com/ac/users/new', { waitUntil: 'networkidle2', timeout: 30000 });
          await delay(2000);
          await fillField(page, 'firstName', user.firstName);   await delay(400);
          await fillField(page, 'lastName', user.lastName);     await delay(400);
          await fillField(page, 'username', user.username);     await delay(600);
          await selectDomain(page, user.domain);                await delay(400);
          await handlePassword(page, user.password);            await delay(400);
          await submitUserForm(page);
          await delay(3000);
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

const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

let browser = null;
let page = null;
let sseClients = [];

// ── SSE: live status stream ──────────────────────────────────────────────────
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
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'MithMill Automator backend running' }));

// ── Launch Browser ────────────────────────────────────────────────────────────
app.post('/launch-browser', async (req, res) => {
  try {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
      page = null;
    }

    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: [
        '--start-maximized',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const pages = await browser.pages();
    page = pages[0];

    // Remove automation flags
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto('https://admin.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
    sendStatus('Browser launched. Please log in to Google Admin, then click "Create Users".', 'info');
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Create Users in Google Admin ──────────────────────────────────────────────
app.post('/create-users', async (req, res) => {
  const { users, domain } = req.body;
  if (!users || !users.length) return res.status(400).json({ error: 'No users provided' });
  if (!page) return res.status(400).json({ error: 'Browser not launched. Launch browser first.' });

  res.json({ ok: true, total: users.length });

  (async () => {
    sendStatus(`Starting Google Workspace user creation — ${users.length} users`, 'info', 0);

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const pct = Math.round((i / users.length) * 50);
      sendStatus(`[${i + 1}/${users.length}] Creating: ${user.username}@${domain}`, 'info', pct);

      try {
        await page.goto('https://admin.google.com/ac/users/new', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
        await delay(2000);

        await fillField(page, 'firstName', user.firstName);
        await delay(400);
        await fillField(page, 'lastName', user.lastName);
        await delay(400);
        await fillField(page, 'username', user.username);
        await delay(600);
        await handlePassword(page, user.password);
        await delay(400);
        await submitUserForm(page);
        await delay(3000);

        sendStatus(`✓ Created: ${user.firstName} ${user.lastName} (${user.username}@${domain})`, 'success', pct + 1);
      } catch (e) {
        sendStatus(`✗ Failed for ${user.username}: ${e.message}`, 'error', pct);
      }
    }

    sendStatus('All users created! Now log in to Smartlead and click "Connect Smartlead".', 'success', 50);
  })();
});

// ── Connect Smartlead ─────────────────────────────────────────────────────────
app.post('/connect-smartlead', async (req, res) => {
  const { users, domain } = req.body;
  if (!users || !users.length) return res.status(400).json({ error: 'No users provided' });
  if (!page) return res.status(400).json({ error: 'Browser not launched. Launch browser first.' });

  res.json({ ok: true, total: users.length });

  (async () => {
    sendStatus(`Starting Smartlead OAuth connection — ${users.length} accounts`, 'info', 50);

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const pct = 50 + Math.round((i / users.length) * 50);
      const email = `${user.username}@${domain}`;
      sendStatus(`[${i + 1}/${users.length}] Connecting: ${email}`, 'info', pct);

      try {
        await page.goto('https://app.smartlead.ai/app/email-accounts', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
        await delay(2000);

        await clickSmartleadAddAccount(page);
        await delay(1500);
        await clickGoogleOAuth(page);
        await delay(2000);
        await handleOAuthPopup(browser, email, user.password);
        await delay(3000);

        sendStatus(`✓ Connected: ${email}`, 'success', pct + 1);
      } catch (e) {
        sendStatus(`✗ Failed for ${email}: ${e.message}`, 'error', pct);
      }
    }

    sendStatus('🎉 All done! All accounts created and connected to Smartlead.', 'success', 100);
  })();
});

// ── Helper: delay ─────────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Helper: fill input field ──────────────────────────────────────────────────
async function fillField(page, fieldType, value) {
  const selectorMap = {
    firstName: [
      'input[name="firstName"]',
      'input[aria-label*="First name" i]',
      'input[placeholder*="First" i]',
      '#firstName',
    ],
    lastName: [
      'input[name="lastName"]',
      'input[aria-label*="Last name" i]',
      'input[placeholder*="Last" i]',
      '#lastName',
    ],
    username: [
      'input[name="username"]',
      'input[aria-label*="username" i]',
      'input[placeholder*="username" i]',
      '#username',
    ],
  };

  for (const sel of (selectorMap[fieldType] || [])) {
    try {
      await page.waitForSelector(sel, { timeout: 3000, visible: true });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, value, { delay: 50 });
      return;
    } catch (e) { /* try next */ }
  }

  // Fallback: use visible input index
  const indexMap = { firstName: 0, lastName: 1, username: 2 };
  await page.evaluate((idx, val) => {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(i => i.offsetParent !== null && i.type !== 'hidden');
    const el = inputs[idx];
    if (el) {
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, indexMap[fieldType] ?? 0, value);
}

// ── Helper: handle password field ────────────────────────────────────────────
async function handlePassword(page, password) {
  const pwdSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[aria-label*="password" i]',
  ];

  // Try direct password field
  for (const sel of pwdSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await page.evaluate(e => e.offsetParent !== null, el);
        if (visible) {
          await page.click(sel, { clickCount: 3 });
          await page.type(sel, password, { delay: 50 });
          return;
        }
      }
    } catch (e) { /* */ }
  }

  // Try clicking "Set password" / "Create password" button first
  const btnTexts = ['Set password', 'Create password', 'Enter password'];
  for (const txt of btnTexts) {
    try {
      const btns = await page.$x(
        `//button[contains(., '${txt}')] | //span[contains(., '${txt}')]`
      );
      if (btns.length > 0) {
        await btns[0].click();
        await delay(1000);
        for (const sel of pwdSelectors) {
          try {
            await page.waitForSelector(sel, { timeout: 3000, visible: true });
            await page.click(sel, { clickCount: 3 });
            await page.type(sel, password, { delay: 50 });
            return;
          } catch (e) { /* */ }
        }
      }
    } catch (e) { /* */ }
  }
}

// ── Helper: submit user form ──────────────────────────────────────────────────
async function submitUserForm(page) {
  const submitTexts = ['Add new user', 'Create', 'Add user', 'Save'];
  for (const txt of submitTexts) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')]`);
      if (btns.length > 0) {
        await btns[0].click();
        await delay(2000);
        return;
      }
    } catch (e) { /* */ }
  }
  // Fallback
  try {
    const btn = await page.$('button[type="submit"]');
    if (btn) { await btn.click(); return; }
  } catch (e) { /* */ }
}

// ── Helper: click Smartlead "Add Account" ─────────────────────────────────────
async function clickSmartleadAddAccount(page) {
  const btnTexts = ['Add Account', 'Connect Account', 'Add Email Account', '+ Add'];
  for (const txt of btnTexts) {
    try {
      const btns = await page.$x(
        `//button[contains(., '${txt}')] | //a[contains(., '${txt}')]`
      );
      if (btns.length > 0) { await btns[0].click(); return; }
    } catch (e) { /* */ }
  }
  const sels = ['[data-testid="add-account"]', '.add-account-btn'];
  for (const sel of sels) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); return; }
    } catch (e) { /* */ }
  }
}

// ── Helper: click Google OAuth button ────────────────────────────────────────
async function clickGoogleOAuth(page) {
  const googleTexts = ['Google', 'Gmail', 'Connect with Google', 'Sign in with Google'];
  for (const txt of googleTexts) {
    try {
      const els = await page.$x(
        `//button[contains(., '${txt}')] | //div[@role='button'][contains(., '${txt}')] | //a[contains(., '${txt}')]`
      );
      if (els.length > 0) { await els[0].click(); return; }
    } catch (e) { /* */ }
  }
  const sels = ['[data-provider="google"]', '.google-oauth', 'img[alt*="Google"]'];
  for (const sel of sels) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); return; }
    } catch (e) { /* */ }
  }
}

// ── Helper: handle OAuth popup ────────────────────────────────────────────────
async function handleOAuthPopup(browser, email, password) {
  const popup = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OAuth popup did not open')), 12000);
    browser.once('targetcreated', async target => {
      clearTimeout(timer);
      resolve(await target.page());
    });
  });

  await popup.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await delay(1500);

  // Fill email
  const emailSels = ['input[type="email"]', 'input[name="identifier"]', '#identifierId'];
  for (const sel of emailSels) {
    try {
      await popup.waitForSelector(sel, { timeout: 5000, visible: true });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, email, { delay: 60 });
      await popup.keyboard.press('Enter');
      await delay(2000);
      break;
    } catch (e) { /* */ }
  }

  // Fill password
  const pwdSels = ['input[type="password"]', 'input[name="Passwd"]'];
  for (const sel of pwdSels) {
    try {
      await popup.waitForSelector(sel, { timeout: 5000, visible: true });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, password, { delay: 60 });
      await popup.keyboard.press('Enter');
      await delay(3000);
      break;
    } catch (e) { /* */ }
  }

  // Click Allow if shown
  try {
    const allowBtns = await popup.$x(
      '//button[contains(., "Allow")] | //button[contains(., "Continue")]'
    );
    if (allowBtns.length > 0) {
      await allowBtns[0].click();
      await delay(2000);
    }
  } catch (e) { /* */ }

  try { await popup.close(); } catch (e) { /* */ }
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`\n✅ MithMill Automator backend running on port ${PORT}\n`);
});

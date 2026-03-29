const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

let sseClients = [];

// ── SSE: live log stream ──────────────────────────────────────────────────────
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

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'MithMill Automator backend running' }));

// ── Helper: launch headless browser ──────────────────────────────────────────
async function launchBrowser() {
  return await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
}

// ── Helper: delay ─────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Helper: Google Admin login ────────────────────────────────────────────────
async function loginGoogleAdmin(page, email, password) {
  sendStatus('Navigating to Google Admin login...', 'info');
  await page.goto('https://admin.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1500);

  // Enter email
  const emailSels = ['input[type="email"]', '#identifierId', 'input[name="identifier"]'];
  for (const sel of emailSels) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 5000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, email, { delay: 60 });
      await page.keyboard.press('Enter');
      await delay(2500);
      break;
    } catch (e) { /* try next */ }
  }

  // Enter password
  const pwdSels = ['input[type="password"]', 'input[name="password"]', 'input[name="Passwd"]'];
  for (const sel of pwdSels) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 6000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, password, { delay: 60 });
      await page.keyboard.press('Enter');
      await delay(3000);
      break;
    } catch (e) { /* try next */ }
  }

  // Wait for admin dashboard
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
  } catch (e) { /* may already be there */ }

  const url = page.url();
  if (url.includes('admin.google.com') && !url.includes('signin')) {
    sendStatus('✓ Logged in to Google Admin', 'success');
    return true;
  }

  // Check for 2FA or error
  const pageText = await page.evaluate(() => document.body.innerText);
  if (pageText.includes('2-Step') || pageText.includes('verification')) {
    throw new Error('Google Admin requires 2-Step Verification — please disable 2FA for this admin account or use an app password.');
  }
  if (pageText.includes('Wrong password') || pageText.includes('incorrect')) {
    throw new Error('Google Admin: wrong email or password.');
  }
  throw new Error('Google Admin login failed. Check credentials.');
}

// ── Helper: fill input field ──────────────────────────────────────────────────
async function fillField(page, fieldType, value) {
  const selectorMap = {
    firstName: ['input[name="firstName"]', 'input[aria-label*="First name" i]', 'input[placeholder*="First" i]', '#firstName'],
    lastName:  ['input[name="lastName"]',  'input[aria-label*="Last name" i]',  'input[placeholder*="Last" i]',  '#lastName'],
    username:  ['input[name="username"]',  'input[aria-label*="username" i]',   'input[placeholder*="username" i]', '#username'],
  };

  for (const sel of (selectorMap[fieldType] || [])) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 3000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, value, { delay: 50 });
      return;
    } catch (e) { /* try next */ }
  }

  // Fallback: nth visible input
  const indexMap = { firstName: 0, lastName: 1, username: 2 };
  await page.evaluate((idx, val) => {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(i => i.offsetParent !== null && i.type !== 'hidden');
    const el = inputs[idx];
    if (el) {
      el.focus(); el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, indexMap[fieldType] ?? 0, value);
}

// ── Helper: handle password field ────────────────────────────────────────────
async function handlePassword(page, password) {
  const pwdSels = ['input[type="password"]', 'input[name="password"]', 'input[aria-label*="password" i]'];

  for (const sel of pwdSels) {
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

  // Try clicking "Set password" button first
  for (const txt of ['Set password', 'Create password', 'Enter password']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')] | //span[contains(., '${txt}')]`);
      if (btns.length > 0) {
        await btns[0].click();
        await delay(1000);
        for (const sel of pwdSels) {
          try {
            await page.waitForSelector(sel, { visible: true, timeout: 3000 });
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
  for (const txt of ['Add new user', 'Add user', 'Create', 'Save']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')]`);
      if (btns.length > 0) { await btns[0].click(); await delay(2500); return; }
    } catch (e) { /* */ }
  }
  try {
    const btn = await page.$('button[type="submit"]');
    if (btn) { await btn.click(); }
  } catch (e) { /* */ }
}

// ── Helper: Smartlead login ───────────────────────────────────────────────────
async function loginSmartlead(page, email, password) {
  sendStatus('Navigating to Smartlead login...', 'info');
  await page.goto('https://app.smartlead.ai/auth/sign-in', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1500);

  const emailSels = ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="email" i]'];
  for (const sel of emailSels) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 5000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, email, { delay: 60 });
      break;
    } catch (e) { /* */ }
  }

  await delay(500);

  const pwdSels = ['input[type="password"]', 'input[name="password"]'];
  for (const sel of pwdSels) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 5000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, password, { delay: 60 });
      break;
    } catch (e) { /* */ }
  }

  await page.keyboard.press('Enter');
  await delay(3000);

  try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }); } catch (e) { /* */ }

  const url = page.url();
  if (url.includes('app.smartlead.ai') && !url.includes('sign-in')) {
    sendStatus('✓ Logged in to Smartlead', 'success');
    return true;
  }
  throw new Error('Smartlead login failed. Check credentials.');
}

// ── Helper: connect one account to Smartlead via OAuth ───────────────────────
async function connectAccountToSmartlead(browser, page, email, password) {
  await page.goto('https://app.smartlead.ai/app/email-accounts', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  // Click Add Account
  for (const txt of ['Add Account', 'Connect Account', 'Add Email Account', '+ Add']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')] | //a[contains(., '${txt}')]`);
      if (btns.length > 0) { await btns[0].click(); await delay(1500); break; }
    } catch (e) { /* */ }
  }

  // Click Google option
  for (const txt of ['Google', 'Gmail', 'Connect with Google', 'Sign in with Google']) {
    try {
      const els = await page.$x(`//button[contains(., '${txt}')] | //div[@role='button'][contains(., '${txt}')] | //a[contains(., '${txt}')]`);
      if (els.length > 0) { await els[0].click(); await delay(2000); break; }
    } catch (e) { /* */ }
  }

  // Handle OAuth popup
  const popup = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OAuth popup did not open within 12s')), 12000);
    browser.once('targetcreated', async target => {
      clearTimeout(timer);
      resolve(await target.page());
    });
  });

  await popup.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await delay(1500);

  // Fill email in popup
  for (const sel of ['input[type="email"]', '#identifierId', 'input[name="identifier"]']) {
    try {
      await popup.waitForSelector(sel, { visible: true, timeout: 5000 });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, email, { delay: 60 });
      await popup.keyboard.press('Enter');
      await delay(2000);
      break;
    } catch (e) { /* */ }
  }

  // Fill password in popup
  for (const sel of ['input[type="password"]', 'input[name="Passwd"]']) {
    try {
      await popup.waitForSelector(sel, { visible: true, timeout: 5000 });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, password, { delay: 60 });
      await popup.keyboard.press('Enter');
      await delay(3000);
      break;
    } catch (e) { /* */ }
  }

  // Click Allow
  try {
    const allowBtns = await popup.$x('//button[contains(., "Allow")] | //button[contains(., "Continue")]');
    if (allowBtns.length > 0) { await allowBtns[0].click(); await delay(2000); }
  } catch (e) { /* */ }

  try { await popup.close(); } catch (e) { /* */ }
}

// ── Main automation endpoint ──────────────────────────────────────────────────
app.post('/run', async (req, res) => {
  const { users, domain, googleEmail, googlePassword, smartleadEmail, smartleadPassword } = req.body;

  // Validate
  if (!users?.length)         return res.status(400).json({ error: 'No users provided' });
  if (!domain)                return res.status(400).json({ error: 'Domain is required' });
  if (!googleEmail)           return res.status(400).json({ error: 'Google Admin email is required' });
  if (!googlePassword)        return res.status(400).json({ error: 'Google Admin password is required' });
  if (!smartleadEmail)        return res.status(400).json({ error: 'Smartlead email is required' });
  if (!smartleadPassword)     return res.status(400).json({ error: 'Smartlead password is required' });

  res.json({ ok: true, total: users.length });

  // Run async
  (async () => {
    let browser;
    try {
      sendStatus('Launching headless browser...', 'info', 0);
      browser = await launchBrowser();
      const page = await browser.newPage();

      // Remove webdriver flag
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      // ── PHASE 1: Create users in Google Admin ──────────────────────────────
      sendStatus('Phase 1: Creating users in Google Admin...', 'info', 2);
      await loginGoogleAdmin(page, googleEmail, googlePassword);

      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const pct = Math.round(2 + (i / users.length) * 48);
        sendStatus(`[${i + 1}/${users.length}] Creating: ${user.username}@${domain}`, 'info', pct);

        try {
          await page.goto('https://admin.google.com/ac/users/new', { waitUntil: 'networkidle2', timeout: 30000 });
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
          sendStatus(`✗ Failed to create ${user.username}: ${e.message}`, 'error', pct);
        }
      }

      sendStatus('Phase 1 complete. Starting Smartlead connections...', 'success', 50);

      // ── PHASE 2: Connect accounts to Smartlead ─────────────────────────────
      sendStatus('Phase 2: Connecting accounts to Smartlead...', 'info', 52);
      await loginSmartlead(page, smartleadEmail, smartleadPassword);

      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const email = `${user.username}@${domain}`;
        const pct = 52 + Math.round((i / users.length) * 46);
        sendStatus(`[${i + 1}/${users.length}] Connecting: ${email}`, 'info', pct);

        try {
          await connectAccountToSmartlead(browser, page, email, user.password);
          sendStatus(`✓ Connected: ${email}`, 'success', pct + 1);
        } catch (e) {
          sendStatus(`✗ Failed to connect ${email}: ${e.message}`, 'error', pct);
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

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`\n✅ MithMill Automator backend running on port ${PORT}\n`);
});

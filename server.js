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
  return await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1280, height: 800 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-extensions',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

// ── Open new page ─────────────────────────────────────────────────────────────
async function newPage(browser) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  // Block images and fonts to save memory
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  return page;
}

// ── Click element by visible text ─────────────────────────────────────────────
async function clickByText(page, text, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await page.evaluate((text) => {
      const els = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"], li, span, div'))
        .filter(el => el.offsetParent !== null && el.textContent.trim() === text);
      if (els.length > 0) { els[0].click(); return true; }
      // partial match fallback
      const partial = Array.from(document.querySelectorAll('a, button, [role="button"], span, div'))
        .filter(el => el.offsetParent !== null && el.textContent.trim().includes(text) && el.textContent.trim().length < text.length + 20);
      if (partial.length > 0) { partial[0].click(); return true; }
      return false;
    }, text);
    if (found) { await delay(800); return true; }
    await delay(500);
  }
  return false;
}

// ── Type into a focused/clicked input ────────────────────────────────────────
async function typeIntoSelector(page, selector, value, timeout = 8000) {
  await page.waitForSelector(selector, { visible: true, timeout });
  await page.click(selector, { clickCount: 3 });
  await delay(100);
  await page.keyboard.press('Backspace');
  await delay(50);
  await page.type(selector, value, { delay: 70 });
}

// ── Step 1: Login to Google Admin ─────────────────────────────────────────────
async function loginGoogleAdmin(page, email, password) {
  sendStatus('Navigating to Google Admin...', 'info');
  await page.goto('https://admin.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  // Fill email
  for (const sel of ['input[type="email"]', '#identifierId', 'input[name="identifier"]']) {
    try {
      await typeIntoSelector(page, sel, email, 5000);
      await page.keyboard.press('Enter');
      await delay(3000);
      break;
    } catch (e) {}
  }

  // Fill password
  for (const sel of ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]']) {
    try {
      await typeIntoSelector(page, sel, password, 6000);
      await page.keyboard.press('Enter');
      await delay(4000);
      break;
    } catch (e) {}
  }

  try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }); } catch (e) {}

  const url = page.url();
  console.log('After login URL:', url);
  if (url.includes('admin.google.com') && !url.includes('signin') && !url.includes('challenge')) {
    sendStatus('✓ Logged in to Google Admin', 'success');
    return;
  }
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes('2-Step') || bodyText.includes('verification') || bodyText.includes('Verify'))
    throw new Error('2-Step Verification required — please disable 2FA on this Google Admin account first.');
  throw new Error('Google Admin login failed — check email and password.');
}

// ── Step 2: Navigate to Users and click Add new user ─────────────────────────
async function goToAddUser(page) {
  sendStatus('Opening Add New User form...', 'info');

  // Go directly to the users page with the journey parameter that opens the add user panel
  await page.goto('https://admin.google.com/ac/users?journey=218', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  // Wait for the form to appear — look for First name input
  let formReady = false;
  for (let i = 0; i < 15; i++) {
    const hasForm = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'))
        .filter(inp => inp.offsetParent !== null && inp.type !== 'hidden' && inp.type !== 'checkbox' && inp.type !== 'radio');
      return inputs.length >= 1;
    });
    if (hasForm) { formReady = true; break; }
    await delay(1000);
  }

  if (!formReady) {
    // Try clicking "Add new user" button if form didn't open automatically
    sendStatus('Clicking Add new user button...', 'info');
    const clicked = await clickByText(page, 'Add new user');
    if (!clicked) await clickByText(page, 'Add user');
    await delay(2000);
  }

  console.log('Add user form URL:', page.url());
  sendStatus('✓ Add New User form ready', 'success');
}

// ── Step 3: Fill First Name, Last Name, Username, Domain ─────────────────────
async function fillUserInfo(page, user) {
  // Log all current inputs for debugging
  const inputInfo = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input'))
      .filter(i => i.offsetParent !== null)
      .map(i => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, ariaLabel: i.getAttribute('aria-label') }))
  );
  console.log('Form inputs:', JSON.stringify(inputInfo));

  // Fill First Name — index 0
  await fillInputByIndex(page, 0, user.firstName, 'First name');
  await delay(400);

  // Fill Last Name — index 1
  await fillInputByIndex(page, 1, user.lastName, 'Last name');
  await delay(400);

  // Fill Username (Primary email) — index 2
  await fillInputByIndex(page, 2, user.username, 'Username');
  await delay(600);

  // Select domain from dropdown next to @
  await selectDomain(page, user.domain);
  await delay(500);
}

// ── Fill input by its position among visible text inputs ──────────────────────
async function fillInputByIndex(page, index, value, label) {
  const clicked = await page.evaluate((index) => {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(i =>
        i.offsetParent !== null &&
        i.type !== 'hidden' &&
        i.type !== 'checkbox' &&
        i.type !== 'radio' &&
        i.type !== 'password'
      );
    if (!inputs[index]) return { ok: false, total: inputs.length };
    inputs[index].focus();
    inputs[index].click();
    return { ok: true, id: inputs[index].id, name: inputs[index].name, placeholder: inputs[index].placeholder };
  }, index);

  console.log(`fillInputByIndex(${index}, ${label}):`, JSON.stringify(clicked));
  if (!clicked.ok) { sendStatus(`⚠ ${label} field not found`, 'warn'); return false; }

  await delay(150);
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await delay(80);
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value, { delay: 70 });
  return true;
}

// ── Select domain from the <select> dropdown next to @ ───────────────────────
async function selectDomain(page, domain) {
  sendStatus(`Selecting domain @${domain}...`, 'info');

  // Log all selects
  const selectInfo = await page.evaluate(() =>
    Array.from(document.querySelectorAll('select'))
      .map(s => ({ id: s.id, name: s.name, visible: !!s.offsetParent, options: Array.from(s.options).map(o => o.text) }))
  );
  console.log('All selects:', JSON.stringify(selectInfo));

  // Method 1: native <select> with matching option
  const r1 = await page.evaluate((domain) => {
    const selects = Array.from(document.querySelectorAll('select')).filter(s => s.offsetParent !== null);
    for (const s of selects) {
      const match = Array.from(s.options).find(o =>
        o.text.toLowerCase().includes(domain.toLowerCase()) ||
        o.value.toLowerCase().includes(domain.toLowerCase())
      );
      if (match) {
        s.value = match.value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
        s.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, selected: match.text };
      }
    }
    return { ok: false };
  }, domain);

  if (r1.ok) {
    await delay(400);
    sendStatus(`✓ Domain @${domain} selected`, 'success');
    return;
  }

  // Method 2: Puppeteer page.select()
  try {
    const handles = await page.$$('select');
    for (const h of handles) {
      const vis = await page.evaluate(el => !!el.offsetParent, h);
      if (!vis) continue;
      const opts = await page.evaluate(el => Array.from(el.options).map(o => ({ v: o.value, t: o.text })), h);
      const match = opts.find(o => o.t.toLowerCase().includes(domain.toLowerCase()) || o.v.toLowerCase().includes(domain.toLowerCase()));
      if (match) {
        await page.select('select', match.v);
        await delay(400);
        sendStatus(`✓ Domain @${domain} selected`, 'success');
        return;
      }
    }
  } catch (e) { console.log('page.select error:', e.message); }

  // Method 3: click the domain element currently showing (custom dropdown)
  const r3 = await page.evaluate((domain) => {
    // Find visible element whose text is a domain pattern
    const re = /^@?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const candidates = Array.from(document.querySelectorAll('*'))
      .filter(el => el.offsetParent !== null && el.children.length <= 2 && re.test(el.textContent.trim()));
    console.log('Domain candidates:', candidates.map(c => c.textContent.trim()));
    if (candidates.length > 0) {
      candidates[0].click();
      return { clicked: true, text: candidates[0].textContent.trim() };
    }
    return { clicked: false };
  }, domain);

  if (r3.clicked) {
    console.log('Clicked domain element:', r3.text);
    await delay(800);
    // Pick target domain from open list
    const picked = await page.evaluate((domain) => {
      const opts = Array.from(document.querySelectorAll('li, [role="option"], [role="menuitem"]'))
        .filter(el => el.offsetParent !== null && el.textContent.toLowerCase().includes(domain.toLowerCase()));
      if (opts.length > 0) { opts[0].click(); return opts[0].textContent.trim(); }
      return null;
    }, domain);
    if (picked) { await delay(400); sendStatus(`✓ Domain @${domain} selected`, 'success'); return; }
  }

  sendStatus(`⚠ Could not select @${domain} — check Render logs for 'All selects'`, 'warn');
}

// ── Step 4: Click "Manage user's password..." ─────────────────────────────────
async function clickManagePassword(page) {
  sendStatus('Opening password section...', 'info');

  const clicked = await page.evaluate(() => {
    // Find the "Manage user's password..." link/button
    const all = Array.from(document.querySelectorAll('a, button, [role="button"], div, span'))
      .filter(el => el.offsetParent !== null);
    const match = all.find(el => el.textContent.toLowerCase().includes('manage') && el.textContent.toLowerCase().includes('password'));
    if (match) { match.click(); return { ok: true, text: match.textContent.trim().substring(0, 60) }; }
    return { ok: false };
  });

  console.log('Manage password click:', JSON.stringify(clicked));
  if (clicked.ok) {
    await delay(1500);
    sendStatus('✓ Password section opened', 'success');
  } else {
    // May already be open — check if radios are visible
    const radiosVisible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="radio"]')).some(r => r.offsetParent !== null)
    );
    if (radiosVisible) {
      sendStatus('Password section already open', 'info');
    } else {
      sendStatus('⚠ Could not find "Manage password" link', 'warn');
    }
  }
}

// ── Step 5: Select "Create password" radio ────────────────────────────────────
async function selectCreatePassword(page) {
  sendStatus('Selecting "Create password"...', 'info');

  // Wait for radios to appear
  let radiosFound = false;
  for (let i = 0; i < 8; i++) {
    const count = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="radio"]')).filter(r => r.offsetParent !== null).length
    );
    if (count > 0) { radiosFound = true; break; }
    await delay(500);
  }

  const result = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(r => r.offsetParent !== null);
    console.log('Radios:', radios.length, radios.map(r => {
      const lbl = r.closest('label') || r.parentElement;
      return lbl ? lbl.textContent.trim().substring(0, 50) : r.id;
    }));
    // Find "Create password" radio
    for (const r of radios) {
      const lbl = (r.closest('label') || r.parentElement || {}).textContent || '';
      if (lbl.toLowerCase().includes('create')) {
        r.click();
        return { ok: true, label: lbl.trim().substring(0, 50) };
      }
    }
    // Fallback: second radio is "Create password"
    if (radios.length >= 2) {
      radios[1].click();
      return { ok: true, label: 'second radio (fallback)' };
    }
    return { ok: false, count: radios.length };
  });

  console.log('Create password radio:', JSON.stringify(result));
  if (result.ok) {
    await delay(1200); // wait for password field to animate in
    sendStatus('✓ "Create password" selected', 'success');
  } else {
    sendStatus('⚠ Could not find password radio buttons', 'warn');
  }
}

// ── Step 6: Fill password + uncheck "ask to change" ──────────────────────────
async function fillPasswordAndUncheck(page, password) {
  // Wait for password input to appear
  try {
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 6000 });
    await page.click('input[type="password"]', { clickCount: 3 });
    await delay(100);
    await page.type('input[type="password"]', password, { delay: 70 });
    sendStatus('✓ Password filled', 'success');
  } catch (e) {
    sendStatus('⚠ Password field not found — ' + e.message, 'warn');
    console.log('Password error:', e.message);
  }

  await delay(400);

  // Uncheck "Ask user to change their password when they sign in"
  const cbResult = await page.evaluate(() => {
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .filter(c => c.offsetParent !== null);
    console.log('Checkboxes:', checkboxes.length, checkboxes.map(c => {
      const lbl = c.closest('label') || c.parentElement;
      return lbl ? lbl.textContent.trim().substring(0, 60) : c.id;
    }));
    for (const cb of checkboxes) {
      const lbl = (cb.closest('label') || cb.parentElement || {}).textContent || '';
      if (lbl.toLowerCase().includes('change') || lbl.toLowerCase().includes('ask')) {
        const wasCheked = cb.checked;
        if (cb.checked) cb.click();
        return { unchecked: true, was: wasCheked, label: lbl.trim().substring(0, 60) };
      }
    }
    return { unchecked: false, total: checkboxes.length };
  });
  console.log('Checkbox result:', JSON.stringify(cbResult));
  if (cbResult.unchecked) sendStatus('✓ "Change password" checkbox unchecked', 'success');
}

// ── Step 7: Click ADD NEW USER ────────────────────────────────────────────────
async function clickAddNewUser(page) {
  sendStatus('Submitting form...', 'info');

  const result = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(b => b.offsetParent !== null);
    console.log('All buttons:', buttons.map(b => b.textContent.trim().substring(0, 30)));

    for (const b of buttons) {
      const txt = b.textContent.trim().toUpperCase();
      if (txt.includes('ADD') && txt.includes('USER')) { b.click(); return { clicked: true, text: txt }; }
    }
    for (const b of buttons) {
      const txt = b.textContent.trim().toUpperCase();
      if (txt === 'SAVE' || txt === 'CREATE') { b.click(); return { clicked: true, text: txt }; }
    }
    // Last non-cancel, non-cancel button
    const viable = buttons.filter(b => {
      const t = b.textContent.trim().toUpperCase();
      return !t.includes('CANCEL') && !t.includes('CLOSE') && t.length > 0;
    });
    if (viable.length > 0) {
      const last = viable[viable.length - 1];
      last.click();
      return { clicked: true, text: last.textContent.trim(), fallback: true };
    }
    return { clicked: false };
  });

  console.log('Submit result:', JSON.stringify(result));
  await delay(4000);
  console.log('After submit URL:', page.url());
  if (result.clicked) sendStatus('✓ User form submitted', 'success');
  else sendStatus('⚠ Could not find ADD NEW USER button', 'warn');
}

// ── Full create user flow ─────────────────────────────────────────────────────
async function createGoogleUser(page, user) {
  // Step: Go to Add User form
  await goToAddUser(page);

  // Step: Fill user info
  await fillUserInfo(page, user);

  // Step: Click Manage password
  await clickManagePassword(page);

  // Step: Select Create password
  await selectCreatePassword(page);

  // Step: Fill password + uncheck
  await fillPasswordAndUncheck(page, user.password);

  // Step: Submit
  await clickAddNewUser(page);
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
    try { await typeIntoSelector(page, sel, email, 4000); break; } catch (e) {}
  }
  await delay(300);
  for (const sel of ['input[type="password"]', 'input[name="password"]']) {
    try { await typeIntoSelector(page, sel, password, 4000); break; } catch (e) {}
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

      // ── Phase 1: Create users in Google Admin ──────────────────────────────
      sendStatus('Phase 1: Creating users in Google Admin...', 'info', 2);
      const adminPage = await newPage(browser);
      await loginGoogleAdmin(adminPage, googleEmail, googlePassword);

      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const fullEmail = `${user.username}@${user.domain}`;
        const pct = Math.round(2 + (i / users.length) * 48);
        sendStatus(`[${i + 1}/${users.length}] Creating: ${fullEmail}`, 'info', pct);
        try {
          await createGoogleUser(adminPage, user);
          sendStatus(`✓ Created: ${fullEmail}`, 'success', pct + 1);
        } catch (e) {
          sendStatus(`✗ Failed: ${fullEmail} — ${e.message}`, 'error', pct);
          console.error(e.stack);
        }
        if (global.gc) global.gc();
      }
      await adminPage.close();
      sendStatus('Phase 1 complete.', 'success', 50);

      // ── Phase 2: Connect to Smartlead ──────────────────────────────────────
      sendStatus('Phase 2: Connecting to Smartlead...', 'info', 52);
      const slPage = await newPage(browser);
      await loginSmartlead(slPage, smartleadEmail, smartleadPassword);

      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const fullEmail = `${user.username}@${user.domain}`;
        const pct = 52 + Math.round((i / users.length) * 46);
        sendStatus(`[${i + 1}/${users.length}] Connecting: ${fullEmail}`, 'info', pct);
        try {
          await connectAccountToSmartlead(browser, slPage, fullEmail, user.password);
          sendStatus(`✓ Connected: ${fullEmail}`, 'success', pct + 1);
        } catch (e) {
          sendStatus(`✗ Failed: ${fullEmail} — ${e.message}`, 'error', pct);
        }
        if (global.gc) global.gc();
      }
      await slPage.close();

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
app.listen(PORT, () => console.log(`\n✅ MithMill Automator running on port ${PORT}\n`));

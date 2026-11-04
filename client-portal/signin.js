// Background sign-in to Google / Microsoft in a headless browser, for
// connecting mailboxes to sequencers (they hand us a sign-in link; we sign in
// as the mailbox and approve access, like a person would, with no window).
// Every failure says which screen stopped it and why.
const { chromium } = require('playwright-core');

class SignInError extends Error {
  constructor(message, diag) { super(message); this.diag = diag; }
}

// Production (Render): the compact Chromium from @sparticuz/chromium.
// Elsewhere CHROMIUM_PATH can point at a local Chromium.
async function launch() {
  if (process.env.CHROMIUM_PATH) {
    return chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }
  const mod = require('@sparticuz/chromium');
  const sparticuz = mod.default || mod;
  return chromium.launch({ executablePath: await sparticuz.executablePath(), headless: true, args: sparticuz.args });
}

async function newPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  return page;
}

// What's on screen: for diagnosing a failed run.
async function diag(page) {
  try {
    const info = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const txt = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const pick = (sel) => [...document.querySelectorAll(sel)].filter(vis).map(txt).filter(Boolean).slice(0, 25);
      return {
        title: document.title,
        headings: pick('h1, h2, h3'),
        buttons: pick('button, [role=button], input[type=submit], input[type=button]'),
        links: pick('a'),
        inputs: [...document.querySelectorAll('input, select, textarea')].filter(vis).map((i) => `${i.tagName.toLowerCase()}[${i.type || ''}] ${i.name || i.id || ''} ${i.getAttribute('placeholder') || ''}`.trim()).slice(0, 15),
        text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 600),
      };
    });
    return { url: page.url(), ...info };
  } catch (err) {
    return { url: (() => { try { return page.url(); } catch { return ''; } })(), error: err.message };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = (page) => page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
// Clicks the first of these that's visible; false if none is.
async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 10000 }).catch(() => {});
      return true;
    }
  }
  return false;
}
async function fail(page, message) { throw new SignInError(message, await diag(page)); }

const onGoogle = (url) => /^https:\/\/accounts\.google\.com\//.test(url);
const onMicrosoft = (url) => /^https:\/\/(login\.microsoftonline\.com|login\.live\.com|account\.live\.com|login\.microsoft\.com)\//.test(url);

// Signs in to Google as the mailbox on the page that's at a Google sign-in
// link, approves the app, and returns once Google sends the browser back to
// the sequencer.
async function google(page, email, password, step = () => {}) {
  step('Google: email');
  await page.waitForLoadState('domcontentloaded');
  if (!onGoogle(page.url())) await page.waitForURL(onGoogle, { timeout: 30000 }).catch(() => {});
  // An account chooser can come first.
  await clickFirst(page, ['text=Use another account']);
  // Google's current page uses a text field named "identifier"; older ones type="email" / #identifierId.
  const emailBox = page.locator('input[name="identifier"], #identifierId, input[type="email"], input[autocomplete="username"]').first();
  if (!(await emailBox.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false))) {
    await fail(page, 'Google: the sign-in page didn\'t show an email field');
  }
  await emailBox.fill(email);
  await clickFirst(page, ['#identifierNext button', '#identifierNext', 'button:has-text("Next")']);

  step('Google: password');
  const pw = page.locator('input[type="password"][name="Passwd"], input[type="password"]').first();
  const t0 = Date.now();
  while (!(await pw.isVisible().catch(() => false))) {
    const text = await bodyText(page);
    if (/Couldn.t find your Google Account/i.test(text)) await fail(page, 'Google: no Google account with this email');
    if (/captcha|Type the text you hear or see/i.test(text) || await page.locator('#captchaimg').isVisible().catch(() => false)) await fail(page, 'Google showed a captcha before the password');
    if (/This browser or app may not be secure/i.test(text)) await fail(page, 'Google blocked the sign-in ("This browser or app may not be secure")');
    if (Date.now() - t0 > 25000) await fail(page, 'Google: the password field didn\'t appear');
    await sleep(800);
  }
  await pw.fill(password);
  await clickFirst(page, ['#passwordNext button', '#passwordNext', 'button:has-text("Next")']);

  step('Google: approve access');
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    await sleep(1500);
    const url = page.url();
    if (!onGoogle(url)) { step('Google: done'); return; }
    const text = await bodyText(page);
    if (/Wrong password|Your password was changed/i.test(text)) await fail(page, 'Google: wrong password for this mailbox');
    // The password page itself is /challenge/pwd; any other challenge is a security check.
    if (/\/challenge\/(?!pwd)/.test(url) || /Verify it.s you|Confirm it.s you|2-Step Verification|Get a verification code/i.test(text)) {
      await fail(page, 'Google asked to verify it\'s you (2-Step Verification or a security check). Turn that off for this mailbox in the Admin console and retry');
    }
    if (/changepassword|\/speedbump\/changepassword/.test(url) || /Change password|Create a strong password/i.test(text)) {
      await fail(page, 'Google wants a new password set on first sign-in. Sign in once and set it (or turn off "ask for a password change"), update the mailbox password here, and retry');
    }
    if (/This account has been disabled|Account disabled/i.test(text)) await fail(page, 'Google: this account is disabled');
    if (/speedbump/.test(url) || /Welcome to your new account/i.test(text)) { await clickFirst(page, ['#confirm', 'input#confirm', 'button:has-text("I understand")', 'text=I understand']); continue; }
    if (/isn.t verified|hasn.t verified this app/i.test(text)) {
      await clickFirst(page, ['text=Advanced', 'button:has-text("Advanced")']);
      await sleep(500);
      await clickFirst(page, ['a:has-text("unsafe")', 'text=/Go to .*\\(unsafe\\)/']);
      continue;
    }
    if (/Choose an account/i.test(text) && text.includes(email)) { await clickFirst(page, [`[data-identifier="${email}"]`, `text=${email}`]); continue; }
    // Consent: tick every permission, then Continue / Allow.
    const boxes = page.locator('input[type="checkbox"]:not(:checked)');
    for (let i = 0, n = await boxes.count(); i < n; i += 1) await boxes.nth(0).check({ force: true }).catch(() => {});
    if (await clickFirst(page, ['button:has-text("Continue")', 'button:has-text("Allow")', '#submit_approve_access', 'text=/^(Continue|Allow)$/'])) continue;
  }
  await fail(page, 'Google: the sign-in didn\'t finish within 90 seconds');
}

// Same for Microsoft (Microsoft 365 / Outlook).
async function microsoft(page, email, password, step = () => {}) {
  step('Microsoft: email');
  await page.waitForLoadState('domcontentloaded');
  if (!onMicrosoft(page.url())) await page.waitForURL(onMicrosoft, { timeout: 30000 }).catch(() => {});
  await clickFirst(page, ['text=Use another account', '#otherTile']);
  const emailBox = page.locator('input[name="loginfmt"], input[type="email"]').first();
  if (!(await emailBox.waitFor({ timeout: 25000 }).then(() => true).catch(() => false))) await fail(page, 'Microsoft: the sign-in page didn\'t show an email field');
  await emailBox.fill(email);
  await clickFirst(page, ['#idSIButton9', 'input[type="submit"]', 'button:has-text("Next")']);

  step('Microsoft: password');
  const pw = page.locator('input[name="passwd"], input[type="password"]').first();
  const t0 = Date.now();
  while (!(await pw.isVisible().catch(() => false))) {
    const text = await bodyText(page);
    if (/doesn.t exist|We couldn.t find an account/i.test(text)) await fail(page, 'Microsoft has no account with this email. Check the mailbox type: this domain may be on Google');
    if (Date.now() - t0 > 25000) await fail(page, 'Microsoft: the password field didn\'t appear');
    await sleep(800);
  }
  await pw.fill(password);
  await clickFirst(page, ['#idSIButton9', 'input[type="submit"]', 'button:has-text("Sign in")']);

  step('Microsoft: approve access');
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    await sleep(1500);
    const url = page.url();
    if (!onMicrosoft(url)) { step('Microsoft: done'); return; }
    const text = await bodyText(page);
    if (/password is incorrect|account or password is incorrect/i.test(text)) await fail(page, 'Microsoft: wrong password for this mailbox');
    if (/couldn.t find an account|doesn.t exist/i.test(text)) await fail(page, 'Microsoft has no account with this email. Check the mailbox type: this domain may be on Google');
    if (/Update your password|password has expired/i.test(text)) await fail(page, 'Microsoft wants the password changed. Change it, update it here, and retry');
    if (/Approve sign in request|Enter code|Verify your identity|Authenticator/i.test(text)) await fail(page, 'Microsoft asked for MFA (Authenticator / code). Turn off MFA / Security defaults for this mailbox and retry');
    if (/Need admin approval|Approval required|requires admin approval/i.test(text)) await fail(page, 'Microsoft: the tenant admin must approve the sequencer\'s app (Entra ID → Enterprise applications → consent)');
    if (/Your account has been locked|account is locked|sign-in was blocked/i.test(text)) await fail(page, 'Microsoft: this account is locked or sign-in is blocked');
    if (/More information required|Let.s keep your account secure|Protect your account/i.test(text)) {
      if (await clickFirst(page, ['#btnAskLater', 'a:has-text("Skip setup")', 'text=Skip for now', 'a:has-text("Ask later")'])) continue;
      await fail(page, 'Microsoft requires MFA setup for this mailbox. Turn off Security defaults / MFA registration for it and retry');
    }
    if (/Pick an account/i.test(text) && text.toLowerCase().includes(email.toLowerCase())) { await clickFirst(page, [`[data-test-id="${email}"]`, `text=${email}`]); continue; }
    if (/Stay signed in\?/i.test(text)) { await clickFirst(page, ['#idBtn_Back', '#declineButton', 'button:has-text("No")', 'input[value="No"]']); continue; }
    if (/Permissions requested|wants to|Accept/i.test(text)) {
      const consent = page.locator('input[type="checkbox"]:not(:checked)');
      for (let i = 0, n = await consent.count(); i < n; i += 1) await consent.nth(0).check({ force: true }).catch(() => {});
      if (await clickFirst(page, ['#idSIButton9', 'input[value="Accept"]', 'button:has-text("Accept")'])) continue;
    }
    await clickFirst(page, ['#idSIButton9']);
  }
  await fail(page, 'Microsoft: the sign-in didn\'t finish within 90 seconds');
}

// Opens a sign-in link and signs in as the mailbox; returns where the
// browser ended up (the sequencer's page).
async function completeSignIn(page, url, provider, email, password, step) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (provider === 'google') await google(page, email, password, step);
  else await microsoft(page, email, password, step);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  return { url: page.url(), text: (await bodyText(page)).slice(0, 400) };
}

module.exports = { launch, newPage, diag, clickFirst, completeSignIn, google, microsoft, SignInError, sleep, bodyText, fail };

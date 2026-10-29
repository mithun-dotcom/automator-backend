'use strict';

// ------------------------------------------------------------------ utils

const $app = document.getElementById('app');

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    state.me = null;
    go('#/login');
    throw new Error(data.error || 'Please log in');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Turns URLs in already-escaped text into links.
const linkify = (html) => html.replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function fmtDate(d) {
  if (!d) return '—';
  const s = String(d);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', ...(s.length === 10 ? { timeZone: 'UTC' } : {}),
  });
}

function fmtWhen(ts) {
  return new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABEL = { pending: 'Pending', in_progress: 'Setting up', active: 'Active', cancelled: 'Cancelled', paid: 'Paid', unpaid: 'Unpaid', void: 'Void', overdue: 'Overdue' };
const badge = (s) => `<span class="badge b-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;

const TYPE_INFO = {
  google_workspace: 'Google Workspace mailboxes set up on your domains.',
  azure: 'Microsoft mailboxes provisioned through an Azure tenant.',
  m365_admin: 'Microsoft 365 mailboxes, with admin access to the tenant.',
  m365_non_admin: 'Microsoft 365 mailboxes, without tenant admin access.',
};

const ACCESS_LABEL = {
  delegate: 'I will add Mithmill as a delegate / team member at my registrar',
  registrar_login: 'I will share my registrar login with Mithmill',
  client_dns: 'I will update the DNS records myself',
};
const SEQUENCERS = ['Instantly', 'Smartlead', 'Lemlist', 'Reply.io', 'Other', 'None'];

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

const go = (hash) => { if (location.hash !== hash) location.hash = hash; else route(); };
const lines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// Disables the submit button while `fn` runs and shows errors under the form.
function onSubmit(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    const err = form.querySelector('.error:not(.csv-err)');
    if (err) err.textContent = '';
    if (btn) btn.disabled = true;
    try {
      await fn(formData(form));
    } catch (ex) {
      if (err) err.textContent = ex.message; else toast(ex.message);
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  });
}

// Onboarding CSV: same rules as the server (onboarding.js), checked on upload
// so the client sees problems straight away.
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function checkOnboardingCsv(text) {
  const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
  const all = parseCsv(text);
  if (all.length < 2) throw new Error('The CSV has no rows under the header. Add one row per mailbox user.');
  const header = all[0].map(norm);
  const col = (name) => header.indexOf(norm(name));
  const need = ['Domain name', 'Full name', 'Username'];
  const missing = need.filter((n) => col(n) === -1);
  if (missing.length) throw new Error(`The CSV is missing these columns: ${missing.join(', ')}. Please use the sample file.`);
  const rows = all.slice(1).map((r) => ({ domain: (r[col('Domain name')] || '').trim(), name: (r[col('Full name')] || '').trim(), user: (r[col('Username')] || '').trim() }));
  rows.forEach((r, i) => { if (!r.domain || !r.name || !r.user) throw new Error(`Row ${i + 2}: domain name, full name and username are required`); });
  const domains = [...new Set(rows.map((r) => r.domain.toLowerCase()))];
  return { users: rows.length, domains, usernames: rows.map((r) => `${r.name} - ${r.user}@${r.domain}`) };
}

function cancelNote() {
  return `<div class="note note-info"><span class="note-icon">✉️</span><div><strong>Need to cancel?</strong> ${esc(state.dash.cancelNote)}</div></div>`;
}

// Team members ("staff") get the admin panel too; the owner ("admin") also
// sees Team and Settings.
// Admins, team members and resellers all use the admin-style panel; a
// reseller's is limited to their own clients.
const isAdminRole = (r) => r === 'admin' || r === 'staff' || r === 'reseller';
const isOwner = () => state.me && state.me.role === 'admin';
const isReseller = () => state.me && state.me.role === 'reseller';
// Resellers use the same pages against their own, scoped API.
const API = () => (isReseller() ? '/api/reseller' : '/api/admin');

// ------------------------------------------------------------------ state + router

const state = { me: undefined, dash: null, admin: null, order: null };

async function route() {
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\/?/, '').split('/');

  if (parts[0] === 'invite' && parts[1]) return renderInvite(parts[1]);
  if (parts[0] === 'forgot') return renderForgot();

  if (state.me === undefined) {
    try { state.me = await api('GET', '/api/me'); } catch { state.me = null; }
  }
  if (!state.me) return renderLogin();
  setAdminTabs();
  if (parts[0] === 'login' || parts[0] === '') return go(isAdminRole(state.me.role) ? '#/admin' : '#/dashboard');

  try {
    if (parts[0] === 'password') return renderPassword();
    if (isAdminRole(state.me.role)) {
      if (parts[0] !== 'admin') return go('#/admin');
      return await renderAdmin(parts[1] || 'orders', parts[2], parts[3]);
    }
    if (parts[0] === 'admin') return go('#/dashboard');
    return await renderClient(parts[0], parts[1], parts[2]);
  } catch (ex) {
    $app.innerHTML = `<div class="boot">${esc(ex.message)}</div>`;
  }
}
window.addEventListener('hashchange', route);

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  order: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  billing: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  orders: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  clients: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  invoices: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  team: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/><path d="m17 3 1.5 1.5L21 2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-7"/>',
  reseller: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const NAV_ICONS = {
  '#/dashboard': 'dashboard', '#/order': 'order', '#/billing': 'billing', '#/notifications': 'bell',
  '#/admin/orders': 'orders', '#/admin/clients': 'clients', '#/admin/invoices': 'invoices', '#/admin/team': 'team', '#/admin/settings': 'settings', '#/admin/analytics': 'chart', '#/admin/resellers': 'reseller',
};

// Layout borrowed from the MithMill commission portal: navy sidebar with the
// nav and account, a sticky page header, and the page content. A page's
// `.page-head` (title, subtitle, actions) is lifted into the sticky header.
function shell(tabs, active, content) {
  const isClient = !isAdminRole(state.me.role);
  const unread = isClient && state.dash ? state.dash.notifications.filter((n) => !n.read_at).length : 0;
  const items = isClient ? [...tabs, ['#/notifications', 'Notifications']] : tabs;
  const current = active || (location.hash.startsWith('#/notifications') ? '#/notifications' : '');
  const nav = items.map(([href, label]) => `<a href="${href}" class="${href === current ? 'active' : ''}">${icon(NAV_ICONS[href])}<span class="label">${label}</span>${href === '#/notifications' && unread ? `<span class="sb-badge">${unread}</span>` : ''}</a>`).join('');
  const logo = (sub) => `<a class="sb-logo" href="#/"><img src="logo-mark-white.png" alt=""><div><div class="sb-name">MithMill</div><div class="sb-sub">${sub}</div></div></a>`;

  document.body.classList.remove('nav-open');
  $app.innerHTML = `
    <aside class="sidebar" aria-label="Main navigation">
      <div class="row" style="flex-wrap:nowrap">${logo(isClient ? 'Client Portal' : isReseller() ? 'Reseller Portal' : 'Admin Portal')}<button class="sb-close" id="nav-close" aria-label="Close menu">${icon('close')}</button></div>
      <div class="sb-sep"></div>
      <nav class="sb-nav">${nav}</nav>
      <div class="sb-user">
        <div class="avatar">${esc((state.me.name || state.me.email || '?').charAt(0).toUpperCase())}</div>
        <div class="sb-user-info"><div class="email" title="${esc(state.me.email)}">${esc(state.me.email)}</div><div class="role">${isClient ? esc(state.me.company || 'Client') : isOwner() ? 'Owner' : isReseller() ? 'Reseller' : 'Team member'}</div></div>
        <a class="sb-icon-btn" href="#/password" title="Change password" aria-label="Change password">${icon('key')}</a>
        <button class="sb-icon-btn" id="logout" title="Log out" aria-label="Log out">${icon('logout')}</button>
      </div>
    </aside>
    <div class="sb-backdrop" id="nav-backdrop"></div>
    <div class="mobilebar"><img src="logo-mark-white.png" alt="MithMill"><button id="nav-open" aria-label="Open menu">${icon('menu')}</button></div>
    <div class="content">
      <header class="header"><div class="header-inner" id="header-slot"></div></header>
      <main class="main">${content}</main>
    </div>`;

  const head = $app.querySelector('.main > .page-head');
  if (head) document.getElementById('header-slot').appendChild(head);
  document.getElementById('nav-open').onclick = () => document.body.classList.add('nav-open');
  document.getElementById('nav-close').onclick = () => document.body.classList.remove('nav-open');
  document.getElementById('nav-backdrop').onclick = () => document.body.classList.remove('nav-open');
  document.getElementById('logout').onclick = async () => {
    await api('POST', '/api/auth/logout');
    Object.assign(state, { me: null, dash: null, admin: null, order: null });
    go('#/login');
  };
}

function welcome(name, stats, eyebrow = 'Welcome back') {
  return `<div class="welcome">
    <div><div class="eyebrow">${esc(eyebrow)}</div><div class="name">${esc(name)}</div></div>
    <div class="wstats">${stats.map(([v, l]) => `<div class="wstat"><div class="wv">${v}</div><div class="wl">${esc(l)}</div></div>`).join('')}</div>
  </div>`;
}

// ------------------------------------------------------------------ auth pages

function authCard(inner) {
  $app.innerHTML = `<div class="auth"><div class="card"><div class="auth-logo"><img src="logo-full.png" alt="MithMill — From Cold to Gold: Email Strategies That Shine"></div>${inner}</div></div>`;
}

function renderLogin() {
  if (location.hash !== '#/login') history.replaceState(null, '', '#/login');
  authCard(`
    <h1>Client portal</h1>
    <p class="muted">Log in to see your mailboxes, billing and orders.</p>
    <form id="f">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
        <div class="hint" style="text-align:right"><a href="#/forgot">Forgot password?</a></div></div>
      <button class="btn btn-primary" style="width:100%" type="submit">Log in</button>
      <div class="error"></div>
    </form>
    <p class="muted small" style="margin:16px 0 0">Access is by invitation only. Need an account? Contact your Mithmill account manager.</p>`);
  onSubmit(document.getElementById('f'), async (d) => {
    const r = await api('POST', '/api/auth/login', d);
    state.me = await api('GET', '/api/me');
    go(isAdminRole(r.role) ? '#/admin' : '#/dashboard');
  });
}

function renderForgot() {
  authCard(`
    <h1>Forgot your password?</h1>
    <p class="muted">Enter the email you log in with and we'll send you a link to set a new password.</p>
    <form id="f">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <button class="btn btn-primary" style="width:100%" type="submit">Send reset link</button>
      <div class="error"></div>
    </form>
    <p class="muted small" style="margin:16px 0 0"><a href="#/login">← Back to login</a></p>`);
  onSubmit(document.getElementById('f'), async (d) => {
    await api('POST', '/api/auth/forgot', d);
    authCard(`
      <h1>Check your email</h1>
      <p class="muted">If <strong>${esc(d.email)}</strong> has an account, we've sent it a link to set a new password. The link works for 1 hour.</p>
      <p class="muted small">Nothing arrived after a few minutes? Check your spam folder, or contact your Mithmill account manager.</p>
      <a class="btn" href="#/login">Back to login</a>`);
  });
}

async function renderInvite(token) {
  authCard('<p class="muted" style="margin-top:16px">Checking your invite…</p>');
  let inv;
  try {
    inv = await api('GET', `/api/invites/${encodeURIComponent(token)}`);
  } catch (ex) {
    authCard(`<h1>Invite not valid</h1><p class="muted">${esc(ex.message)}</p><a class="btn" href="#/login">Go to login</a>`);
    return;
  }
  authCard(`
    <h1>${inv.reset ? 'Set a new password' : 'Welcome to Mithmill'}</h1>
    <p class="muted">${inv.reset ? 'Choose a new password for' : 'Create your password to activate your account for'} <strong>${esc(inv.email)}</strong>.</p>
    <form id="f">
      ${inv.reset ? '' : `<div class="field"><label for="name">Your name</label><input id="name" name="name" value="${esc(inv.name)}" autocomplete="name"></div>`}
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" minlength="8" autocomplete="new-password" required><div class="hint">At least 8 characters.</div></div>
      <button class="btn btn-primary" style="width:100%" type="submit">${inv.reset ? 'Save password' : 'Activate account'}</button>
      <div class="error"></div>
    </form>`);
  onSubmit(document.getElementById('f'), async (d) => {
    await api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, d);
    state.me = await api('GET', '/api/me');
    go(isAdminRole(state.me.role) ? '#/admin' : '#/dashboard');
  });
}

function renderPassword() {
  const tabs = isAdminRole(state.me.role) ? ADMIN_TABS : CLIENT_TABS;
  shell(tabs, '', `
    <div class="page-head"><div><h1>Change password</h1><p class="muted">${esc(state.me.email)}</p></div></div>
    <form class="card card-pad" id="pw" style="max-width:440px">
      <div class="field"><label for="current">Current password</label><input id="current" name="current" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="password">New password</label><input id="password" name="password" type="password" minlength="8" autocomplete="new-password" required><div class="hint">At least 8 characters.</div></div>
      <button class="btn btn-primary" type="submit">Save password</button>
      <div class="error"></div>
    </form>`);
  onSubmit(document.getElementById('pw'), async (d) => {
    await api('POST', '/api/auth/password', d);
    toast('Password changed');
    go(isAdminRole(state.me.role) ? '#/admin' : '#/dashboard');
  });
}

// ------------------------------------------------------------------ client

const CLIENT_TABS = [['#/dashboard', 'Dashboard'], ['#/order', 'New order'], ['#/billing', 'Billing']];

async function renderClient(page, arg, sub) {
  state.dash = await api('GET', '/api/dashboard');
  if (page === 'invoice' && arg) {
    renderInvoiceView(await api('GET', `/api/invoices/${encodeURIComponent(arg)}`), false);
    // "⬇ PDF": open the print dialog, where the client saves it as a PDF.
    if (sub === 'pdf') { history.replaceState(null, '', `#/invoice/${arg}`); setTimeout(() => window.print(), 300); }
    return;
  }
  if (page === 'order') return renderOrder();
  if (page === 'billing') return renderBilling();
  if (page === 'notifications') return renderNotifications();
  return renderDashboard();
}

function batchesTable(orders) {
  if (!orders.length) return '<div class="empty">No orders yet. Place your first order to get mailboxes set up.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Batch</th><th>Type</th><th class="num">Mailboxes</th><th>Status</th><th class="num">Amount</th><th>Next renewal</th><th>Ordered</th><th></th></tr></thead>
    <tbody>${orders.map((o) => `<tr>
      <td>${o.batch_name ? `<strong>${esc(o.batch_name)}</strong><div class="muted small">#${o.id}</div>` : `#${o.id}`}</td>
      <td>${esc(o.inbox_label)}<div class="muted small">${esc(lines(o.domains).slice(0, 2).join(', '))}${lines(o.domains).length > 2 ? '…' : ''}</div></td>
      <td class="num">${o.quantity}</td>
      <td>${badge(o.status)}</td>
      <td class="num">${o.status === 'cancelled' ? '<span class="muted">—</span>' : money(cycleAmount(o))}</td>
      <td>${o.status === 'active' ? fmtDate(o.next_billing_date) : '—'}</td>
      <td>${fmtDate(o.created_at)}</td>
      <td>${o.status !== 'cancelled' ? `<button class="btn btn-sm btn-danger" data-cancel="${o.id}">Cancel</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// Billing cycles: prices are per mailbox per month; a cycle is 1 (monthly),
// 12 (yearly) or any custom number of months.
const cycleOf = (o) => Math.max(1, Number(o.billing_months) || 1);
const cycleName = (n) => (n === 1 ? 'Monthly' : n === 12 ? 'Yearly' : `Every ${n} months`);
const perCycle = (n) => (n === 1 ? 'month' : n === 12 ? 'year' : `${n} months`);
const cycleAmount = (o) => o.quantity * o.price_per_mailbox * cycleOf(o);

function cycleFields(months = 1) {
  const kind = months === 1 ? 'monthly' : months === 12 ? 'yearly' : 'custom';
  return `<div class="field"><label>Billing cycle</label>
    <div class="row" style="flex-wrap:nowrap">
      <select name="billing_cycle" data-cycle>
        <option value="monthly" ${kind === 'monthly' ? 'selected' : ''}>Monthly</option>
        <option value="yearly" ${kind === 'yearly' ? 'selected' : ''}>Yearly</option>
        <option value="custom" ${kind === 'custom' ? 'selected' : ''}>Custom</option>
      </select>
      <span class="row" style="flex-wrap:nowrap;gap:6px" data-custom ${kind === 'custom' ? '' : 'hidden'}>every <input name="custom_months" type="number" min="1" max="36" value="${kind === 'custom' ? months : 3}" style="width:80px"> months</span>
    </div>
    <div class="hint">Renews on the same day every cycle. Invoices cover the whole cycle at the monthly price.</div></div>`;
}
function wireCycleFields(root) {
  root.querySelectorAll('[data-cycle]').forEach((sel) => {
    const custom = sel.parentElement.querySelector('[data-custom]');
    sel.addEventListener('change', () => { custom.hidden = sel.value !== 'custom'; });
  });
}
const cycleFromForm = (d) => (d.billing_cycle === 'yearly' ? 12 : d.billing_cycle === 'custom' ? Number(d.custom_months) || 1 : 1);

// Client-side twin of billing.nextBillingDate: same day of month, clamped.
function addMonths(d, day, months) {
  const [y, m] = d.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12); const nm = (total % 12) + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, dim)).padStart(2, '0')}`;
}

const batchTitle = (o) => (o.batch_name ? `${o.batch_name} (#${o.id})` : `Batch #${o.id}`);

// Clients cancel by emailing us from their registered address. This builds
// the pre-written request for one batch.
// Domains in a batch with how many mailboxes each has, counted from the
// usernames ("Name - user@domain"). Domains without a matching username
// still appear, just without a count.
function domainBreakdown(o) {
  const counts = new Map();
  lines(o.domains).forEach((d) => counts.set(d.toLowerCase(), 0));
  lines(o.usernames).forEach((u) => {
    const m = u.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
    if (m) { const d = m[1].toLowerCase(); counts.set(d, (counts.get(d) || 0) + 1); }
  });
  return [...counts.entries()];
}

function cancelEmail(o) {
  const { user, appUrl } = state.dash;
  const subject = `Cancellation request: ${batchTitle(o)}`;
  const domains = domainBreakdown(o);
  const domainLines = domains.length
    ? domains.map(([d, n]) => `- ${d}: ${o.inbox_label}${n ? `, ${n} mailbox${n === 1 ? '' : 'es'}` : ''}`)
    : ['- No domains on file for this batch'];
  const body = [
    'Hi Mithmill team,',
    '',
    'I would like to cancel all the inboxes from this order.',
    '',
    `Order name: ${batchTitle(o)} - ${o.inbox_label} (${o.quantity} mailboxes)`,
    ...(o.csv_rows ? [`CSV sheet link: ${appUrl}/api/admin/orders/${o.id}/onboarding.csv`] : []),
    `Order creation date: ${fmtDate(o.created_at)}`,
    `Payment amount: ${money(cycleAmount(o))}`,
    '',
    `Domains (${domains.length}):`,
    ...domainLines,
    '',
    'Thank you,',
    user.name || '',
    user.company || '',
    user.email,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  return { subject, body };
}

function openCancelDialog(order) {
  const { user, supportEmail } = state.dash;
  const { subject, body } = cancelEmail(order);
  const mailto = `mailto:${encodeURIComponent(supportEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = `
    <div class="modal-head"><h2>Cancel batch #${order.id}</h2><button class="btn btn-sm btn-ghost" data-close aria-label="Close">✕</button></div>
    <div class="note"><span class="note-icon">⚠️</span><div><strong>Please copy this email and send it from your registered email, ${esc(user.email)}, to <a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a>.</strong> Requests from other addresses can't be accepted. Your mailboxes stay active until we confirm the cancellation.</div></div>
    <div class="field" style="margin:16px 0 8px"><label>Subject</label><input readonly value="${esc(subject)}" id="cx-subject"></div>
    <div class="field"><label>Email</label><textarea readonly id="cx-body" rows="14" style="font-family:inherit">${esc(body)}</textarea></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn" data-close>Close</button>
      <a class="btn" href="${mailto}">Open in email app</a>
      <button class="btn btn-primary" id="cx-copy">Copy email</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => dlg.close(); });
  dlg.querySelector('#cx-copy').onclick = async () => {
    const text = `To: ${supportEmail}\nSubject: ${subject}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = dlg.querySelector('#cx-body'); ta.select(); document.execCommand('copy');
    }
    toast('Email copied. Paste it into a new email to ' + supportEmail);
  };
  dlg.showModal();
}

function renderDashboard() {
  const { stats, orders, user } = state.dash;
  shell(CLIENT_TABS, '#/dashboard', `
    <div class="page-head">
      <div><h1>Dashboard</h1><p class="muted">${esc(user.company || user.email)}${stats.nextRenewal ? ` · Next renewal ${fmtDate(stats.nextRenewal)}` : ''}</p></div>
      <a class="btn btn-primary" href="#/order">+ New order</a>
    </div>
    <div class="stack">
      ${welcome((user.name || user.company || 'there').split(' ')[0], [
        [stats.activeMailboxes, 'Active mailboxes'],
        [stats.pendingMailboxes, 'Being set up'],
        [money(stats.monthlyBilling), 'Monthly billing'],
        [money(stats.outstanding), `Outstanding · ${stats.unpaidInvoices} unpaid`],
      ])}
      <div class="card">
        <div class="card-head"><h2>Your batches</h2></div>
        ${batchesTable(orders)}
      </div>
      ${cancelNote()}
    </div>`);
  document.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = () => openCancelDialog(orders.find((o) => String(o.id) === b.dataset.cancel));
  });
}

function paymentNote() {
  return `<div class="note"><span class="note-icon">ℹ️</span><div><strong>Payment notice:</strong> ${esc(state.dash.paymentNote)}</div></div>`;
}

function renderBilling() {
  const { stats, invoices, orders, today } = state.dash;
  const active = orders.filter((o) => o.status === 'active').sort((a, b) => String(a.next_billing_date).localeCompare(b.next_billing_date));
  shell(CLIENT_TABS, '#/billing', `
    <div class="page-head"><div><h1>Billing</h1><p class="muted">Your monthly charges, renewals and invoices.</p></div></div>
    <div class="stack">
      ${paymentNote()}
      ${cancelNote()}
      <div class="stats">
        <div class="card stat"><div class="label">Monthly billing</div><div class="value">${money(stats.monthlyBilling)}</div></div>
        <div class="card stat"><div class="label">Outstanding</div><div class="value">${money(stats.outstanding)}</div></div>
        <div class="card stat"><div class="label">Unpaid invoices</div><div class="value">${stats.unpaidInvoices}</div></div>
        <div class="card stat"><div class="label">Next renewal</div><div class="value" style="font-size:22px">${fmtDate(stats.nextRenewal)}</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Upcoming renewals</h2><span class="muted small">Reminders are sent 7, 3 and 1 day before each renewal.</span></div>
        ${active.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Batch</th><th>Type</th><th class="num">Mailboxes</th><th>Renews on</th><th class="num">Amount</th></tr></thead>
          <tbody>${active.map((o) => `<tr><td>${esc(batchTitle(o))}</td><td>${esc(o.inbox_label)}</td><td class="num">${o.quantity}</td><td>${fmtDate(o.next_billing_date)}</td><td class="num">${money(cycleAmount(o))}</td></tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty">No active batches yet.</div>'}
      </div>
      <div class="card">
        <div class="card-head"><h2>Invoices</h2></div>
        ${invoices.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Invoice</th><th>Description</th><th>Date</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody>${invoices.map((i) => {
            const s = i.status === 'unpaid' && i.due_date < today ? 'overdue' : i.status;
            return `<tr><td><a href="#/invoice/${i.id}">#${i.id}</a></td><td>${esc(i.description)}</td><td>${fmtDate(i.issue_date || i.created_at)}${i.status === 'unpaid' ? `<div class="muted small">Due ${fmtDate(i.due_date)}</div>` : ''}</td><td>${badge(s)}${i.paid_at ? `<div class="muted small">${fmtDate(i.paid_at)}</div>` : ''}</td><td class="num">${money(i.amount)}</td><td><div class="row" style="flex-wrap:nowrap"><a class="btn btn-sm" href="#/invoice/${i.id}">View</a><a class="btn btn-sm" href="#/invoice/${i.id}/pdf" title="Download as PDF">⬇ PDF</a></div></td></tr>`;
          }).join('')}</tbody>
        </table></div>` : '<div class="empty">No invoices yet.</div>'}
      </div>
    </div>`);
}

async function renderNotifications() {
  const list = state.dash.notifications;
  shell(CLIENT_TABS, '', `
    <div class="page-head"><div><h1>Notifications</h1><p class="muted">Order updates, invoices and renewal reminders.</p></div></div>
    <div class="card">${list.length ? list.map((n) => `
      <div class="notif ${n.read_at ? '' : 'unread'}">
        <div class="row" style="justify-content:space-between"><h3>${esc(n.title)}</h3><span class="when">${fmtWhen(n.created_at)}</span></div>
        <div>${esc(n.body)}</div>
      </div>`).join('') : '<div class="empty">No notifications yet.</div>'}</div>`);
  if (list.some((n) => !n.read_at)) {
    await api('POST', '/api/notifications/read', {});
    list.forEach((n) => { n.read_at = n.read_at || new Date().toISOString(); });
    const dot = document.querySelector('.bell .dot');
    if (dot) dot.remove();
  }
}

// ---- order wizard: 1 type → 2 details → 3 review

function renderOrder() {
  if (!state.order) state.order = { step: 1, data: { quantity: '' } };
  const { step, data } = state.order;
  const pricing = state.dash.pricing;
  const price = pricing.find((p) => p.inbox_type === data.inbox_type);
  const stepper = ['Inbox type', 'Details', 'Review'].map((l, i) => `<div class="step ${i + 1 <= step ? 'on' : ''}"><span class="n">${i + 1}</span>${l}</div>`).join('');

  let body = '';
  if (step === 1) {
    body = `
      <div class="card card-pad">
        <h2 style="margin-bottom:14px">Which inbox type do you need?</h2>
        <div class="types">${pricing.map((p) => `
          <button type="button" class="type ${data.inbox_type === p.inbox_type ? 'sel' : ''}" data-type="${esc(p.inbox_type)}">
            <div class="t-name">${esc(p.label)}</div>
            <div class="t-price">${money(p.price_per_mailbox)} per mailbox / month</div>
            <div class="t-desc">${esc(p.description || TYPE_INFO[p.inbox_type] || '')}</div>
          </button>`).join('')}</div>
        <div class="row" style="justify-content:flex-end;margin-top:20px"><button class="btn btn-primary" id="next1" ${data.inbox_type ? '' : 'disabled'}>Continue</button></div>
      </div>`;
  } else if (step === 2) {
    const v = (k) => esc(data[k] || '');
    const sel = (k, val) => (data[k] === val ? 'selected' : '');
    body = `
      <form class="card card-pad" id="f2">
        <h2>${esc(price.label)} details</h2>
        <p class="muted small" style="margin:4px 0 16px">${money(price.price_per_mailbox)} per mailbox / month</p>

        <div class="csv-box">
          <div class="csv-head">
            <div><h3>Onboarding sheet (CSV)</h3>
              <div class="muted small">One row per mailbox user: domain, full name, username, passwords, domain and sequencer access, profile picture link and domain forward.
              ${state.dash.csvRequiredMin > 0 ? `<strong>Required for orders of ${state.dash.csvRequiredMin} or more mailboxes.</strong>` : ''}</div></div>
            <a class="btn btn-sm" href="/api/onboarding-template.csv" download>⬇ Download sample CSV</a>
          </div>
          <div class="row">
            <label class="btn btn-sm btn-primary file-btn">⬆ Upload filled CSV<input type="file" id="csv-file" accept=".csv,text/csv" hidden></label>
            <span class="small" id="csv-status">${data.onboarding_filename ? `✅ ${esc(data.onboarding_filename)}: ${data.csv_users} users across ${data.csv_domains} domain${data.csv_domains === 1 ? '' : 's'} <button type="button" class="btn btn-sm btn-ghost" id="csv-remove">Remove</button>` : '<span class="muted">No file uploaded</span>'}</span>
          </div>
          <div class="error csv-err" id="csv-error" role="alert"></div>
        </div>

        <div class="grid-2">
          <div class="field"><label for="quantity">Number of mailboxes</label><input id="quantity" name="quantity" type="number" min="1" max="10000" required value="${v('quantity')}"></div>
          <div class="field"><label>Estimated monthly cost</label><input id="est" disabled value="${money((Number(data.quantity) || 0) * price.price_per_mailbox)}"></div>
        </div>

        <div class="grid-2">
          <div class="field"><label for="domains">Domain names</label><textarea id="domains" name="domains" placeholder="acme-mail.com&#10;getacme.co">${v('domains')}</textarea><div class="hint">One domain per line.${data.onboarding_csv ? ' Filled in from your CSV.' : ''}</div></div>
          <div class="field"><label for="usernames">Usernames</label><textarea id="usernames" name="usernames" placeholder="John Smith - john&#10;Jane Doe - jane.doe">${v('usernames')}</textarea><div class="hint">One per line: full name and the part before the @.</div></div>
        </div>

        <h3 class="section-title">Domain access</h3>
        <div class="field"><label for="domain_access_method">How will we get access to your domains?</label>
          <select id="domain_access_method" name="domain_access_method" required>
            <option value="">Choose…</option>
            ${Object.entries(ACCESS_LABEL).map(([k, l]) => `<option value="${k}" ${sel('domain_access_method', k)}>${esc(l)}</option>`).join('')}
          </select></div>
        <div class="grid-2">
          <div class="field"><label for="registrar">Domain registrar / DNS provider</label><input id="registrar" name="registrar" placeholder="GoDaddy, Namecheap, Cloudflare…" value="${v('registrar')}"></div>
          <div class="field"><label for="registrar_email">Registrar account email</label><input id="registrar_email" name="registrar_email" type="email" value="${v('registrar_email')}"></div>
        </div>
        <div class="field"><label for="domain_access_notes">Domain access notes</label><textarea id="domain_access_notes" name="domain_access_notes" style="min-height:64px">${v('domain_access_notes')}</textarea>
          <div class="hint">Please don't paste passwords here. If you're sharing a login, we'll contact you to collect it securely.</div></div>

        <h3 class="section-title">Sequencer access</h3>
        <div class="grid-2">
          <div class="field"><label for="sequencer">Sequencer</label>
            <select id="sequencer" name="sequencer" required>
              <option value="">Choose…</option>
              ${SEQUENCERS.map((s) => `<option ${sel('sequencer', s)}>${s}</option>`).join('')}
            </select></div>
          <div class="field"><label for="sequencer_workspace">Workspace name</label><input id="sequencer_workspace" name="sequencer_workspace" value="${v('sequencer_workspace')}"></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="sequencer_email">Sequencer login email</label><input id="sequencer_email" name="sequencer_email" type="email" value="${v('sequencer_email')}"></div>
          <div class="field"><label for="sequencer_notes">Sequencer access notes</label><input id="sequencer_notes" name="sequencer_notes" placeholder="e.g. invite us as a team member" value="${v('sequencer_notes')}"></div>
        </div>

        <div class="field"><label for="notes">Anything else?</label><textarea id="notes" name="notes" style="min-height:64px">${v('notes')}</textarea></div>
        <div class="row" style="justify-content:space-between"><button type="button" class="btn" id="back2">Back</button><button class="btn btn-primary" type="submit">Review order</button></div>
        <div class="error"></div>
      </form>`;
  } else {
    const row = (k, val) => (val ? `<dt>${k}</dt><dd>${esc(val)}</dd>` : '');
    body = `
      <div class="stack">
        <div class="card review">
          <div class="card-head"><h2>Review your order</h2><button class="btn btn-sm" id="edit3">Edit</button></div>
          <div class="card-pad"><dl>
            ${row('Inbox type', price.label)}
            ${row('Mailboxes', String(data.quantity))}
            ${row('Onboarding CSV', data.onboarding_filename ? `${data.onboarding_filename} (${data.csv_users} users)` : '')}
            ${row('Domains', lines(data.domains).join('\n'))}
            ${row('Usernames', lines(data.usernames).join('\n'))}
            ${row('Domain access', ACCESS_LABEL[data.domain_access_method])}
            ${row('Registrar', data.registrar)}
            ${row('Registrar email', data.registrar_email)}
            ${row('Domain access notes', data.domain_access_notes)}
            ${row('Sequencer', data.sequencer)}
            ${row('Workspace', data.sequencer_workspace)}
            ${row('Sequencer email', data.sequencer_email)}
            ${row('Sequencer notes', data.sequencer_notes)}
            ${row('Notes', data.notes)}
          </dl></div>
          <div class="total"><span>${data.quantity} × ${money(price.price_per_mailbox)} per month</span><span class="amt">${money(data.quantity * price.price_per_mailbox)}/mo</span></div>
        </div>
        ${paymentNote()}
        <div class="row" style="justify-content:space-between"><button class="btn" id="back3">Back</button><button class="btn btn-primary" id="place">Place order</button></div>
        <div class="error" id="err3"></div>
      </div>`;
  }

  shell(CLIENT_TABS, '#/order', `
    <div class="page-head"><div><h1>New order</h1><p class="muted">Order mailboxes in three quick steps.</p></div></div>
    <div class="steps">${stepper}</div>
    ${body}`);

  if (step === 1) {
    document.querySelectorAll('.type').forEach((b) => {
      b.onclick = () => { data.inbox_type = b.dataset.type; renderOrder(); };
    });
    document.getElementById('next1').onclick = () => { state.order.step = 2; renderOrder(); };
  } else if (step === 2) {
    const form = document.getElementById('f2');
    const save = () => Object.assign(data, formData(form));
    form.querySelector('#quantity').oninput = (e) => {
      form.querySelector('#est').value = money((Number(e.target.value) || 0) * price.price_per_mailbox);
    };
    document.getElementById('back2').onclick = () => { save(); state.order.step = 1; renderOrder(); };
    document.getElementById('csv-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const errEl = document.getElementById('csv-error');
      errEl.textContent = '';
      try {
        if (file.size > 4 * 1024 * 1024) throw new Error('The CSV is larger than 4 MB');
        const text = await file.text();
        const info = checkOnboardingCsv(text);
        save();
        Object.assign(data, {
          onboarding_csv: text, onboarding_filename: file.name, csv_users: info.users, csv_domains: info.domains.length,
          quantity: String(info.users),
          domains: lines(data.domains).length ? data.domains : info.domains.join('\n'),
          usernames: lines(data.usernames).length ? data.usernames : info.usernames.join('\n'),
        });
        renderOrder();
        toast(`CSV loaded: ${info.users} users`);
      } catch (ex) {
        errEl.textContent = ex.message;
        e.target.value = '';
      }
    };
    const removeBtn = document.getElementById('csv-remove');
    if (removeBtn) {
      removeBtn.onclick = () => {
        save();
        ['onboarding_csv', 'onboarding_filename', 'csv_users', 'csv_domains'].forEach((k) => delete data[k]);
        renderOrder();
      };
    }
    onSubmit(form, async (d) => {
      Object.assign(data, d);
      const min = state.dash.csvRequiredMin;
      if (min > 0 && Number(d.quantity) >= min && !data.onboarding_csv) {
        throw new Error(`Orders of ${min} or more mailboxes need the onboarding CSV. Download the sample, fill it in and upload it above.`);
      }
      if (data.onboarding_csv && Number(d.quantity) !== data.csv_users) {
        throw new Error(`Your CSV has ${data.csv_users} users but the order is for ${d.quantity} mailboxes. Make them match (one CSV row per mailbox).`);
      }
      if (!data.onboarding_csv && !lines(d.domains).length) throw new Error('Add at least one domain');
      if (!data.onboarding_csv && !lines(d.usernames).length) throw new Error('Add at least one username');
      state.order.step = 3;
      renderOrder();
      window.scrollTo(0, 0);
    });
  } else {
    document.getElementById('back3').onclick = () => { state.order.step = 2; renderOrder(); };
    document.getElementById('edit3').onclick = () => { state.order.step = 2; renderOrder(); };
    document.getElementById('place').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('POST', '/api/orders', data);
        state.order = null;
        toast(`Order #${r.id} placed. We'll notify you when it's active.`);
        go('#/dashboard');
      } catch (ex) {
        document.getElementById('err3').textContent = ex.message;
        e.target.disabled = false;
      }
    };
  }
}

// ------------------------------------------------------------------ admin

const ADMIN_TABS = [];
function setAdminTabs() {
  ADMIN_TABS.length = 0;
  if (isReseller()) {
    ADMIN_TABS.push(['#/admin/orders', 'Batches'], ['#/admin/clients', 'Clients'], ['#/admin/invoices', 'Invoices'], ['#/admin/settings', 'Settings']);
    return;
  }
  ADMIN_TABS.push(['#/admin/orders', 'Orders'], ['#/admin/clients', 'Clients & invites'], ['#/admin/invoices', 'Invoices']);
  if (isOwner()) ADMIN_TABS.unshift(['#/admin/analytics', 'Analytics']);
  if (isOwner()) ADMIN_TABS.push(['#/admin/resellers', 'Resellers'], ['#/admin/team', 'Team'], ['#/admin/settings', 'Settings']);
}

async function renderAdmin(page, arg, sub) {
  const raw = await api('GET', `${API()}/overview`);
  // The owner's main pages leave out resellers' clients; they're on the Resellers page.
  const direct = (rows) => rows.filter((r) => !r.reseller_id);
  state.admin = isOwner() && page !== 'invoice'
    ? { ...raw, orders: direct(raw.orders), clients: direct(raw.clients), invoices: direct(raw.invoices) } : raw;
  if (isReseller()) {
    if (page === 'settings') return resellerSettings(await api('GET', '/api/reseller/settings'));
    if (['team', 'analytics', 'resellers'].includes(page)) return go('#/admin/orders');
  }
  if (page === 'resellers') {
    if (!isOwner()) return go('#/admin/orders');
    return arg ? renderResellerDetail(await api('GET', `/api/admin/resellers/${encodeURIComponent(arg)}`))
      : renderResellers(await api('GET', '/api/admin/resellers'));
  }
  if (page === 'invoice') {
    if (arg === 'new') return invoiceEditor(null);
    const inv = await api('GET', `${API()}/invoices/${encodeURIComponent(arg)}`);
    return sub === 'edit' ? invoiceEditor(inv) : renderInvoiceView(inv, true);
  }
  if (page === 'team' && isOwner()) return renderTeam(await api('GET', `${API()}/team`));
  if (page === 'analytics') return isOwner() ? renderAnalytics(await api('GET', `${API()}/analytics`)) : go('#/admin/orders');
  if (page === 'settings' && !isOwner()) return go('#/admin/orders');
  const pages = { orders: adminOrders, clients: isReseller() ? resellerClients : adminClients, invoices: adminInvoices, settings: adminSettings };
  if (page === 'orders' && arg) return adminOrders(Number(arg));
  (pages[page] || adminOrders)();
}

const reloadAdmin = () => route();

// Admin-only: what renews in the next 30 days, with cycle, amount and whether
// the renewal invoice is paid. (Renewal invoices are issued 7 days ahead.)
function upcomingRenewalsCard(orders, invoices, today) {
  const days = (d) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const rows = orders
    .filter((o) => o.status === 'active' && o.next_billing_date && days(o.next_billing_date) <= 30)
    .sort((a, b) => a.next_billing_date.localeCompare(b.next_billing_date));
  const invoiceFor = (o) => invoices.find((i) => i.order_id === o.id && i.period_start === o.next_billing_date && i.status !== 'void');
  return `<div class="card">
    <div class="card-head"><div><h2>Upcoming renewals</h2><div class="muted small">Next 30 days · clients are reminded 7, 3 and 1 day before</div></div>
      <span class="muted small">${rows.length} batch${rows.length === 1 ? '' : 'es'} · ${money(rows.reduce((n, o) => n + cycleAmount(o), 0))}</span></div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Renews</th><th>Client</th><th>Batch</th><th>Cycle</th><th class="num">Amount</th><th>Invoice</th></tr></thead>
      <tbody>${rows.map((o) => {
        const d = days(o.next_billing_date);
        const inv = invoiceFor(o);
        return `<tr>
          <td><strong>${fmtDate(o.next_billing_date)}</strong><div class="muted small">${d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`}</div></td>
          <td>${esc(o.company || o.name || o.email)}<div class="muted small">${esc(o.email)}</div></td>
          <td>${esc(batchTitle(o))}<div class="muted small">${o.quantity} × ${esc(o.inbox_label)}</div></td>
          <td>${cycleName(cycleOf(o))}</td>
          <td class="num">${money(cycleAmount(o))}</td>
          <td>${inv ? `<a href="#/admin/invoice/${inv.id}">${badge(inv.status)}</a>` : '<span class="muted small">Issued 7 days before</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table></div>` : '<div class="empty">Nothing renews in the next 30 days.</div>'}
  </div>`;
}

// focusId: open that batch (from a link like #/admin/orders/12), with its
// domains box ready to edit.
function adminOrders(focusId) {
  const { orders } = state.admin;
  const filter = focusId ? 'all' : sessionStorage.getItem('orderFilter') || (isReseller() ? 'active' : 'open');
  const shown = orders.filter((o) => (filter === 'all' ? true
    : filter === 'open' ? ['pending', 'in_progress'].includes(o.status) : o.status === filter));
  const counts = (s) => orders.filter((o) => (s === 'open' ? ['pending', 'in_progress'].includes(o.status) : s === 'all' || o.status === s)).length;
  const kv = (k, v) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '');

  shell(ADMIN_TABS, '#/admin/orders', `
    <div class="page-head">
      ${isReseller() ? '<div><h1>Batches</h1><p class="muted">Your clients\' mailboxes. Add a batch for a client; renewal invoices and the 7, 3 and 1-day reminders then go out automatically.</p></div>'
        : '<div><h1>Orders</h1><p class="muted">Open an order and click ✓ Mark as completed once its mailboxes are delivered. That activates them for the client and creates the first invoice.</p></div>'}
      <div class="row"><button class="btn btn-sm btn-primary" id="add-batch">+ Add batch</button>${[['open', 'To do'], ['active', 'Active'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([k, l]) => `<button class="btn btn-sm ${filter === k ? 'btn-primary' : ''}" data-filter="${k}">${l} (${counts(k)})</button>`).join('')}</div>
    </div>
    <div class="stack">
    ${(() => {
      const active = orders.filter((o) => o.status === 'active');
      const unpaid = state.admin.invoices.filter((i) => i.status === 'unpaid');
      return welcome((state.me.name || (isReseller() ? 'there' : 'Admin')).split(' ')[0], [
        isReseller() ? [state.admin.clients.length, 'Clients'] : [counts('open'), 'Orders to do'],
        [active.reduce((n, o) => n + o.quantity, 0), 'Active mailboxes'],
        [money(active.reduce((n, o) => n + o.quantity * o.price_per_mailbox, 0)), 'Monthly revenue'],
        [money(unpaid.reduce((n, i) => n + i.amount, 0)), `Unpaid · ${unpaid.length} invoice${unpaid.length === 1 ? '' : 's'}`],
      ]);
    })()}
    ${upcomingRenewalsCard(orders, state.admin.invoices, state.admin.today)}
    <div class="card">
      ${shown.length ? shown.map((o) => `
      <details class="order" id="order-${o.id}" ${o.id === focusId ? 'open' : ''}>
        <summary>
          <strong>#${o.id}</strong>
          <span>${esc(o.company || o.name || o.email)}<div class="muted small">${o.batch_name ? `${esc(o.batch_name)} · ` : ''}${esc(o.email)}${o.seller ? ` · Sold by ${esc(o.seller)}` : ''}</div></span>
          <span class="hide-sm">${esc(o.inbox_label)}</span>
          <span class="hide-sm num">${o.quantity} boxes</span>
          <span class="hide-sm">${o.status === 'active' && o.next_billing_date ? `${fmtDate(o.next_billing_date)}<div class="muted small">${cycleName(cycleOf(o))}</div>` : `<span class="muted small">Ordered</span> ${fmtDate(o.created_at)}`}</span>
          <span>${badge(o.status)}</span>
        </summary>
        <div class="order-body">
          <div class="stack" style="gap:14px">
            ${o.domains ? `<div><h3>Domains</h3><pre>${esc(o.domains)}</pre></div>` : ''}
            ${o.usernames ? `<div><h3>Usernames</h3><pre>${esc(o.usernames)}</pre></div>` : ''}
            <dl class="kv">
              ${kv('Type', o.inbox_label)}
              ${o.seller ? kv('Sold by', `${o.seller} (set on the client)`) : ''}
              ${kv('Mailboxes', String(o.quantity))}
              ${kv('Price', `${money(o.price_per_mailbox)} / mailbox / month → ${money(cycleAmount(o))} per ${perCycle(cycleOf(o))}`)}
              ${kv('Billing', `${cycleName(cycleOf(o))}${o.status === 'active' && o.next_billing_date ? `, next renewal ${fmtDate(o.next_billing_date)}` : ''}`)}
              ${kv('Domain access', ACCESS_LABEL[o.domain_access_method] || o.domain_access_method)}
              ${kv('Registrar', o.registrar)}
              ${kv('Registrar email', o.registrar_email)}
              ${kv('Access notes', o.domain_access_notes)}
              ${kv('Sequencer', o.sequencer)}
              ${kv('Workspace', o.sequencer_workspace)}
              ${kv('Sequencer email', o.sequencer_email)}
              ${kv('Sequencer notes', o.sequencer_notes)}
              ${kv('Client notes', o.notes)}
            </dl>
            ${isReseller() ? '' : o.csv_rows ? `<div><a class="btn btn-primary btn-sm" href="/api/admin/orders/${o.id}/onboarding.csv">⬇ Download onboarding CSV (${o.csv_rows} rows)</a></div>` : '<div class="muted small">No onboarding CSV uploaded.</div>'}
          </div>
          <form class="order-form" data-id="${o.id}">
            ${['pending', 'in_progress'].includes(o.status) ? `<div class="complete-box">
              <button type="button" class="btn btn-success" data-complete="${o.id}">✓ Mark as completed</button>
              <div class="hint">Use this once the mailboxes are delivered. It activates them for the client, creates the first invoice (${money(cycleAmount(o))} for ${perCycle(cycleOf(o)) === 'month' ? 'the first month' : `the first ${perCycle(cycleOf(o))}`}), starts the ${cycleName(cycleOf(o)).toLowerCase()} renewals from today and notifies the client.</div>
            </div>` : ''}
            <div class="field"><label>Status</label>
              <select name="status">${['pending', 'in_progress', 'active', 'cancelled'].map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s === 'active' ? 'Active (completed)' : STATUS_LABEL[s]}</option>`).join('')}</select>
              ${o.activated_at ? '' : '<div class="hint">Activating creates the first month\'s invoice and sets the renewal date one month from today.</div>'}
            </div>
            <div class="grid-2">
              <div class="field"><label>Mailboxes</label><input type="number" name="quantity" min="1" max="10000" required value="${o.quantity}"></div>
              <div class="field"><label>Price per mailbox ($)</label><input type="number" name="price_per_mailbox" step="0.01" min="0" required value="${o.price_per_mailbox}"></div>
            </div>
            ${o.status !== 'cancelled' ? cycleFields(cycleOf(o)) : ''}
            <div class="grid-2">
              <div class="field"><label>Domains</label><textarea name="domains" style="min-height:80px" placeholder="One per line">${esc(o.domains)}</textarea></div>
              <div class="field"><label>Usernames</label><textarea name="usernames" style="min-height:80px" placeholder="Name - user@domain.com">${esc(o.usernames)}</textarea></div>
            </div>
            <div class="hint" style="margin:-8px 0 14px">Shown to the client and listed per domain in their cancellation email. Use "Name - user@domain.com" so mailboxes are counted per domain.</div>
            <div class="field"><label>Batch name</label><input name="batch_name" value="${esc(o.batch_name || '')}" placeholder="e.g. Q4 outreach"></div>
            <div class="field"><label>Internal notes</label><textarea name="admin_notes" style="min-height:64px">${esc(o.admin_notes)}</textarea></div>
            <div class="row" style="justify-content:space-between">
              <button class="btn btn-primary" type="submit">Save</button>
              <div class="row">
                ${o.status === 'active' ? `<button type="button" class="btn" data-history="${o.id}">Add past invoices</button>` : ''}
                ${o.status !== 'cancelled' ? `<button type="button" class="btn btn-danger" data-cancel-sub="${o.id}">Cancel subscription</button>` : ''}
                <button type="button" class="btn btn-ghost" data-delete-batch="${o.id}">Delete batch</button>
              </div>
            </div>
            <div class="error"></div>
          </form>
        </div>
      </details>`).join('') : '<div class="empty">Nothing here.</div>'}
    </div>
    </div>`);

  document.getElementById('add-batch').onclick = () => openBatchDialog();
  if (focusId) {
    const el = document.getElementById(`order-${focusId}`);
    if (el) {
      el.scrollIntoView({ block: 'start' });
      const domains = el.querySelector('textarea[name=domains]');
      if (domains) domains.focus({ preventScroll: true });
    }
  }
  document.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => { sessionStorage.setItem('orderFilter', b.dataset.filter); adminOrders(); };
  });
  wireCycleFields(document);
  document.querySelectorAll('.order-form').forEach((form) => {
    onSubmit(form, async (d) => {
      const body = { status: d.status, admin_notes: d.admin_notes, batch_name: d.batch_name, domains: d.domains, usernames: d.usernames, quantity: Number(d.quantity), price_per_mailbox: d.price_per_mailbox };
      if (d.billing_cycle) Object.assign(body, { billing_cycle: d.billing_cycle, custom_months: d.custom_months });
      const r = await api('PATCH', `${API()}/orders/${form.dataset.id}`, body);
      toast(r.invoiceId ? `Order #${form.dataset.id} completed. Invoice #${r.invoiceId} created.` : `Order #${form.dataset.id} saved`);
      reloadAdmin();
    });
  });
  document.querySelectorAll('[data-history]').forEach((b) => {
    b.onclick = async () => {
      const o = orders.find((x) => String(x.id) === b.dataset.history);
      const since = prompt(`Add the missing invoices for ${batchTitle(o)}, one per billing period, marked paid, so the client's portal shows their full history.\n\n` +
        'Since which date did this client start? (YYYY-MM-DD)', String(o.activated_at || o.created_at).slice(0, 10));
      if (since === null) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since.trim())) return toast('Enter the date as YYYY-MM-DD');
      try {
        const r = await api('POST', `${API()}/orders/${o.id}/history`, { from: since.trim() });
        toast(r.created ? `${r.created} past invoice${r.created === 1 ? '' : 's'} added (marked paid)` : 'Nothing missing: every past period already has an invoice');
        reloadAdmin();
      } catch (ex) { toast(ex.message); }
    };
  });
  document.querySelectorAll('[data-cancel-sub]').forEach((b) => {
    b.onclick = async () => {
      const o = orders.find((x) => String(x.id) === b.dataset.cancelSub);
      openCancelSubDialog({ orders: [o], url: `${API()}/orders/${o.id}/cancel` });
    };
  });
  document.querySelectorAll('[data-delete-batch]').forEach((b) => {
    b.onclick = async () => {
      const o = orders.find((x) => String(x.id) === b.dataset.deleteBatch);
      if (!confirm(`Delete ${batchTitle(o)} (${o.company || o.email}) permanently?\n\nUse this for batches added by mistake. Its unpaid invoices are voided; paid invoices stay as history. To end a real subscription, use Cancel subscription instead.`)) return;
      try {
        await api('DELETE', `${API()}/orders/${o.id}`);
        toast(`${batchTitle(o)} deleted`);
        reloadAdmin();
      } catch (ex) { toast(ex.message); }
    };
  });
  document.querySelectorAll('[data-complete]').forEach((b) => {
    b.onclick = async () => {
      const form = b.closest('form');
      const d = formData(form);
      const id = b.dataset.complete;
      const total = money(Number(d.quantity) * Number(d.price_per_mailbox) * cycleFromForm(d));
      if (!confirm(`Mark order #${id} as completed?\n\nThis activates the mailboxes for the client, creates the first month's invoice (${total}) and sends them a notification.`)) return;
      b.disabled = true;
      try {
        const r = await api('PATCH', `${API()}/orders/${id}`, {
          status: 'active', admin_notes: d.admin_notes, quantity: Number(d.quantity), price_per_mailbox: d.price_per_mailbox,
          billing_cycle: d.billing_cycle, custom_months: d.custom_months,
        });
        toast(r.invoiceId ? `Order #${id} completed. Invoice #${r.invoiceId} created — see Invoices.` : `Order #${id} completed`);
        reloadAdmin();
      } catch (ex) {
        toast(ex.message);
        b.disabled = false;
      }
    };
  });
}


// Cancel a subscription (one batch, or an invoice's batches) with a reason.
// The client gets an email worded for it: a thank-you when they asked, or a
// note that the payment never came after several follow-ups.
const CANCEL_REASONS = [
  ['requested', 'Requested by client', 'Thanks them for choosing us and says we hope to see them again soon.'],
  ['no_payment', 'No payment made', 'Says the subscription was cancelled because the payment didn\'t arrive after multiple follow-ups.'],
  ['other', 'Other reason', 'Your reason is included in the email.'],
];
function openCancelSubDialog({ orders, url, invoice }) {
  const who = orders[0].company || orders[0].name || orders[0].email;
  const unpaidInvoice = invoice && invoice.status === 'unpaid';
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = `<form id="cx-form">
    <div class="modal-head"><h2>Cancel subscription</h2><button type="button" class="btn btn-sm btn-ghost" data-close aria-label="Close">✕</button></div>
    <p class="muted small" style="margin:-6px 0 14px">${esc(who)} · ${esc(orders[0].email)}</p>
    ${orders.length > 1 ? `<div class="field"><label>Batches to cancel</label>${orders.map((o) => `<label class="check"><input type="checkbox" name="order_ids" value="${o.id}" checked> ${esc(batchTitle(o))} · ${o.quantity} × ${esc(o.inbox_label)}</label>`).join('')}</div>`
      : `<div class="note note-info" style="margin-bottom:14px"><div><strong>${esc(batchTitle(orders[0]))}</strong> · ${orders[0].quantity} × ${esc(orders[0].inbox_label)} · ${money(cycleAmount(orders[0]))} per ${perCycle(cycleOf(orders[0]))}</div></div>`}
    <div class="field"><label>Reason</label>
      <div class="reason-list">${CANCEL_REASONS.map(([v, l, h], i) => `<label class="reason"><input type="radio" name="reason" value="${v}" ${i === 0 ? 'checked' : ''}><span><strong>${l}</strong><span class="muted small">${h}</span></span></label>`).join('')}</div></div>
    <div class="field"><label id="cx-note-label">Note for the client (optional)</label><textarea name="note" style="min-height:70px" placeholder="Added to the email"></textarea></div>
    ${unpaidInvoice ? `<label class="check" style="margin-bottom:10px"><input type="checkbox" name="void_invoice" ${invoice.due_date < state.admin.today ? 'checked' : ''}> Also void invoice #${invoice.id} (${money(invoice.amount)}, unpaid)</label>` : ''}
    <label class="check" style="margin-bottom:14px"><input type="checkbox" name="notify" checked> Email the client about the cancellation</label>
    <p class="muted small" style="margin:0 0 14px">The subscription stops renewing, its upcoming unpaid invoices are voided, and it no longer counts on the client's dashboard.</p>
    <div class="error"></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Keep subscription</button><button class="btn btn-danger-solid" type="submit">Cancel subscription</button></div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => dlg.close(); });
  const f = dlg.querySelector('form');
  const sync = () => {
    const other = f.reason.value === 'other';
    dlg.querySelector('#cx-note-label').textContent = other ? 'Reason (shown to the client)' : 'Note for the client (optional)';
    f.note.required = other;
    if (f.void_invoice && f.reason.value === 'no_payment') f.void_invoice.checked = true;
  };
  f.addEventListener('change', (e) => { if (e.target.name === 'reason') sync(); });
  sync();
  onSubmit(f, async () => {
    const ids = [...f.querySelectorAll('input[name=order_ids]:checked')].map((x) => Number(x.value));
    if (orders.length > 1 && !ids.length) throw new Error('Choose at least one batch');
    const r = await api('POST', url, {
      reason: f.reason.value, note: f.note.value, notify: f.notify.checked,
      ...(orders.length > 1 ? { order_ids: ids } : {}), ...(f.void_invoice ? { void_invoice: f.void_invoice.checked } : {}),
    });
    dlg.close();
    toast(`Subscription cancelled${r.emailed ? ` · email sent to ${r.to}` : ''}`);
    reloadAdmin();
  });
  dlg.showModal();
}

// Add a batch on a client's behalf: an existing purchase with its billing
// dates, or an order taken outside the portal.
// "Sold by" (who gets the commission): admin-only, suggests team members' names.
function soldByField(value, attrs = 'name="sold_by"') {
  const names = (state.admin && state.admin.sellers) || [];
  return `<div class="field"><label>Sold by <span class="muted small">(admin only, not shown to the client)</span></label>
    <input ${attrs} list="sellers-list" value="${esc(value || '')}" placeholder="Team member who brought in this client" maxlength="100">
    <div class="hint">They get the commission on all of this client's batches, invoices and renewals.</div>
    <datalist id="sellers-list">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>`;
}

function openBatchDialog(userId) {
  const { clients, pricing, clientPricing, today } = state.admin;
  const priceFor = (uid, type) => {
    const own = clientPricing.find((cp) => String(cp.user_id) === String(uid) && cp.inbox_type === type);
    const std = pricing.find((p) => p.inbox_type === type);
    return own ? own.price_per_mailbox : std ? std.price_per_mailbox : '';
  };
  const dlg = document.createElement('dialog');
  dlg.className = 'modal modal-wide';
  dlg.innerHTML = `
    <form id="batch-form">
      <div class="modal-head"><h2>Add batch</h2><button type="button" class="btn btn-sm btn-ghost" data-close aria-label="Close">✕</button></div>
      <p class="muted small" style="margin:-6px 0 16px">${isReseller() ? 'Mailboxes for one of your clients. Renewal invoices and reminders are sent to the client automatically.' : 'For mailboxes a client already has with you, or an order taken outside the portal. The client sees it as soon as they log in.'}</p>
      <div class="grid-2">
        <div class="field"><label>Client</label><select name="user_id" required><option value="">Choose…</option>
          ${clients.map((c) => `<option value="${c.id}" ${c.id === userId ? 'selected' : ''}>${esc(c.company || c.name || c.email)} (${esc(c.email)})</option>`).join('')}</select></div>
        <div class="field"><label>Batch name (optional)</label><input name="batch_name" placeholder="e.g. Q4 outreach"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Mailbox type</label><select name="inbox_type" required><option value="">Choose…</option>
          ${pricing.map((p) => `<option value="${esc(p.inbox_type)}">${esc(p.label)}</option>`).join('')}</select></div>
        <div class="field"><label>Status</label><select name="status">
          <option value="active" selected>Active (live, renews every cycle)</option><option value="in_progress">Setting up</option>
          <option value="pending">Pending</option><option value="cancelled">Cancelled (history only)</option></select></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Mailboxes</label><input name="quantity" type="number" min="1" max="10000" required></div>
        <div class="field"><label>Price per mailbox / month ($)</label><input name="price_per_mailbox" type="number" step="0.01" min="0" required></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Start date</label><input name="start_date" type="date" value="${esc(today)}"><div class="hint">When the mailboxes went live / were purchased.</div></div>
        <div class="billing-only">${cycleFields(1)}</div>
      </div>
      <div class="note note-info billing-only" style="margin:-4px 0 16px"><span class="note-icon">📅</span><div id="renew-preview"></div></div>
      <div class="field billing-only"><label>Invoices</label><select name="current_period">
        <option value="all_paid_current_unpaid" selected>Current period unpaid (still to be paid), earlier periods paid</option>
        <option value="all_paid">Everything already paid, including the current period</option>
        <option value="unpaid">Only the current period, unpaid</option>
        <option value="paid">Only the current period, paid</option>
        <option value="none">Don't create invoices</option></select>
        <div class="note note-info" style="margin-top:8px"><span class="note-icon">🧾</span><div id="inv-preview"></div></div></div>
      <div class="grid-2">
        <div class="field"><label>Domains (optional)</label><textarea name="domains" style="min-height:70px" placeholder="One per line"></textarea></div>
        <div class="field"><label>Usernames (optional)</label><textarea name="usernames" style="min-height:70px" placeholder="One per line"></textarea></div>
      </div>
      <div class="field"><label>Internal notes (optional)</label><input name="admin_notes"></div>
      <div class="error"></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Add batch</button></div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => dlg.close(); });
  const f = dlg.querySelector('form');
  const fillPrice = () => { if (f.user_id.value && f.inbox_type.value) f.price_per_mailbox.value = priceFor(f.user_id.value, f.inbox_type.value); };
  f.user_id.onchange = fillPrice;
  f.inbox_type.onchange = fillPrice;
  f.status.onchange = () => dlg.querySelectorAll('.billing-only').forEach((el) => { el.hidden = f.status.value !== 'active'; });
  wireCycleFields(dlg);
  const preview = () => {
    const start = f.start_date.value || today;
    const months = cycleFromForm(formData(f));
    const day = Number(start.slice(8));
    let next = addMonths(start, day, months);
    while (next <= today) next = addMonths(next, day, months);
    const qty = Number(f.quantity.value) || 0; const price = Number(f.price_per_mailbox.value) || 0;
    let periods = 0;
    for (let p = start; p < next && periods < 120; p = addMonths(p, day, months)) periods += 1;
    dlg.querySelector('#renew-preview').innerHTML = `Renews on day <strong>${day}</strong> ${cycleName(months).toLowerCase()}. Next renewal: <strong>${fmtDate(next)}</strong>${qty && price ? ` · ${money(qty * price * months)} per ${perCycle(months)}` : ''}` +
      `<div class="muted small">${periods} billing period${periods === 1 ? '' : 's'} since the start date${periods > 1 ? `: from ${fmtDate(start)} to ${fmtDate(addMonths(next, day, -months))}` : ''}.</div>`;
    // What the Invoices choice will create.
    const mode = f.current_period.value;
    const per = qty && price ? money(qty * price * months) : 'the batch price';
    const current = addMonths(next, day, -months);
    const count = mode.startsWith('all') ? periods : mode === 'none' ? 0 : 1;
    const unpaid = ['all_paid_current_unpaid', 'unpaid'].includes(mode);
    dlg.querySelector('#inv-preview').innerHTML = count === 0 ? 'No invoices: the client won\'t be billed until the next renewal.'
      : `Creates <strong>${count} invoice${count === 1 ? '' : 's'}</strong>${count > 1 ? ` (one per period, ${count - (unpaid ? 1 : 0)} marked paid)` : ''}. ` +
        `The current period, from ${fmtDate(current)}, is <strong>${unpaid ? `unpaid: the client owes ${per}` : 'marked paid'}</strong>.`;
  };
  ['input', 'change'].forEach((ev) => f.addEventListener(ev, preview));
  preview();
  onSubmit(f, async (d) => {
    const r = await api('POST', `${API()}/orders`, d);
    dlg.close();
    toast(`Batch #${r.id} added${r.invoiceId ? `. Invoice #${r.invoiceId} is ready under Invoices to edit and send.` : ''}`);
    reloadAdmin();
  });
  dlg.showModal();
}

// Edit a client's name, company and (owner only) login email.
function openClientDialog(c) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = `<div class="modal-head"><h2>Edit client</h2><button class="btn btn-sm btn-ghost" type="button" id="c-close" aria-label="Close">✕</button></div>
    <form id="client-form">
    <div class="field"><label for="c-email">${isReseller() ? 'Email' : 'Login email'}</label>
      <input id="c-email" name="email" type="email" required value="${esc(c.email)}" ${isOwner() || isReseller() ? '' : 'readonly'}>
      <div class="hint">${isReseller() ? 'Invoices and renewal reminders are sent to this email.' : isOwner() ? (c.password_set ? 'They log in with this email. If you change it, both the old and new address get an email about it, and their password stays the same.' : 'Pending invites to the old email stop working. Send a new invite afterwards.') : 'Only the owner can change a client\'s email.'}</div></div>
    <div class="field"><label for="c-name">Name</label><input id="c-name" name="name" value="${esc(c.name)}"></div>
    <div class="field"><label for="c-company">Company</label><input id="c-company" name="company" value="${esc(c.company)}"></div>
    ${isReseller() ? '' : soldByField(c.seller)}
    <div class="row"><button class="btn btn-primary" type="submit">Save</button><button class="btn" type="button" id="c-cancel">Cancel</button></div>
    <div class="error"></div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelector('#c-cancel').onclick = () => dlg.close();
  dlg.querySelector('#c-close').onclick = () => dlg.close();
  dlg.showModal();
  onSubmit(dlg.querySelector('form'), async (d) => {
    if (!isOwner() && !isReseller()) delete d.email;
    const r = await api('PATCH', `${API()}/clients/${c.id}`, d);
    dlg.close();
    toast(r.emailChanged ? `Email changed to ${d.email}` : 'Client saved');
    reloadAdmin();
  });
}


// ---- search + filters for list tables
// Rows carry data-search (lowercase text) and data-<filter> attributes (one or
// more space-separated values); rows that don't match are hidden. Choices are
// remembered for the session, per page.

function filterBar(key, filters) {
  return `<div class="filter-bar" data-fb="${key}">
    <input type="search" class="fb-q" placeholder="Search name, email, company…" aria-label="Search">
    ${filters.map((f) => `<select data-f="${f.name}" aria-label="${esc(f.label)}"><option value="">${esc(f.label)}</option>
      ${f.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`).join('')}
    <button type="button" class="btn btn-sm btn-ghost fb-clear" hidden>Clear</button>
    <span class="muted small fb-count"></span>
  </div>`;
}

function wireFilterBar(key) {
  const bar = document.querySelector(`[data-fb="${key}"]`);
  if (!bar) return;
  const table = bar.parentElement.querySelector('table');
  const q = bar.querySelector('.fb-q');
  const selects = [...bar.querySelectorAll('select[data-f]')];
  const clear = bar.querySelector('.fb-clear');
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(`fb:${key}`) || '{}'); } catch { saved = {}; }
  q.value = saved.q || '';
  selects.forEach((sel) => { if ([...sel.options].some((o) => o.value === saved[sel.dataset.f])) sel.value = saved[sel.dataset.f]; });
  const apply = () => {
    const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = table ? [...table.querySelectorAll('tbody tr[data-search]')] : [];
    let shown = 0;
    let total = 0;
    rows.forEach((tr) => {
      const ok = words.every((w) => tr.dataset.search.includes(w))
        && selects.every((sel) => !sel.value || (tr.getAttribute(`data-${sel.dataset.f}`) || '').split(' ').includes(sel.value));
      tr.hidden = !ok;
      // Rows that belong to this one (e.g. the client's pricing editor) follow it.
      if (!ok) table.querySelectorAll(`tr[data-for="${tr.dataset.id}"]`).forEach((x) => { x.hidden = true; });
      if (ok) { shown += 1; total += Number(tr.dataset.amount || 0); }
    });
    const active = words.length || selects.some((sel) => sel.value);
    clear.hidden = !active;
    const sum = rows.some((tr) => tr.dataset.amount !== undefined) ? ` · ${money(total)}` : '';
    bar.querySelector('.fb-count').textContent = active ? `${shown} of ${rows.length}${sum}` : '';
    const state = { q: q.value };
    selects.forEach((sel) => { state[sel.dataset.f] = sel.value; });
    try { sessionStorage.setItem(`fb:${key}`, JSON.stringify(state)); } catch { /* private mode */ }
  };
  q.addEventListener('input', apply);
  selects.forEach((sel) => sel.addEventListener('change', apply));
  clear.onclick = () => { q.value = ''; selects.forEach((sel) => { sel.value = ''; }); apply(); q.focus(); };
  apply();
}

// "Sold by" choices: team members plus anyone already set on a client.
function sellerOptions(rows) {
  const names = new Set([...(state.admin.sellers || []), ...rows.map((r) => r.seller).filter(Boolean)]);
  return [...[...names].sort().map((n) => [n, n]), ['__none', 'Not set']];
}
const searchText = (...parts) => esc(parts.filter((x) => x !== null && x !== undefined).join(' ').toLowerCase());

function adminClients() {
  const { clients, invites, mailEnabled, pricing, clientPricing } = state.admin;
  const labelOf = (t) => (pricing.find((p) => p.inbox_type === t) || {}).label || t;
  shell(ADMIN_TABS, '#/admin/clients', `
    <div class="page-head"><div><h1>Clients & invites</h1><p class="muted">The portal is invite-only. Clients can only join through a link you send.</p></div></div>
    <div class="stack">
      <form class="card card-pad" id="inv">
        <h2 style="margin-bottom:4px">Invite or add a client</h2>
        <p class="muted small" style="margin:0 0 14px">Existing client? Click <strong>Add without inviting</strong>, add their batches and billing, then send the invite when everything is in place.</p>
        <div class="grid-2">
          <div class="field"><label for="i-email">Email</label><input id="i-email" name="email" type="email" required></div>
          <div class="field"><label for="i-name">Name</label><input id="i-name" name="name"></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="i-company">Company</label><input id="i-company" name="company"></div>
          ${soldByField('')}
        </div>
        <div class="row"><button class="btn btn-primary" type="submit">Send invite</button><button class="btn" type="button" id="add-client">Add without inviting</button>
          <span class="muted small">${mailEnabled ? 'The invite is emailed, and you also get the link to share.' : 'Email is not configured yet: copy the link and send it yourself.'}</span></div>
        <div class="error"></div>
        <div id="inv-link"></div>
      </form>

      <div class="card">
        <div class="card-head"><h2>Clients</h2><span class="muted small">${clients.length} total</span></div>
        ${clients.length ? filterBar('clients', [
          { name: 'seller', label: 'Sold by: anyone', options: sellerOptions(clients) },
          { name: 'account', label: 'Account: any', options: [['joined', 'Joined'], ['invited', 'Invited'], ['not_invited', 'Not invited']] },
          { name: 'active', label: 'Mailboxes: any', options: [['yes', 'Has active mailboxes'], ['no', 'No active mailboxes']] },
        ]) : ''}
        ${clients.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Client</th><th>Account</th><th>Pricing</th><th class="num">Active mailboxes</th><th class="num">Monthly</th><th>Added</th><th></th></tr></thead>
          <tbody>${clients.map((c) => {
            const custom = clientPricing.filter((cp) => cp.user_id === c.id);
            return `<tr data-id="${c.id}" data-search="${searchText(c.company, c.name, c.email, c.seller)}" data-seller="${esc(c.seller || '__none')}"
              data-account="${c.password_set ? 'joined' : c.invited ? 'invited' : 'not_invited'}" data-active="${c.active_mailboxes > 0 ? 'yes' : 'no'}">
            <td>${esc(c.company || c.name)}<div class="muted small">${esc(c.name)} · ${esc(c.email)}</div>${c.seller ? `<div class="muted small">Sold by <strong>${esc(c.seller)}</strong></div>` : ''}</td>
            <td>${c.password_set ? '<span class="badge b-active">Joined</span>' : c.invited ? '<span class="badge b-in_progress">Invited</span>' : '<span class="badge b-pending">Not invited</span>'}</td>
            <td>${custom.length ? `<span class="badge b-in_progress">Custom</span><div class="muted small">${custom.map((cp) => `${esc(labelOf(cp.inbox_type))} ${money(cp.price_per_mailbox)}`).join('<br>')}</div>` : '<span class="muted small">Standard</span>'}</td>
            <td class="num">${c.active_mailboxes}</td><td class="num">${money(c.monthly)}</td><td>${fmtDate(c.created_at)}</td>
            <td><div class="row client-actions"><button class="btn btn-sm btn-primary" data-batch="${c.id}">+ Add batch</button><button class="btn btn-sm" data-prices="${c.id}">Edit pricing</button><button class="btn btn-sm btn-ghost" data-reset="${esc(c.email)}">${c.password_set ? 'Reset link' : c.invited ? 'Resend invite' : 'Send invite'}</button><button class="btn btn-sm" data-edit="${c.id}">Edit</button>${isOwner() ? `<button class="btn btn-sm btn-danger" data-delete-client="${c.id}">Delete</button>` : ''}</div></td>
          </tr>
          <tr class="price-row" id="prices-${c.id}" data-for="${c.id}" hidden><td colspan="7">
            <form class="client-prices" data-id="${c.id}">
              <p class="muted small" style="margin:0 0 12px">Price per mailbox / month for ${esc(c.company || c.name || c.email)}. Leave a field blank to use the standard price. New orders from this client use these prices.</p>
              <div class="grid-4">${pricing.map((p) => {
                const own = custom.find((cp) => cp.inbox_type === p.inbox_type);
                return `<div class="field"><label>${esc(p.label)}</label><input type="number" step="0.01" min="0" name="${esc(p.inbox_type)}" placeholder="Standard: ${money(p.price_per_mailbox)}" value="${own ? own.price_per_mailbox : ''}"></div>`;
              }).join('')}</div>
              <div class="row"><button class="btn btn-primary btn-sm" type="submit">Save pricing</button><button class="btn btn-sm" type="button" data-close="${c.id}">Cancel</button></div>
              <div class="error"></div>
            </form>
          </td></tr>`;
          }).join('')}</tbody></table></div>` : '<div class="empty">No clients yet. Invite your first one above.</div>'}
      </div>

      <div class="card">
        <div class="card-head"><h2>Pending invites</h2></div>
        ${invites.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Email</th><th>Company</th><th>Expires</th><th></th></tr></thead>
          <tbody>${invites.map((i) => `<tr><td>${esc(i.email)}</td><td>${esc(i.company)}</td><td>${fmtDate(i.expires_at)}</td>
            <td><button class="btn btn-sm" data-revoke="${i.id}">Revoke</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No pending invites.</div>'}
      </div>
    </div>`);

  wireFilterBar('clients');
  const showLink = (r, email) => {
    document.getElementById('inv-link').innerHTML = `
      <div class="note" style="margin-top:12px"><span class="note-icon">🔗</span><div style="min-width:0;flex:1">
        <strong>${r.reset ? 'Password reset' : 'Invite'} link for ${esc(email)}</strong> ${r.emailed ? '(also emailed)' : '(not emailed — share it yourself)'}
        <div class="row" style="margin-top:8px;flex-wrap:nowrap"><input readonly value="${esc(r.link)}" id="link-val"><button type="button" class="btn btn-sm" id="copy">Copy</button></div>
      </div></div>`;
    document.getElementById('copy').onclick = async () => {
      try { await navigator.clipboard.writeText(r.link); toast('Link copied'); } catch { document.getElementById('link-val').select(); }
    };
  };

  document.getElementById('add-client').onclick = async () => {
    const form = document.getElementById('inv');
    const d = formData(form);
    const err = form.querySelector('.error');
    err.textContent = '';
    try {
      const r = await api('POST', `${API()}/clients`, d);
      toast(`${d.email} added. Now add their batches.`);
      state.admin = await api('GET', `${API()}/overview`);
      adminClients();
      openBatchDialog(r.id);
    } catch (ex) { err.textContent = ex.message; }
  };
  document.querySelectorAll('[data-batch]').forEach((b) => { b.onclick = () => openBatchDialog(Number(b.dataset.batch)); });
  onSubmit(document.getElementById('inv'), async (d) => {
    const r = await api('POST', `${API()}/invites`, d);
    state.admin = await api('GET', `${API()}/overview`);
    adminClients();
    showLink(r, d.email);
  });
  document.querySelectorAll('[data-reset]').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api('POST', `${API()}/invites`, { email: b.dataset.reset });
        state.admin = await api('GET', `${API()}/overview`);
        adminClients();
        showLink(r, b.dataset.reset);
        window.scrollTo(0, 0);
      } catch (ex) { toast(ex.message); }
    };
  });
  document.querySelectorAll('[data-prices]').forEach((b) => {
    b.onclick = () => { const r = document.getElementById(`prices-${b.dataset.prices}`); r.hidden = !r.hidden; };
  });
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => { document.getElementById(`prices-${b.dataset.close}`).hidden = true; };
  });
  document.querySelectorAll('.client-prices').forEach((form) => {
    onSubmit(form, async (d) => {
      await api('PUT', `${API()}/clients/${form.dataset.id}/pricing`, {
        prices: Object.entries(d).map(([inbox_type, v]) => ({ inbox_type, price_per_mailbox: v === '' ? null : v })),
      });
      toast('Client pricing saved');
      reloadAdmin();
    });
  });
  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openClientDialog(clients.find((c) => c.id === Number(b.dataset.edit)));
  });
  document.querySelectorAll('[data-delete-client]').forEach((b) => {
    b.onclick = async () => {
      const c = clients.find((x) => x.id === Number(b.dataset.deleteClient));
      const typed = prompt(`Delete ${c.company || c.name || c.email} permanently?\n\n` +
        `This deletes their account and everything in it: ${c.batch_count} batch${c.batch_count === 1 ? '' : 'es'}, ` +
        `${c.invoice_count} invoice${c.invoice_count === 1 ? '' : 's'} (paid ones too, so they drop out of Analytics), ` +
        `notifications, custom pricing and uploaded CSVs. It can't be undone.\n\nType the client's email to confirm:\n${c.email}`);
      if (typed === null) return;
      if (typed.trim().toLowerCase() !== c.email) return toast('The email didn\'t match. Nothing was deleted.');
      try {
        await api('DELETE', `${API()}/clients/${c.id}`);
        toast(`${c.email} deleted`);
        reloadAdmin();
      } catch (ex) { toast(ex.message); }
    };
  });
  document.querySelectorAll('[data-revoke]').forEach((b) => {
    b.onclick = async () => {
      await api('DELETE', `${API()}/invites/${b.dataset.revoke}`);
      toast('Invite revoked');
      reloadAdmin();
    };
  });
}

function typeLabel(type, pricing) {
  if (type === 'other') return 'Other';
  const p = pricing.find((x) => x.inbox_type === type);
  return p ? p.label : '';
}

async function setInvoiceStatus(id, status, orderId) {
  if (status === 'void' && !confirm(`Void invoice #${id}?`)) return false;
  await api('PATCH', `${API()}/invoices/${id}`, { status });
  toast(`Invoice #${id} updated`);
  // Voiding a bill doesn't end the subscription behind it; offer to do that too.
  const order = status === 'void' && orderId && state.admin.orders.find((o) => String(o.id) === String(orderId));
  if (order && order.status !== 'cancelled'
    && confirm(`Invoice #${id} is voided.\n\nAlso cancel the subscription for ${batchTitle(order)}? It will stop renewing and no longer count in the client's dashboard.`)) {
    await api('PATCH', `${API()}/orders/${order.id}`, { status: 'cancelled' });
    toast(`Invoice #${id} voided and ${batchTitle(order)} cancelled`);
  }
  return true;
}

function adminInvoices() {
  const { invoices, today } = state.admin;
  const week = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  shell(ADMIN_TABS, '#/admin/invoices', `
    <div class="page-head">
      <div><h1>Invoices</h1><p class="muted">Renewal invoices are created automatically 7 days before each renewal. Create and edit any invoice here.</p></div>
      <a class="btn btn-primary" href="#/admin/invoice/new">+ New invoice</a>
    </div>
    <div class="card">
      ${invoices.length ? filterBar('invoices', [
        { name: 'status', label: 'Status: any', options: [['unpaid', 'Unpaid (incl. overdue)'], ['overdue', 'Overdue'], ['due7', 'Due in the next 7 days'], ['paid', 'Paid'], ['void', 'Void']] },
        ...(isReseller() ? [] : [{ name: 'seller', label: 'Sold by: anyone', options: sellerOptions(invoices) }]),
        { name: 'month', label: 'Issued: any month', options: [...new Set(invoices.map((i) => String(i.issue_date || i.created_at).slice(0, 7)))].sort().reverse().map((m) => [m, monthName(m)]) },
      ]) : ''}
      ${invoices.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Client</th><th>Description</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>${invoices.map((i) => {
          const s = i.status === 'unpaid' && i.due_date < today ? 'overdue' : i.status;
          const in7 = i.status === 'unpaid' && i.due_date >= today && i.due_date <= week;
          return `<tr data-id="${i.id}" data-search="${searchText(`#${i.id}`, i.id, i.company, i.name, i.email, i.description, i.seller)}"
            data-status="${s === 'overdue' ? 'unpaid overdue' : s}${in7 ? ' due7' : ''}" data-seller="${esc(i.seller || '__none')}" data-amount="${Number(i.amount) || 0}" data-month="${String(i.issue_date || i.created_at).slice(0, 7)}"><td><a href="#/admin/invoice/${i.id}">${i.id}</a></td><td>${esc(i.company || i.email)}${i.seller ? `<div class="muted small">Sold by ${esc(i.seller)}</div>` : ''}</td><td>${esc(i.description)}</td><td>${fmtDate(i.issue_date || i.created_at)}</td><td>${fmtDate(i.due_date)}</td><td>${badge(s)}</td><td class="num">${money(i.amount)}</td>
          <td><div class="row" style="flex-wrap:nowrap">
            <a class="btn btn-sm" href="#/admin/invoice/${i.id}">View</a>
            <a class="btn btn-sm" href="#/admin/invoice/${i.id}/edit">Edit</a>
            ${i.status !== 'paid' ? `<button class="btn btn-sm" data-inv="${i.id}" data-status="paid">Mark paid</button>` : `<button class="btn btn-sm" data-inv="${i.id}" data-status="unpaid">Mark unpaid</button>`}
            ${i.status !== 'void' ? `<button class="btn btn-sm btn-ghost" data-inv="${i.id}" data-status="void" data-order="${i.order_id || ''}">Void</button>` : ''}
            ${subOrders(i).length ? `<button class="btn btn-sm btn-danger" data-cancel-inv="${i.id}">Cancel sub</button>` : ''}
          </div></td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty">No invoices yet. <a href="#/admin/invoice/new">Create one</a>.</div>'}
    </div>`);

  wireFilterBar('invoices');
  document.querySelectorAll('[data-cancel-inv]').forEach((b) => {
    b.onclick = () => {
      const inv = invoices.find((i) => String(i.id) === b.dataset.cancelInv);
      openCancelSubDialog({ orders: subOrders(inv), url: `${API()}/invoices/${inv.id}/cancel`, invoice: inv });
    };
  });
  document.querySelectorAll('[data-inv]').forEach((b) => {
    b.onclick = async () => {
      try { if (await setInvoiceStatus(b.dataset.inv, b.dataset.status, b.dataset.order)) reloadAdmin(); } catch (ex) { toast(ex.message); }
    };
  });
}

// ---- invoice editor (new + edit)

function invoiceEditor(inv) {
  const { clients, orders, pricing, clientPricing, today } = state.admin;
  const isNew = !inv;
  const plus = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const ed = {
    user_id: inv ? String(inv.user_id) : '',
    order_id: inv && inv.order_id ? String(inv.order_id) : '',
    issue_date: inv ? (inv.issue_date || String(inv.created_at).slice(0, 10)) : today,
    due_date: inv ? inv.due_date : plus(today, 7),
    discount: inv && inv.discount ? String(inv.discount) : '',
    notes: inv ? inv.notes || '' : '',
    status: inv && inv.status === 'paid' ? 'paid' : 'unpaid',
    paid_date: inv && inv.paid_at ? String(inv.paid_at).slice(0, 10) : today,
    items: inv ? inv.items.map((it) => ({ ...it, quantity: String(it.quantity), unit_price: String(it.unit_price) }))
      : [{ inbox_type: '', batch_name: '', description: '', quantity: '1', unit_price: '' }],
  };
  const clientOrders = () => orders.filter((o) => String(o.user_id) === ed.user_id);
  const priceFor = (type) => {
    const own = clientPricing.find((cp) => String(cp.user_id) === ed.user_id && cp.inbox_type === type);
    const std = pricing.find((p) => p.inbox_type === type);
    return own ? own.price_per_mailbox : std ? std.price_per_mailbox : '';
  };
  const lineTotal = (it) => (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
  const typeOptions = (sel) => `<option value="" ${sel === '' ? 'selected' : ''}>—</option>` +
    pricing.map((p) => `<option value="${esc(p.inbox_type)}" ${sel === p.inbox_type ? 'selected' : ''}>${esc(p.label)}</option>`).join('') +
    `<option value="other" ${sel === 'other' ? 'selected' : ''}>Other</option>`;

  shell(ADMIN_TABS, '#/admin/invoices', `
    <div class="page-head">
      <div><h1>${isNew ? 'New invoice' : `Edit invoice #${inv.id}`}</h1><p class="muted">Add as many lines as you need. Every field is editable.</p></div>
      <a class="btn" href="${isNew ? '#/admin/invoices' : `#/admin/invoice/${inv.id}`}">Cancel</a>
    </div>
    <form id="inv-form" class="stack">
      <div class="card card-pad">
        <div class="grid-2">
          <div class="field"><label for="e-user">Client</label>
            <select id="e-user" required><option value="">Choose…</option>
              ${clients.filter((c) => !isOwner() || !c.reseller_id || String(c.id) === ed.user_id).map((c) => `<option value="${c.id}" ${String(c.id) === ed.user_id ? 'selected' : ''}>${esc(c.company || c.name || c.email)} (${esc(c.email)})</option>`).join('')}</select></div>
          <div class="field"><label for="e-order">Linked batch (optional)</label><select id="e-order"></select>
            <div class="hint">Choosing a batch adds a line for it. <a id="e-batch-link" href="#" hidden>Edit batch details (domains, usernames) →</a></div></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="e-issue">Issue date</label><input id="e-issue" type="date" required value="${esc(ed.issue_date)}"></div>
          <div class="field"><label for="e-due">Due date</label><input id="e-due" type="date" required value="${esc(ed.due_date)}"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Invoice lines</h2><button type="button" class="btn btn-sm" id="add-line">+ Add line</button></div>
        <div class="table-wrap"><table class="lines">
          <thead><tr><th style="min-width:170px">Mailbox type</th><th style="min-width:150px">Batch name</th><th style="min-width:200px">Description</th><th class="num" style="width:90px">Qty</th><th class="num" style="width:120px">Unit price ($)</th><th class="num" style="width:110px">Amount</th><th style="width:44px"></th></tr></thead>
          <tbody id="lines"></tbody>
        </table></div>
        <datalist id="batch-names"></datalist>
        <div class="totals">
          <div><span>Subtotal</span><span id="t-sub"></span></div>
          <div><label for="e-discount">Discount ($)</label><input id="e-discount" type="number" step="0.01" min="0" value="${esc(ed.discount)}" placeholder="0.00"></div>
          <div class="grand"><span>Total</span><span id="t-total"></span></div>
        </div>
      </div>

      <div class="card card-pad">
        <div class="field"><label for="e-notes">Notes (shown on the invoice)</label><textarea id="e-notes" style="font-family:inherit;min-height:80px" placeholder="e.g. Payment terms, bank details, thank-you note">${esc(ed.notes)}</textarea></div>
        <div class="grid-2">
          <div class="field"><label for="e-status">Payment status</label><select id="e-status">
            <option value="unpaid" ${ed.status === 'unpaid' ? 'selected' : ''}>Unpaid</option><option value="paid" ${ed.status === 'paid' ? 'selected' : ''}>Paid</option></select>
            <div class="hint">Use Paid to record an invoice that's already been collected, e.g. past billing.</div></div>
          <div class="field" id="e-paid-wrap" ${ed.status === 'paid' ? '' : 'hidden'}><label for="e-paid">Paid on</label><input id="e-paid" type="date" value="${esc(ed.paid_date)}"></div>
        </div>
        ${isNew ? `<div class="batch-opt" id="e-batch-box">
          <label class="check"><input type="checkbox" id="e-batches" checked> <strong>Add the mailbox lines (and Other lines ticked Recurring) to the client's dashboard as active batches</strong></label>
          <div class="hint" style="margin:4px 0 10px 24px">Use this when the invoice is for mailboxes the client doesn't have as a batch yet. They renew from the issue date. Untick for one-off charges, or link an existing batch above instead.</div>
          <div style="margin-left:24px;max-width:420px">${cycleFields(1)}</div>
        </div>` : ''}
        <label class="check"><input type="checkbox" id="e-notify" ${isNew ? 'checked' : ''}> ${isNew ? 'Notify the client (portal notification and email)' : 'Notify the client about this change'}</label>
      </div>

      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">${isNew ? 'Create invoice' : 'Save changes'}</button></div>
      <div class="error" id="e-error"></div>
    </form>`);

  const $ = (id) => document.getElementById(id);
  const recalc = () => {
    const sub = ed.items.reduce((t, it) => t + lineTotal(it), 0);
    $('t-sub').textContent = money(sub);
    $('t-total').textContent = money(Math.max(0, sub - (Number(ed.discount) || 0)));
    document.querySelectorAll('[data-total]').forEach((td) => { td.textContent = money(lineTotal(ed.items[td.dataset.total])); });
  };
  const fillBatches = () => {
    const list = clientOrders();
    $('e-order').innerHTML = '<option value="">None</option>' + list.map((o) => `<option value="${o.id}" ${String(o.id) === ed.order_id ? 'selected' : ''}>Batch #${o.id}: ${esc(o.inbox_label)} × ${o.quantity}</option>`).join('');
    $('batch-names').innerHTML = list.map((o) => `<option value="Batch #${o.id}">`).join('');
  };
  const renderLines = () => {
    $('lines').innerHTML = ed.items.map((it, i) => `<tr>
      <td><select data-i="${i}" data-k="inbox_type">${typeOptions(it.inbox_type)}</select>
        ${it.inbox_type === 'other' ? `<label class="check small recurring-tick" title="Recurring lines become their own batch on the client's dashboard and renew with it"><input type="checkbox" data-i="${i}" data-k="recurring" ${it.recurring ? 'checked' : ''}> Recurring</label>` : ''}</td>
      <td><input data-i="${i}" data-k="batch_name" list="batch-names" value="${esc(it.batch_name)}" placeholder="e.g. Batch #12"></td>
      <td><input data-i="${i}" data-k="description" value="${esc(it.description)}" placeholder="e.g. Monthly mailboxes"></td>
      <td><input data-i="${i}" data-k="quantity" type="number" step="0.01" min="0.01" required value="${esc(it.quantity)}" class="num"></td>
      <td><input data-i="${i}" data-k="unit_price" type="number" step="0.01" min="0" required value="${esc(it.unit_price)}" class="num"></td>
      <td class="num" data-total="${i}"></td>
      <td><button type="button" class="btn btn-sm btn-ghost" data-remove="${i}" ${ed.items.length === 1 ? 'disabled' : ''} aria-label="Remove line">✕</button></td>
    </tr>`).join('');
    $('lines').querySelectorAll('[data-k]').forEach((el) => {
      const handler = () => {
        const it = ed.items[el.dataset.i];
        it[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
        // Picking a mailbox type fills in this client's price if none is set yet.
        if (el.dataset.k === 'inbox_type' && it.unit_price === '' && el.value && el.value !== 'other') {
          it.unit_price = String(priceFor(el.value));
          el.closest('tr').querySelector('[data-k="unit_price"]').value = it.unit_price;
        }
        // Switching to/from "Other" shows or hides its Recurring tick.
        if (el.dataset.k === 'inbox_type') { if (el.value !== 'other') it.recurring = false; renderLines(); return; }
        recalc();
      };
      el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', handler);
    });
    $('lines').querySelectorAll('[data-remove]').forEach((b) => {
      b.onclick = () => { ed.items.splice(Number(b.dataset.remove), 1); renderLines(); };
    });
    recalc();
  };

  fillBatches();
  renderLines();
  $('e-user').onchange = (e) => {
    ed.user_id = e.target.value; ed.order_id = '';
    ed.items.forEach((it) => { if (it.inbox_type && it.inbox_type !== 'other') it.unit_price = String(priceFor(it.inbox_type)); });
    fillBatches(); renderLines();
  };
  const syncBatchLink = () => {
    const a = $('e-batch-link');
    a.hidden = !ed.order_id;
    a.href = `#/admin/orders/${ed.order_id}`;
  };
  syncBatchLink();
  $('e-order').addEventListener('change', syncBatchLink);
  $('e-order').onchange = (e) => {
    ed.order_id = e.target.value;
    syncBatchLink();
    const o = orders.find((x) => String(x.id) === ed.order_id);
    if (!o) return;
    const line = { inbox_type: o.inbox_type, batch_name: `Batch #${o.id}`, description: `${o.inbox_label} mailboxes`, quantity: String(o.quantity), unit_price: String(o.price_per_mailbox) };
    const blank = ed.items.length === 1 && !ed.items[0].inbox_type && !ed.items[0].batch_name && !ed.items[0].description && !ed.items[0].unit_price;
    if (blank) ed.items[0] = line; else ed.items.push(line);
    renderLines();
  };
  $('add-line').onclick = () => {
    ed.items.push({ inbox_type: '', batch_name: '', description: '', quantity: '1', unit_price: '' });
    renderLines();
    $('lines').querySelector('tr:last-child select').focus();
  };
  $('e-issue').oninput = (e) => { ed.issue_date = e.target.value; };
  $('e-due').oninput = (e) => { ed.due_date = e.target.value; };
  $('e-discount').oninput = (e) => { ed.discount = e.target.value; recalc(); };
  $('e-notes').oninput = (e) => { ed.notes = e.target.value; };
  $('e-status').onchange = (e) => { $('e-paid-wrap').hidden = e.target.value !== 'paid'; };
  if (isNew) {
    wireCycleFields($('e-batch-box'));
    const syncBatchBox = () => { $('e-batch-box').hidden = Boolean(ed.order_id); };
    $('e-order').addEventListener('change', syncBatchBox);
    $('e-user').addEventListener('change', syncBatchBox);
    syncBatchBox();
  }

  $('inv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; $('e-error').textContent = '';
    const body = {
      user_id: ed.user_id, order_id: ed.order_id || null, issue_date: ed.issue_date, due_date: ed.due_date,
      discount: ed.discount || 0, notes: ed.notes, items: ed.items, notify: $('e-notify').checked,
      status: $('e-status').value, paid_date: $('e-paid').value,
      ...(isNew && !ed.order_id && $('e-batches').checked ? {
        create_batches: true,
        billing_cycle: $('e-batch-box').querySelector('[name=billing_cycle]').value,
        custom_months: $('e-batch-box').querySelector('[name=custom_months]').value,
      } : {}),
    };
    try {
      const r = isNew ? await api('POST', `${API()}/invoices`, body) : await api('PUT', `${API()}/invoices/${inv.id}`, body);
      const id = isNew ? r.id : inv.id;
      toast(isNew ? `Invoice #${id} created${r.batchIds && r.batchIds.length ? ` and ${r.batchIds.length} batch${r.batchIds.length === 1 ? '' : 'es'} added to the dashboard` : ''}` : `Invoice #${id} saved`);
      go(`#/admin/invoice/${id}`);
    } catch (ex) {
      $('e-error').textContent = ex.message;
      btn.disabled = false;
    }
  });
}

// ---- invoice page (admin + client), printable

// The active subscriptions an invoice belongs to: its batch, plus batches
// made from its recurring lines.
const subOrders = (inv) => ((state.admin && state.admin.orders) || [])
  .filter((o) => o.status !== 'cancelled' && (o.id === inv.order_id || o.from_invoice_id === inv.id));

function renderInvoiceView(inv, isAdmin) {
  const today = isAdmin ? state.admin.today : state.dash.today;
  const status = inv.status === 'unpaid' && inv.due_date < today ? 'overdue' : inv.status;
  const subtotal = inv.items.reduce((t, it) => t + it.quantity * it.unit_price, 0);
  const qty = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const back = isAdmin ? '#/admin/invoices' : '#/billing';

  shell(isAdmin ? ADMIN_TABS : CLIENT_TABS, isAdmin ? '#/admin/invoices' : '#/billing', `
    <div class="page-head no-print">
      <a class="btn" href="${back}">← Back</a>
      <div class="row">
        ${isAdmin ? `${inv.order_id && !(isOwner() && inv.resellerName) ? `<a class="btn" href="#/admin/orders/${inv.order_id}">Batch #${inv.order_id}: domains &amp; details</a>` : ''}<a class="btn" href="#/admin/invoice/${inv.id}/edit">Edit</a>
          ${inv.status !== 'paid' ? '<button class="btn" data-set="paid">Mark paid</button>' : '<button class="btn" data-set="unpaid">Mark unpaid</button>'}
          ${inv.status !== 'void' ? '<button class="btn btn-ghost" data-set="void">Void</button>' : ''}` : ''}
        ${isAdmin && inv.status === 'unpaid' ? `<button class="btn btn-danger" id="send-urgent" title="${inv.urgent_sent_at ? `Last sent ${esc(fmtDate(inv.urgent_sent_at))}` : 'Critical alert: mailboxes expire in a few hours'}">⚠ Urgent reminder</button>` : ''}
        ${isAdmin && inv.status !== 'void' ? `<button class="btn" id="send-inv" title="${inv.sent_at ? `Last sent ${esc(fmtDate(inv.sent_at))}` : 'Not sent yet'}">${inv.sent_at ? 'Send again' : 'Send invoice'}</button>` : ''}
        ${isAdmin && subOrders(inv).length ? '<button class="btn btn-danger" id="cancel-sub">Cancel subscription</button>' : ''}
        <button class="btn btn-primary" id="print">Print / Save PDF</button>
      </div>
    </div>
    ${isAdmin && (inv.sent_at || inv.seller || inv.urgent_sent_at || (isOwner() && inv.resellerName)) ? `<p class="muted small no-print" style="margin:0 0 12px">${[isOwner() && inv.resellerName ? `Reseller client of <strong>${esc(inv.resellerName)}</strong>` : '', inv.seller ? `Sold by <strong>${esc(inv.seller)}</strong> (the client's; only admins see this)` : '', inv.sent_at ? `Emailed to ${esc(inv.email)} on ${fmtDate(inv.sent_at)}` : '', inv.urgent_sent_at ? `Urgent reminder sent ${fmtDate(inv.urgent_sent_at)}` : ''].filter(Boolean).join(' · ')}.</p>` : ''}
    <article class="invoice-sheet">
      <header class="inv-top">
        ${inv.brand ? (inv.brand.logo ? `<img src="${esc(inv.brand.logo)}" alt="${esc(inv.brand.name)}" class="inv-logo">` : `<div class="inv-brand">${esc(inv.brand.name)}</div>`)
          : '<img src="logo-full.png" alt="MithMill" class="inv-logo">'}
        <div class="inv-title"><div class="inv-word">INVOICE</div><div class="inv-num">#${inv.id}</div>${badge(status)}</div>
      </header>
      <section class="inv-meta">
        <div><div class="inv-label">Billed to</div><strong>${esc(inv.company || inv.name)}</strong>${inv.company && inv.name ? `<div>${esc(inv.name)}</div>` : ''}<div>${esc(inv.email)}</div></div>
        <div><div class="inv-label">Payable to</div>${inv.brand ? `<strong>${esc(inv.brand.name)}</strong>` : '<strong>Mixxbee LLC</strong><div>on behalf of Mithmill</div>'}</div>
        <div class="inv-dates">
          <div><span class="inv-label">Issue date</span><span>${fmtDate(inv.issue_date || inv.created_at)}</span></div>
          <div><span class="inv-label">Due date</span><span>${fmtDate(inv.due_date)}</span></div>
          ${inv.paid_at ? `<div><span class="inv-label">Paid on</span><span>${fmtDate(inv.paid_at)}</span></div>` : ''}
        </div>
      </section>
      <div class="table-wrap"><table class="inv-items">
        <thead><tr><th>Mailbox type</th><th>Batch</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
        <tbody>${inv.items.map((it) => `<tr>
          <td>${esc(typeLabel(it.inbox_type, inv.pricing)) || '—'}</td><td>${esc(it.batch_name) || '—'}</td><td>${esc(it.description)}</td>
          <td class="num">${qty(it.quantity)}</td><td class="num">${money(it.unit_price)}</td><td class="num">${money(it.quantity * it.unit_price)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="totals inv-totals">
        <div><span>Subtotal</span><span>${money(subtotal)}</span></div>
        ${inv.discount ? `<div><span>Discount</span><span>−${money(inv.discount)}</span></div>` : ''}
        <div class="grand"><span>Total due</span><span>${money(inv.amount)}</span></div>
      </div>
      ${isAdmin && !inv.order_id && inv.items.some((it) => (it.inbox_type && it.inbox_type !== 'other') || (it.inbox_type === 'other' && it.recurring)) ? `<div class="note no-print" id="to-batch">
        <span class="note-icon">⚠️</span>
        <div style="flex:1"><strong>These mailboxes aren't on the client's dashboard.</strong> This invoice isn't linked to a batch, so the client's active mailboxes and billing don't include it.
          <div class="row" style="margin-top:10px;align-items:flex-end">
            <div style="min-width:260px">${cycleFields(1)}</div>
            <button class="btn btn-primary" id="make-batch" style="margin-bottom:16px">Add as active batch</button>
          </div></div></div>` : ''}
      ${inv.payLinks && inv.payLinks.length ? `<section class="inv-pay no-print">${inv.payLinks.map((l) => `${l.hint ? `<div class="pay-hint">${esc(l.hint)}</div>` : ''}<a class="btn btn-primary btn-pay" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}
        <div class="muted small">After paying, send us the payment screenshot by replying to the invoice email or in your WhatsApp or Slack group with us.</div></section>` : ''}
      ${inv.notes ? `<section class="inv-notes"><div class="inv-label">Notes</div><div>${linkify(esc(inv.notes))}</div></section>` : ''}
      ${inv.brand ? (inv.paymentNote ? `<div class="note"><span class="note-icon">ℹ️</span><div><strong>Payment details:</strong><div>${linkify(esc(inv.paymentNote)).replace(/\n/g, '<br>')}</div></div></div>` : '')
        : `<div class="note"><span class="note-icon">ℹ️</span><div><strong>Payment notice:</strong> ${esc(inv.paymentNote)}</div></div>`}
      ${inv.brand ? '' : `<div class="inv-powered"><span>Payments powered by</span><img src="mixxbee-logo.png" alt="Mixxbee"></div>`}
    </article>`);

  document.getElementById('print').onclick = () => window.print();
  const cx = document.getElementById('cancel-sub');
  if (cx) cx.onclick = () => openCancelSubDialog({ orders: subOrders(inv), url: `${API()}/invoices/${inv.id}/cancel`, invoice: inv });
  const send = document.getElementById('send-inv');
  if (send) {
    send.onclick = async () => {
      if (!confirm(`Email invoice #${inv.id} (${money(inv.amount)}) to ${inv.email}?\n\nIt includes every line, the total, the due date and your notes (payment details).`)) return;
      send.disabled = true;
      try {
        const r = await api('POST', `${API()}/invoices/${inv.id}/send`);
        toast(`Invoice #${inv.id} sent to ${r.to}`);
        route();
      } catch (ex) { toast(ex.message); send.disabled = false; }
    };
  }
  const urgentBtn = document.getElementById('send-urgent');
  if (urgentBtn) {
    urgentBtn.onclick = async () => {
      const h = prompt(`Send a CRITICAL ALERT to ${inv.email}?\n\nIt says invoice #${inv.id} (${money(inv.amount)}) is unpaid and their mailboxes will be deactivated in a few hours unless they pay now, with the invoice and Pay buttons.\n\nMailboxes expire in how many hours?`, '3');
      if (h === null) return;
      const hours = Number(h);
      if (!(hours >= 1 && hours <= 72)) return toast('Enter a number of hours between 1 and 72');
      urgentBtn.disabled = true;
      try {
        const r = await api('POST', `${API()}/invoices/${inv.id}/send`, { urgent: true, hours });
        toast(`Urgent reminder sent to ${r.to}`);
        route();
      } catch (ex) { toast(ex.message); urgentBtn.disabled = false; }
    };
  }
  const mk = document.getElementById('make-batch');
  if (mk) {
    wireCycleFields(document.getElementById('to-batch'));
    mk.onclick = async () => {
      const box = document.getElementById('to-batch');
      mk.disabled = true;
      try {
        const r = await api('POST', `${API()}/invoices/${inv.id}/batches`, {
          billing_cycle: box.querySelector('[name=billing_cycle]').value, custom_months: box.querySelector('[name=custom_months]').value,
        });
        toast(`Added ${r.batchIds.length} active batch${r.batchIds.length === 1 ? '' : 'es'} to the client's dashboard`);
        route();
      } catch (ex) { toast(ex.message); mk.disabled = false; }
    };
  }
  document.querySelectorAll('[data-set]').forEach((b) => {
    b.onclick = async () => {
      try { if (await setInvoiceStatus(inv.id, b.dataset.set, inv.order_id)) route(); } catch (ex) { toast(ex.message); }
    };
  });
}

function renderTeam(team) {
  const { members, invites, log } = team;
  const ago = (ts) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const verb = { added: 'added', edited: 'edited', deleted: 'deleted', invited: 'sent an invite:', revoked: 'revoked' };
  const changeList = (changes, action) => (changes.length ? `<ul class="changes">${changes.map((c) => {
    const pre = (v) => (/\n/.test(v) || v.length > 80 ? `<pre>${esc(v)}</pre>` : `<span>${esc(v)}</span>`);
    if (action === 'added' || action === 'invited') return `<li><strong>${esc(c.field)}:</strong> ${pre(c.to)}</li>`;
    if (action === 'deleted' || action === 'revoked') return `<li><strong>${esc(c.field)}:</strong> <del>${pre(c.from)}</del></li>`;
    return `<li><strong>${esc(c.field)}:</strong> ${c.from ? `<del>${pre(c.from)}</del>` : '<span class="muted">(empty)</span>'} → ${c.to ? `<ins>${pre(c.to)}</ins>` : '<span class="muted">(empty)</span>'}</li>`;
  }).join('')}</ul>` : '<span class="muted small">No field changes</span>');

  shell(ADMIN_TABS, '#/admin/team', `
    <div class="page-head"><div><h1>Team</h1><p class="muted">Team members can add clients, send invites and manage orders, batches and invoices. Only you can manage the team and Settings.</p></div></div>
    <div class="stack">
      <form class="card card-pad" id="team-form">
        <h2 style="margin-bottom:14px">Add a team member</h2>
        <div class="grid-2">
          <div class="field"><label for="t-email">Email</label><input id="t-email" name="email" type="email" required></div>
          <div class="field"><label for="t-name">Name</label><input id="t-name" name="name" placeholder="Shown in the activity log and emails"></div>
        </div>
        <div class="row"><button class="btn btn-primary" type="submit">Send team invite</button><span class="muted small">They set their own password from the invite link.</span></div>
        <div class="error"></div>
        <div id="team-link"></div>
      </form>

      <div class="card">
        <div class="card-head"><h2>Members</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Account</th><th>Added</th><th></th></tr></thead>
          <tbody>${members.map((m) => `<tr>
            <td>${esc(m.name || '—')}</td><td>${esc(m.email)}</td>
            <td>${m.role === 'admin' ? '<span class="badge b-in_progress">Owner</span>' : 'Team member'}</td>
            <td>${m.password_set ? '<span class="badge b-active">Joined</span>' : '<span class="badge b-pending">Not joined</span>'}</td>
            <td>${fmtDate(m.created_at)}</td>
            <td>${m.role === 'staff' ? `<button class="btn btn-sm btn-danger" data-remove-member="${m.id}" data-email="${esc(m.email)}">Remove</button>` : ''}</td>
          </tr>`).join('')}
          ${invites.map((i) => `<tr><td>${esc(i.name || '—')}</td><td>${esc(i.email)}</td><td>Team member</td><td><span class="badge b-in_progress">Invited</span></td><td>${fmtDate(i.created_at)}</td>
            <td><button class="btn btn-sm btn-ghost" data-revoke-team="${i.id}">Revoke invite</button></td></tr>`).join('')}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-head"><div><h2>Activity log</h2><div class="muted small">Every change in the admin panel. Team members' changes are also emailed to you (see Settings).</div></div></div>
        ${log.length ? `<div class="table-wrap"><table class="activity">
          <thead><tr><th style="width:140px">When</th><th style="width:200px">Who</th><th>What changed</th></tr></thead>
          <tbody>${log.map((e) => `<tr>
            <td>${ago(e.created_at)}</td>
            <td>${esc(e.actor_name || e.actor_email)}<div class="muted small">${e.actor_role === 'admin' ? 'Owner' : 'Team member'}</div></td>
            <td><div><strong>${esc(verb[e.action] || e.action)}</strong> ${esc(e.title)}</div>${changeList(e.changes || [], e.action)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No activity yet.</div>'}
      </div>
    </div>`);

  onSubmit(document.getElementById('team-form'), async (d) => {
    const r = await api('POST', `${API()}/team`, d);
    renderTeam(await api('GET', `${API()}/team`));
    document.getElementById('team-link').innerHTML = `<div class="note" style="margin-top:12px"><span class="note-icon">🔗</span><div style="flex:1;min-width:0">
      <strong>Team invite for ${esc(d.email)}</strong> ${r.emailed ? '(also emailed)' : '(not emailed — share it yourself)'}
      <div class="row" style="margin-top:8px;flex-wrap:nowrap"><input readonly value="${esc(r.link)}"></div></div></div>`;
  });
  document.querySelectorAll('[data-remove-member]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Remove ${b.dataset.email} from the team? They lose access to the admin panel immediately.`)) return;
      try { await api('DELETE', `${API()}/team/${b.dataset.removeMember}`); toast('Team member removed'); route(); } catch (ex) { toast(ex.message); }
    };
  });
  document.querySelectorAll('[data-revoke-team]').forEach((b) => {
    b.onclick = async () => {
      try { await api('DELETE', `${API()}/invites/${b.dataset.revokeTeam}`); toast('Invite revoked'); route(); } catch (ex) { toast(ex.message); }
    };
  });
}

function adminSettings() {
  const { pricing, mailEnabled, today, settings } = state.admin;
  shell(ADMIN_TABS, '#/admin/settings', `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="stack">
      <form class="card card-pad" id="settings">
        <h2 style="margin-bottom:14px">Orders &amp; clients</h2>
        <div class="field"><label for="s-emails">Send new-order notifications to</label>
          <input id="s-emails" name="order_notify_emails" required value="${esc(settings.order_notify_emails)}">
          <div class="hint">One or more emails, separated by commas.</div></div>
        <div class="field"><label for="s-activity">Send team activity (who changed what) to</label>
          <input id="s-activity" name="activity_emails" value="${esc(settings.activity_emails || settings.order_notify_emails)}">
          <div class="hint">You get an email whenever a team member adds, edits or deletes something, with the before and after.</div></div>
        <h3 class="section-title">Email footer</h3>
        <div class="grid-2">
          <div class="field"><label for="s-web">Website</label><input id="s-web" name="website_url" value="${esc(settings.website_url)}"></div>
          <div class="field"><label for="s-priv">Privacy policy link</label><input id="s-priv" name="privacy_url" value="${esc(settings.privacy_url)}"></div>
        </div>
        <div class="field"><label for="s-terms">Terms link</label><input id="s-terms" name="terms_url" value="${esc(settings.terms_url)}"><div class="hint">Shown in the footer of every email, with your support email (Cancellation requests go to).</div></div>
        <div class="row" style="margin:-6px 0 18px"><button type="button" class="btn btn-sm" id="test-email">Send test email to me</button><span class="muted small">Preview the email design in your inbox.</span></div>
        <h3 class="section-title">Orders</h3>
        <div class="field"><label for="s-min">Require the onboarding CSV for orders of at least</label>
          <input id="s-min" name="csv_required_min" type="number" min="0" max="10000" required value="${esc(settings.csv_required_min)}" style="max-width:160px">
          <div class="hint">Mailboxes. Set to 0 to make the CSV optional for every order.</div></div>
        <div class="field"><label for="s-support">Cancellation requests go to</label>
          <input id="s-support" name="support_email" type="email" required value="${esc(settings.support_email)}" style="max-width:360px">
          <div class="hint">Clients' Cancel button prepares an email to this address.</div></div>
        <div class="field"><label for="s-cancel">Cancellation note shown to clients</label>
          <textarea id="s-cancel" name="cancel_note" style="font-family:inherit;min-height:72px" required>${esc(settings.cancel_note)}</textarea></div>
        <button class="btn btn-primary" type="submit">Save settings</button>
        <div class="error"></div>
      </form>
      <form class="card" id="prices">
        <div class="card-head"><div><h2>Mailbox types &amp; standard prices</h2>
          <div class="muted small">Price per mailbox per month (USD), used for every client without custom pricing (Clients &amp; invites → Edit pricing). Existing batches keep the price they were ordered at.</div></div></div>
        <div class="table-wrap"><table class="types-table">
          <thead><tr><th style="min-width:200px">Name</th><th style="min-width:260px">Description (shown to clients when ordering)</th><th class="num" style="width:130px">Price ($)</th><th style="width:130px">Offer to clients</th><th style="width:70px"></th></tr></thead>
          <tbody>${pricing.map((p) => `<tr data-type="${esc(p.inbox_type)}">
            <td><input data-f="label" value="${esc(p.label)}" required></td>
            <td><input data-f="description" value="${esc(p.description || '')}" placeholder="Optional"></td>
            <td><input data-f="price_per_mailbox" type="number" step="0.01" min="0" required value="${p.price_per_mailbox}" class="num"></td>
            <td><label class="check"><input type="checkbox" data-f="active" ${p.active !== false ? 'checked' : ''}> ${p.active !== false ? 'Yes' : 'Hidden'}</label></td>
            <td><button type="button" class="btn btn-sm btn-ghost" data-del-type="${esc(p.inbox_type)}" title="Delete (only if never used)" aria-label="Delete">✕</button></td>
          </tr>`).join('')}
          <tr class="add-type-row">
            <td><input id="nt-label" placeholder="New type, e.g. Zoho Mail"></td>
            <td><input id="nt-desc" placeholder="Optional description"></td>
            <td><input id="nt-price" type="number" step="0.01" min="0" placeholder="0.00" class="num"></td>
            <td colspan="2"><button type="button" class="btn btn-sm" id="add-type">+ Add mailbox type</button></td>
          </tr></tbody>
        </table></div>
        <div class="card-pad" style="padding-top:12px"><button class="btn btn-primary" type="submit">Save changes</button> <span class="muted small">Hidden types disappear from the client's New order page but existing batches keep working.</span>
          <div class="error"></div></div>
      </form>
      <div class="card card-pad">
        <h2>Renewal reminders</h2>
        <p class="muted" style="margin:6px 0 14px">Clients get an in-portal notification${mailEnabled ? ' and an email' : ''} 7, 3 and 1 day before each batch renews. The check runs every hour; today is ${fmtDate(today)} (billing timezone).
        ${mailEnabled ? '' : '<br><strong>Email is not configured</strong>: set the SMTP_* environment variables on Render to send emails.'}</p>
        <div class="row"><button class="btn" id="run">Run the check now</button><span class="muted small" id="run-out"></span></div>
      </div>
    </div>`);

  document.getElementById('test-email').onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await api('POST', `${API()}/test-email`, {}); toast(`Test email sent to ${r.to}`); } catch (ex) { toast(ex.message); }
    e.target.disabled = false;
  };
  onSubmit(document.getElementById('settings'), async (d) => {
    await api('PUT', `${API()}/settings`, d);
    toast('Settings saved');
  });
  onSubmit(document.getElementById('prices'), async () => {
    const prices = [...document.querySelectorAll('#prices tr[data-type]')].map((tr) => ({
      inbox_type: tr.dataset.type,
      label: tr.querySelector('[data-f=label]').value,
      description: tr.querySelector('[data-f=description]').value,
      price_per_mailbox: tr.querySelector('[data-f=price_per_mailbox]').value,
      active: tr.querySelector('[data-f=active]').checked,
    }));
    await api('PUT', `${API()}/pricing`, { prices });
    toast('Mailbox types saved');
    reloadAdmin();
  });
  document.getElementById('add-type').onclick = async () => {
    const label = document.getElementById('nt-label').value.trim();
    const price = document.getElementById('nt-price').value;
    if (!label || price === '') { toast('Enter a name and a price for the new type'); return; }
    try {
      await api('POST', `${API()}/pricing/types`, { label, price_per_mailbox: price, description: document.getElementById('nt-desc').value });
      toast(`${label} added`);
      reloadAdmin();
    } catch (ex) { toast(ex.message); }
  };
  document.querySelectorAll('[data-del-type]').forEach((b) => {
    b.onclick = async () => {
      const name = b.closest('tr').querySelector('[data-f=label]').value;
      if (!confirm(`Delete the mailbox type "${name}"? This only works if no batch or invoice uses it.`)) return;
      try { await api('DELETE', `${API()}/pricing/types/${encodeURIComponent(b.dataset.delType)}`); toast(`${name} deleted`); reloadAdmin(); } catch (ex) { toast(ex.message); }
    };
  });
  document.getElementById('run').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('POST', `${API()}/billing/run`, {});
      document.getElementById('run-out').textContent = `Checked ${r.checked} active batches, sent ${r.remindersSent} reminders.`;
    } catch (ex) { toast(ex.message); } finally { e.target.disabled = false; }
  };
}

route();

// ------------------------------------------------------------------ analytics (owner)

const monthName = (ym, opts = { month: 'short', year: 'numeric' }) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
const compact = (n, isMoney) => {
  const v = Number(n || 0);
  const s = Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '')}K` : String(Math.round(v * 100) / 100);
  return isMoney ? `$${s}` : s;
};
const count = (n) => Number(n || 0).toLocaleString('en-US');

// "+12.5%" against the comparison value, coloured by whether up is good.
function delta(now, before, { upIsGood = true } = {}) {
  now = Number(now || 0); before = Number(before || 0);
  if (now === before) return '<span class="delta flat">No change</span>';
  if (!before) return `<span class="delta ${upIsGood ? 'up' : 'down'}">New</span>`;
  const pct = ((now - before) / before) * 100;
  const good = (pct > 0) === upIsGood;
  return `<span class="delta ${good ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%</span>`;
}

let chartTip;
function showTip(evt, html) {
  if (!chartTip) { chartTip = document.createElement('div'); chartTip.className = 'chart-tip'; document.body.appendChild(chartTip); }
  chartTip.innerHTML = html;
  chartTip.style.display = 'block';
  const r = chartTip.getBoundingClientRect();
  let x = evt.clientX + 14;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 14;
  chartTip.style.left = `${Math.max(8, x)}px`;
  chartTip.style.top = `${Math.max(8, evt.clientY - r.height - 12)}px`;
}
const hideTip = () => { if (chartTip) chartTip.style.display = 'none'; };

// One-series column or line chart in plain SVG, sized to its container.
// points: [{ label, value, tip }]; the last point is the month in progress.
function drawChart(el, points, { kind = 'bar', money: isMoney = false } = {}) {
  const W = Math.max(260, el.clientWidth), H = 200, L = 46, R = 12, T = 12, B = 26;
  const max = Math.max(...points.map((p) => Number(p.value) || 0), 0);
  const step = (() => {
    if (!max) return 1;
    const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  })();
  const top = Math.max(step * Math.ceil(max / step), step);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const band = (W - L - R) / points.length;
  const cx = (i) => L + band * i + band / 2;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const every = Math.ceil(points.length / Math.floor((W - L - R) / 46));

  let marks = '';
  if (kind === 'bar') {
    const bw = Math.min(24, band - 2);
    points.forEach((p, i) => {
      const v = Number(p.value) || 0;
      if (!v) return;
      const x = cx(i) - bw / 2, yt = y(v), h = y(0) - yt, r = Math.min(4, h, bw / 2);
      marks += `<path class="mark${i === points.length - 1 ? ' current' : ''}" data-i="${i}" d="M${x},${y(0)}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + bw - r}Q${x + bw},${yt} ${x + bw},${yt + r}V${y(0)}Z"/>`;
    });
  } else {
    const pts = points.map((p, i) => `${cx(i)},${y(Number(p.value) || 0)}`);
    marks += `<path class="area" d="M${cx(0)},${y(0)}L${pts.join('L')}L${cx(points.length - 1)},${y(0)}Z"/>`;
    marks += `<path class="line" d="M${pts.join('L')}"/>`;
    const last = points.length - 1;
    marks += `<circle class="dot" cx="${cx(last)}" cy="${y(Number(points[last].value) || 0)}" r="4"/>`;
    marks += `<line class="cross" x1="0" x2="0" y1="${T}" y2="${y(0)}" style="display:none"/><circle class="hover-dot" r="4" style="display:none"/>`;
  }

  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
    ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v, isMoney)}</text>`).join('')}
    ${points.map((p, i) => ((points.length - 1 - i) % every === 0 ? `<text class="axis" x="${cx(i)}" y="${H - 8}" text-anchor="middle">${esc(p.label)}</text>` : '')).join('')}
    ${marks}
    ${points.map((p, i) => `<rect class="hit" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}"/>`).join('')}
  </svg>`;

  const svg = el.querySelector('svg');
  svg.querySelectorAll('.hit').forEach((hit) => {
    const i = Number(hit.dataset.i);
    hit.addEventListener('mousemove', (e) => {
      showTip(e, points[i].tip);
      if (kind === 'bar') {
        svg.querySelectorAll('.mark').forEach((m) => m.classList.toggle('dim', m.dataset.i !== String(i)));
      } else {
        const cross = svg.querySelector('.cross'), dot = svg.querySelector('.hover-dot');
        cross.setAttribute('x1', cx(i)); cross.setAttribute('x2', cx(i)); cross.style.display = '';
        dot.setAttribute('cx', cx(i)); dot.setAttribute('cy', y(Number(points[i].value) || 0)); dot.style.display = '';
      }
    });
    hit.addEventListener('mouseleave', () => {
      hideTip();
      svg.querySelectorAll('.mark').forEach((m) => m.classList.remove('dim'));
      svg.querySelectorAll('.cross,.hover-dot').forEach((m) => { m.style.display = 'none'; });
    });
  });
}

let analyticsRange = 12;
function renderAnalytics(data) {
  const { months, lastMonthToDate: prev, outstanding, byType, topClients, recentPayments, today, bySeller = [] } = data;
  const cur = months[months.length - 1];
  const last = months[months.length - 2];
  const day = Number(today.slice(8));
  const thisName = monthName(cur.month, { month: 'long' });
  const lastName = monthName(last.month, { month: 'long' });
  const prevEndDay = new Date(Date.parse(`${prev.pe}T00:00:00Z`) - 86400000).getUTCDate(); // pe is exclusive
  const sameDays = `vs ${monthName(last.month, { month: 'short' })} 1–${prevEndDay}`;
  const endOfLast = `vs end of ${lastName}`;

  // Flow figures compare with the same days of last month; standing figures
  // (active clients, MRR, mailboxes) compare with where last month ended.
  const tile = (label, value, d, sub) => `<div class="card kpi">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-delta">${d}</div>
    <div class="kpi-sub">${sub}</div>
  </div>`;
  const kpis = [
    tile('Payments received', money(cur.payments), `${delta(cur.payments, prev.payments)} <span class="muted">${sameDays}</span>`,
      `${count(cur.payment_count)} payment${cur.payment_count === 1 ? '' : 's'} · ${lastName} total ${money(last.payments)}`),
    tile('New clients', count(cur.new_clients), `${delta(cur.new_clients, prev.new_clients)} <span class="muted">${sameDays}</span>`,
      `${lastName} total ${count(last.new_clients)}`),
    tile('Active clients', count(cur.active_clients), `${delta(cur.active_clients, last.active_clients)} <span class="muted">${endOfLast}</span>`,
      `${lastName}: ${count(last.active_clients)}`),
    tile('Monthly recurring revenue', money(cur.mrr), `${delta(cur.mrr, last.mrr)} <span class="muted">${endOfLast}</span>`,
      `${lastName}: ${money(last.mrr)}`),
    tile('Active mailboxes', count(cur.mailboxes), `${delta(cur.mailboxes, last.mailboxes)} <span class="muted">${endOfLast}</span>`,
      `${lastName}: ${count(last.mailboxes)}`),
    tile('Invoiced', money(cur.invoiced), `${delta(cur.invoiced, prev.invoiced)} <span class="muted">${sameDays}</span>`,
      `${lastName} total ${money(last.invoiced)}`),
    tile('New batches', count(cur.new_batches), `${delta(cur.new_batches, prev.new_batches)} <span class="muted">${sameDays}</span>`,
      `${lastName} total ${count(last.new_batches)}`),
    tile('Cancelled batches', count(cur.cancellations), `${delta(cur.cancellations, prev.cancellations, { upIsGood: false })} <span class="muted">${sameDays}</span>`,
      `${lastName} total ${count(last.cancellations)}`),
  ].join('');

  const CHARTS = [
    ['payments', 'Payments received', 'bar', true, (m) => money(m.payments), (m) => `${count(m.payment_count)} payment${m.payment_count === 1 ? '' : 's'}`],
    ['mrr', 'Monthly recurring revenue', 'line', true, (m) => money(m.mrr), (m) => `${count(m.mailboxes)} mailboxes`],
    ['active_clients', 'Active clients', 'line', false, (m) => count(m.active_clients), () => ''],
    ['new_clients', 'New clients', 'bar', false, (m) => count(m.new_clients), () => ''],
    ['mailboxes', 'Active mailboxes', 'line', false, (m) => count(m.mailboxes), () => ''],
    ['new_batches', 'New batches', 'bar', false, (m) => count(m.new_batches), (m) => `${count(m.cancellations)} cancelled`],
  ];
  const maxType = Math.max(...byType.map((t) => Number(t.mrr)), 0) || 1;

  shell(ADMIN_TABS, '#/admin/analytics', `
    <div class="page-head"><div><h1>Analytics</h1><div class="muted small">${thisName} so far (1–${day}) compared with ${lastName}</div></div>
      <div class="seg" role="group" aria-label="Chart range">${[6, 12].map((n) => `<button type="button" data-range="${n}" class="${n === analyticsRange ? 'on' : ''}">${n} months</button>`).join('')}</div></div>
    <div class="stack">
      <div class="kpis">${kpis}</div>
      <div class="note note-info"><span><strong>Outstanding:</strong> ${money(outstanding.unpaid)} across ${count(outstanding.unpaid_count)} unpaid invoice${outstanding.unpaid_count === 1 ? '' : 's'}${outstanding.overdue_count ? `, of which <strong>${money(outstanding.overdue)}</strong> (${count(outstanding.overdue_count)}) is past due` : ''}. <a href="#/admin/invoices">View invoices</a></span></div>
      <div class="charts">${CHARTS.map(([key, title]) => `<div class="card chart-card"><div class="chart-head"><h2>${title}</h2><div class="chart-now" id="now-${key}"></div></div><div class="chart" id="chart-${key}"></div></div>`).join('')}</div>
      <div class="charts">
        <div class="card"><div class="card-head"><div><h2>Recurring revenue by type</h2><div class="muted small">Active batches, per month</div></div></div>
          <div class="card-pad">${byType.length ? byType.map((t) => `<div class="hbar"><div class="hbar-top"><span>${esc(t.label)}</span><span><strong>${money(t.mrr)}</strong> <span class="muted small">· ${count(t.quantity)}</span></span></div><div class="hbar-track"><div class="hbar-fill" style="width:${(Number(t.mrr) / maxType) * 100}%"></div></div></div>`).join('') : '<p class="muted">No active batches yet.</p>'}</div></div>
        <div class="card"><div class="card-head"><div><h2>Top clients by payments</h2><div class="muted small">${thisName} vs ${lastName}</div></div></div>
          ${topClients.length ? `<div class="table-wrap"><table><thead><tr><th>Client</th><th class="num">${monthName(cur.month, { month: 'short' })}</th><th class="num">${monthName(last.month, { month: 'short' })}</th></tr></thead><tbody>
            ${topClients.map((c) => `<tr><td><strong>${esc(c.company || c.name || c.email)}</strong><div class="muted small">${esc(c.email)}</div></td><td class="num">${money(c.this_month)}</td><td class="num">${money(c.last_month)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="card-pad muted">No payments in the last two months.</div>'}</div>
      </div>
      <div class="card"><div class="card-head"><div><h2>Sales by team member</h2><div class="muted small">Payments received, by who made the sale (Sold by on the invoice or its batch)</div></div></div>
        ${bySeller.length ? `<div class="table-wrap"><table><thead><tr><th>Sold by</th><th class="num">${monthName(cur.month, { month: 'long' })}</th><th class="num">${lastName}</th></tr></thead><tbody>
          ${bySeller.map((r) => `<tr><td>${r.seller ? `<strong>${esc(r.seller)}</strong>` : '<span class="muted">Not set</span>'}</td>
            <td class="num">${money(r.this_month)}<div class="muted small">${count(r.this_count)} payment${r.this_count === 1 ? '' : 's'}</div></td>
            <td class="num">${money(r.last_month)}<div class="muted small">${count(r.last_count)} payment${r.last_count === 1 ? '' : 's'}</div></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="card-pad muted">No payments in the last two months.</div>'}</div>
      <div class="card"><div class="card-head"><h2>Recent payments</h2></div>
        ${recentPayments.length ? `<div class="table-wrap"><table><thead><tr><th>Paid</th><th>Client</th><th>Invoice</th><th class="num">Amount</th></tr></thead><tbody>
          ${recentPayments.map((p) => `<tr><td>${fmtDate(p.paid_at)}</td><td>${esc(p.company || p.email)}</td><td><a href="#/admin/invoice/${p.id}">#${p.id}</a> <span class="muted small">${esc(p.description)}</span></td><td class="num">${money(p.amount)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="card-pad muted">No payments recorded yet.</div>'}</div>
      <div class="card"><div class="card-head"><div><h2>Month by month</h2><div class="muted small">${monthName(cur.month, { month: 'long' })} is to date</div></div></div>
        <div class="table-wrap"><table><thead><tr><th>Month</th><th class="num">Payments</th><th class="num">Invoiced</th><th class="num">MRR</th><th class="num">Active clients</th><th class="num">New clients</th><th class="num">Mailboxes</th><th class="num">New batches</th><th class="num">Cancelled</th></tr></thead><tbody id="month-rows"></tbody></table></div></div>
    </div>`);

  const draw = () => {
    const shown = months.slice(-analyticsRange);
    CHARTS.forEach(([key, title, kind, isMoney, fmtV, extra]) => {
      const el = document.getElementById(`chart-${key}`);
      if (!el) return;
      document.getElementById(`now-${key}`).innerHTML = `<span class="chart-value">${fmtV(cur)}</span> ${['payments', 'new_clients', 'new_batches'].includes(key) ? delta(cur[key], prev[key]) : delta(cur[key], last[key])}`;
      drawChart(el, shown.map((m, i) => ({
        label: monthName(m.month, { month: 'short' }),
        value: m[key],
        tip: `<div class="tip-title">${monthName(m.month, { month: 'long', year: 'numeric' })}${i === shown.length - 1 ? ' (to date)' : ''}</div><div class="tip-value">${fmtV(m)}</div>${extra(m) ? `<div class="tip-sub">${extra(m)}</div>` : ''}`,
      })), { kind, money: isMoney });
    });
    document.getElementById('month-rows').innerHTML = [...shown].reverse().map((m) => `<tr>
      <td>${monthName(m.month)}</td><td class="num">${money(m.payments)}</td><td class="num">${money(m.invoiced)}</td><td class="num">${money(m.mrr)}</td>
      <td class="num">${count(m.active_clients)}</td><td class="num">${count(m.new_clients)}</td><td class="num">${count(m.mailboxes)}</td>
      <td class="num">${count(m.new_batches)}</td><td class="num">${count(m.cancellations)}</td></tr>`).join('');
  };
  draw();
  document.querySelectorAll('.seg button').forEach((b) => {
    b.onclick = () => {
      analyticsRange = Number(b.dataset.range);
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      draw();
    };
  });
  let t;
  window.onresize = () => {
    clearTimeout(t);
    t = setTimeout(() => { if (location.hash.startsWith('#/admin/analytics')) draw(); else window.onresize = null; }, 150);
  };
}

// ------------------------------------------------------------------ reseller portal

// A reseller's clients: added here, never invited (they don't log in), and
// billed by email.
function resellerClients() {
  const { clients, whiteLabel } = state.admin;
  shell(ADMIN_TABS, '#/admin/clients', `
    <div class="page-head"><div><h1>Clients</h1><p class="muted">Your clients get their invoices and renewal reminders by email${whiteLabel ? ', under your brand' : ''}. They don't log in to the portal.</p></div></div>
    <div class="stack">
      <form class="card card-pad" id="add-client-form">
        <h2 style="margin-bottom:14px">Add a client</h2>
        <div class="grid-2">
          <div class="field"><label for="rc-email">Email</label><input id="rc-email" name="email" type="email" required></div>
          <div class="field"><label for="rc-name">Name</label><input id="rc-name" name="name"></div>
        </div>
        <div class="field"><label for="rc-company">Company</label><input id="rc-company" name="company"></div>
        <div class="row"><button class="btn btn-primary" type="submit">Add client</button><span class="muted small">Then add their batches and billing.</span></div>
        <div class="error"></div>
      </form>
      <div class="card">
        <div class="card-head"><h2>Your clients</h2><span class="muted small">${clients.length} total</span></div>
        ${clients.length ? filterBar('rclients', [{ name: 'active', label: 'Mailboxes: any', options: [['yes', 'Has active mailboxes'], ['no', 'No active mailboxes']] }]) : ''}
        ${clients.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Client</th><th class="num">Active mailboxes</th><th class="num">Monthly</th><th>Added</th><th></th></tr></thead>
          <tbody>${clients.map((c) => `<tr data-id="${c.id}" data-search="${searchText(c.company, c.name, c.email)}" data-active="${c.active_mailboxes > 0 ? 'yes' : 'no'}">
            <td>${esc(c.company || c.name || c.email)}<div class="muted small">${c.name && c.company ? `${esc(c.name)} · ` : ''}${esc(c.email)}</div></td>
            <td class="num">${c.active_mailboxes}</td><td class="num">${money(c.monthly)}</td><td>${fmtDate(c.created_at)}</td>
            <td><div class="row client-actions"><button class="btn btn-sm btn-primary" data-batch="${c.id}">+ Add batch</button><button class="btn btn-sm" data-edit="${c.id}">Edit</button><button class="btn btn-sm btn-danger" data-delete-client="${c.id}">Delete</button></div></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No clients yet. Add your first one above.</div>'}
      </div>
    </div>`);

  wireFilterBar('rclients');
  onSubmit(document.getElementById('add-client-form'), async (d) => {
    const r = await api('POST', `${API()}/clients`, d);
    toast(`${d.email} added. Now add their batches.`);
    state.admin = await api('GET', `${API()}/overview`);
    resellerClients();
    openBatchDialog(r.id);
  });
  document.querySelectorAll('[data-batch]').forEach((b) => { b.onclick = () => openBatchDialog(Number(b.dataset.batch)); });
  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openClientDialog(clients.find((c) => c.id === Number(b.dataset.edit)));
  });
  document.querySelectorAll('[data-delete-client]').forEach((b) => {
    b.onclick = async () => {
      const c = clients.find((x) => x.id === Number(b.dataset.deleteClient));
      const typed = prompt(`Delete ${c.company || c.name || c.email} permanently?\n\nThis deletes the client with all their batches and invoices. ` +
        `It can't be undone.\n\nType the client's email to confirm:\n${c.email}`);
      if (typed === null) return;
      if (typed.trim().toLowerCase() !== c.email) return toast('The email didn\'t match. Nothing was deleted.');
      try {
        await api('DELETE', `${API()}/clients/${c.id}`);
        toast(`${c.email} deleted`);
        reloadAdmin();
      } catch (ex) { toast(ex.message); }
    };
  });
}

function resellerSettings(st) {
  shell(ADMIN_TABS, '#/admin/settings', `
    <div class="page-head"><div><h1>Settings</h1><p class="muted">How your clients' emails and invoices look.</p></div></div>
    <div class="stack">
      <div class="card card-pad">
        <div class="row" style="justify-content:space-between;align-items:center">
          <div><h2>White-label</h2><div class="muted small" style="margin-top:4px">${st.white_label
            ? 'On: your clients\' invoices and reminder emails carry your brand, sender name and payment details.'
            : 'Off: your clients\' emails and invoices are sent under the MithMill brand. Contact MithMill to turn on white-label.'}</div></div>
          <span class="badge ${st.white_label ? 'b-active' : 'b-pending'}">${st.white_label ? 'On' : 'Off'}</span>
        </div>
        ${st.white_label ? `<div class="brand-preview">
          ${st.logo ? `<img src="${esc(st.logo)}" alt="">` : ''}<div><strong>${esc(st.brand_name)}</strong>${st.website ? `<div class="muted small">${esc(st.website)}</div>` : ''}
          <div class="muted small">Brand name, logo${st.sender_email ? ' and sending address' : ''} are set up by MithMill.</div></div></div>` : ''}
      </div>
      ${st.white_label ? `<form class="card card-pad" id="rs-form">
        <h2 style="margin-bottom:14px">Your clients' emails</h2>
        <div class="grid-2">
          <div class="field"><label>Sender name</label><input name="sender_name" value="${esc(st.sender_name)}" placeholder="${esc(st.brand_name)}"><div class="hint">Shown as who the email is from.</div></div>
          <div class="field"><label>Reply-to email</label><input name="reply_to" type="email" value="${esc(st.reply_to)}" placeholder="billing@yourcompany.com"><div class="hint">Where your clients' replies (and payment screenshots) go.</div></div>
        </div>
        ${st.sender_email ? `<p class="muted small" style="margin:-4px 0 14px">Emails are sent from <strong>${esc(st.sender_email)}</strong>.</p>` : ''}
        <div class="field"><label>Support email (in the email footer)</label><input name="support_email" type="email" value="${esc(st.support_email)}"></div>
        <div class="field"><label>Payment details</label><textarea name="payment_note" style="min-height:110px" placeholder="e.g. bank details, or a payment link such as https://buy.stripe.com/...">${esc(st.payment_note)}</textarea>
          <div class="hint">Shown on every invoice and reminder email. Per-invoice payment links go in the invoice's notes, where they become Pay buttons.</div></div>
        <button class="btn btn-primary" type="submit">Save</button>
        <div class="error"></div>
      </form>` : ''}
    </div>`);
  const f = document.getElementById('rs-form');
  if (f) onSubmit(f, async (d) => { await api('PUT', '/api/reseller/settings', d); toast('Settings saved'); route(); });
}

// ------------------------------------------------------------------ resellers (owner)

function renderResellers({ resellers, mailEnabled }) {
  shell(ADMIN_TABS, '#/admin/resellers', `
    <div class="page-head"><div><h1>Resellers</h1><p class="muted">Partners who manage their own clients' billing. Only you see this page.</p></div></div>
    <div class="stack">
      <form class="card card-pad" id="rs-invite">
        <h2 style="margin-bottom:14px">Invite a reseller</h2>
        <div class="grid-2">
          <div class="field"><label>Email</label><input name="email" type="email" required></div>
          <div class="field"><label>Name</label><input name="name"></div>
        </div>
        <div class="field"><label>Company (their brand name)</label><input name="company"></div>
        <div class="row"><button class="btn btn-primary" type="submit">Invite reseller</button><span class="muted small">${mailEnabled ? 'They get an email to set their password; you also get the link.' : 'Email isn\'t set up: copy the link and send it yourself.'}</span></div>
        <div class="error"></div>
        <div id="rs-link"></div>
      </form>
      <div class="card">
        <div class="card-head"><h2>Resellers</h2><span class="muted small">${resellers.length} total</span></div>
        ${resellers.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Reseller</th><th>Access</th><th>White-label</th><th class="num">Clients</th><th class="num">Mailboxes</th><th class="num">Monthly</th><th class="num">Unpaid</th><th></th></tr></thead>
          <tbody>${resellers.map((r) => `<tr>
            <td><a href="#/admin/resellers/${r.id}"><strong>${esc(r.brand_name || r.company || r.email)}</strong></a><div class="muted small">${esc(r.name ? `${r.name} · ` : '')}${esc(r.email)}</div></td>
            <td>${!r.active ? '<span class="badge b-cancelled">Turned off</span>' : r.password_set ? '<span class="badge b-active">Joined</span>' : '<span class="badge b-in_progress">Invited</span>'}</td>
            <td><label class="switch"><input type="checkbox" data-wl="${r.id}" ${r.white_label ? 'checked' : ''}><span></span></label></td>
            <td class="num">${r.clients}</td><td class="num">${r.mailboxes}</td><td class="num">${money(r.monthly)}</td><td class="num">${money(r.unpaid)}</td>
            <td><a class="btn btn-sm" href="#/admin/resellers/${r.id}">Open</a></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No resellers yet.</div>'}
      </div>
    </div>`);
  onSubmit(document.getElementById('rs-invite'), async (d) => {
    const r = await api('POST', '/api/admin/resellers', d);
    toast(`${d.email} invited`);
    location.hash = `#/admin/resellers/${r.id}`;
    setTimeout(() => showResellerLink(r, d.email), 600);
  });
  document.querySelectorAll('[data-wl]').forEach((cb) => {
    cb.onchange = async () => {
      try {
        await api('PUT', `/api/admin/resellers/${cb.dataset.wl}`, { white_label: cb.checked });
        toast(`White-label ${cb.checked ? 'on' : 'off'}`);
      } catch (ex) { toast(ex.message); cb.checked = !cb.checked; }
    };
  });
}

function showResellerLink(r, email) {
  const box = document.getElementById('rs-link');
  if (!box) return;
  box.innerHTML = `<div class="note" style="margin-top:12px"><span class="note-icon">🔗</span><div style="min-width:0;flex:1">
    <strong>${r.reset ? 'Password reset' : 'Invite'} link for ${esc(email)}</strong> ${r.emailed ? '(also emailed)' : '(not emailed — share it yourself)'}
    <div class="row" style="margin-top:8px;flex-wrap:nowrap"><input readonly value="${esc(r.link)}" id="rs-link-val"><button type="button" class="btn btn-sm" id="rs-copy">Copy</button></div></div></div>`;
  document.getElementById('rs-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(r.link); toast('Link copied'); } catch { document.getElementById('rs-link-val').select(); }
  };
}

function renderResellerDetail({ reseller: r, clients, orders, invoices, today }) {
  const active = orders.filter((o) => o.status === 'active');
  const unpaid = invoices.filter((i) => i.status === 'unpaid');
  shell(ADMIN_TABS, '#/admin/resellers', `
    <div class="page-head"><div><a class="muted small" href="#/admin/resellers">← Resellers</a><h1>${esc(r.brand_name || r.company || r.email)}</h1>
      <p class="muted">${esc(r.name ? `${r.name} · ` : '')}${esc(r.email)} · ${!r.active ? 'access turned off' : r.password_set ? 'joined' : 'invited, not joined yet'}</p></div>
      <div class="row"><button class="btn btn-sm" id="rs-resend">${r.password_set ? 'Password reset link' : 'Resend invite'}</button></div></div>
    <div class="stack">
      <div id="rs-link"></div>
      ${welcome('Their business', [
        [clients.length, 'Clients'], [active.reduce((n, o) => n + (o.inbox_type === 'other' ? 0 : o.quantity), 0), 'Active mailboxes'],
        [money(active.reduce((n, o) => n + o.quantity * o.price_per_mailbox, 0)), 'Monthly billing'],
        [money(unpaid.reduce((n, i) => n + i.amount, 0)), `Unpaid · ${unpaid.length}`],
      ], 'Reseller')}

      <form class="card card-pad" id="rs-brand">
        <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:14px">
          <div><h2>White-label</h2><div class="muted small" style="margin-top:4px">On: their clients' emails and invoices use the branding below. Off: they go out under MithMill's brand.</div></div>
          <label class="switch switch-lg"><input type="checkbox" name="white_label" ${r.white_label ? 'checked' : ''}><span></span></label>
        </div>
        <div class="grid-2">
          <div class="field"><label>Brand name</label><input name="brand_name" required value="${esc(r.brand_name)}"></div>
          <div class="field"><label>Website</label><input name="website" value="${esc(r.website)}" placeholder="https://"></div>
        </div>
        <div class="field"><label>Logo</label>
          <div class="row" style="align-items:center">
            <div class="logo-box">${r.has_logo ? `<img src="/brand/${r.id}/logo?v=${r.logo_version}" alt="">` : '<span class="muted small">No logo</span>'}</div>
            <label class="btn btn-sm">Upload logo<input type="file" id="rs-logo" accept="image/png,image/jpeg,image/gif,image/webp" hidden></label>
            ${r.has_logo ? '<button type="button" class="btn btn-sm btn-ghost" id="rs-logo-remove">Remove</button>' : ''}
          </div><div class="hint">PNG or JPG, up to 300 KB. A wide logo on a white or transparent background works best.</div></div>
        <div class="grid-2">
          <div class="field"><label>Sender name</label><input name="sender_name" value="${esc(r.sender_name)}" placeholder="${esc(r.brand_name)}"></div>
          <div class="field"><label>Reply-to email</label><input name="reply_to" type="email" value="${esc(r.reply_to)}"><div class="hint">Where their clients' replies go.</div></div>
        </div>
        <div class="field"><label>Support email (email footer)</label><input name="support_email" type="email" value="${esc(r.support_email)}"></div>
        <div class="field"><label>Payment details</label><textarea name="payment_note" style="min-height:90px" placeholder="Their payment method: bank details, or a payment link">${esc(r.payment_note)}</textarea>
          <div class="hint">Replaces the Mixxbee LLC notice on their clients' invoices and emails while white-label is on. The reseller can also edit this, the sender name and the reply-to.</div></div>
        <details class="smtp-box" ${r.smtp_host ? 'open' : ''}><summary><strong>Send from their own email address</strong> <span class="muted small">(optional: their mail server)</span></summary>
          <p class="muted small">Without this, their clients' emails come from the MithMill mail account under their sender name, with replies going to their reply-to email. With it, emails are sent from their own address. For Google Workspace: smtp.gmail.com, port 465, their email and an app password.</p>
          <div class="grid-2">
            <div class="field"><label>SMTP server</label><input name="smtp_host" value="${esc(r.smtp_host)}" placeholder="smtp.gmail.com"></div>
            <div class="field"><label>Port</label><input name="smtp_port" type="number" value="${esc(r.smtp_port)}"></div>
          </div>
          <div class="grid-2">
            <div class="field"><label>Username</label><input name="smtp_user" value="${esc(r.smtp_user)}" autocomplete="off"></div>
            <div class="field"><label>Password ${r.has_smtp_pass ? '<span class="muted small">(saved; leave blank to keep)</span>' : ''}</label><input name="smtp_pass" type="password" autocomplete="new-password"></div>
          </div>
          <div class="field"><label>Sending email</label><input name="sender_email" type="email" value="${esc(r.sender_email)}" placeholder="Same as the username"></div>
        </details>
        <div class="row" style="justify-content:space-between;margin-top:8px">
          <div class="row"><button class="btn btn-primary" type="submit">Save</button><button type="button" class="btn" id="rs-test">Send me a test email</button></div>
          <label class="check"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> Reseller can log in</label>
        </div>
        <div class="error"></div>
      </form>

      <div class="card">
        <div class="card-head"><div><h2>Their clients</h2><div class="muted small">The reseller doesn't see that you can see these.</div></div><span class="muted small">${clients.length}</span></div>
        ${clients.length ? `<div class="table-wrap"><table><thead><tr><th>Client</th><th class="num">Active mailboxes</th><th class="num">Monthly</th><th class="num">Batches</th><th>Added</th></tr></thead><tbody>
          ${clients.map((c) => `<tr><td><strong>${esc(c.company || c.name || c.email)}</strong><div class="muted small">${c.name && c.company ? `${esc(c.name)} · ` : ''}<a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div></td>
            <td class="num">${c.active_mailboxes}</td><td class="num">${money(c.monthly)}</td><td class="num">${c.batch_count}</td><td>${fmtDate(c.created_at)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No clients yet.</div>'}
      </div>

      <div class="card">
        <div class="card-head"><h2>Their batches</h2><span class="muted small">${active.length} active</span></div>
        ${orders.length ? `<div class="table-wrap"><table><thead><tr><th>Batch</th><th>Client</th><th class="num">Mailboxes</th><th class="num">Price</th><th>Renews</th><th>Status</th></tr></thead><tbody>
          ${orders.map((o) => `<tr><td>${esc(batchTitle(o))}<div class="muted small">${esc(o.inbox_label)}${o.domains ? ` · ${esc(o.domains.split('\n').filter(Boolean).length)} domain(s)` : ''}</div></td>
            <td>${esc(o.company || o.name || o.email)}<div class="muted small">${esc(o.email)}</div></td>
            <td class="num">${o.quantity}</td><td class="num">${money(o.price_per_mailbox)}<div class="muted small">${cycleName(cycleOf(o))}</div></td>
            <td>${o.status === 'active' && o.next_billing_date ? fmtDate(o.next_billing_date) : '—'}</td><td>${badge(o.status)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No batches yet.</div>'}
      </div>

      <div class="card">
        <div class="card-head"><h2>Their invoices</h2><span class="muted small">${unpaid.length} unpaid</span></div>
        ${invoices.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Client</th><th>Description</th><th>Due</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
          ${invoices.map((i) => {
            const st = i.status === 'unpaid' && i.due_date < today ? 'overdue' : i.status;
            return `<tr><td><a href="#/admin/invoice/${i.id}">${i.id}</a></td><td>${esc(i.company || i.email)}<div class="muted small">${esc(i.email)}</div></td>
              <td>${esc(i.description)}</td><td>${fmtDate(i.due_date)}</td><td>${badge(st)}</td><td class="num">${money(i.amount)}</td></tr>`;
          }).join('')}
        </tbody></table></div>` : '<div class="empty">No invoices yet.</div>'}
      </div>
    </div>`);

  const f = document.getElementById('rs-brand');
  onSubmit(f, async (d) => {
    await api('PUT', `/api/admin/resellers/${r.id}`, {
      ...d, white_label: f.white_label.checked, active: f.active.checked, smtp_port: Number(d.smtp_port) || 465,
    });
    toast('Reseller saved');
    route();
  });
  f.white_label.onchange = async () => {
    try {
      await api('PUT', `/api/admin/resellers/${r.id}`, { white_label: f.white_label.checked });
      toast(`White-label ${f.white_label.checked ? 'on' : 'off'}`);
    } catch (ex) { toast(ex.message); f.white_label.checked = !f.white_label.checked; }
  };
  document.getElementById('rs-test').onclick = async (e) => {
    e.target.disabled = true;
    try { const t = await api('POST', `/api/admin/resellers/${r.id}/test-email`, {}); toast(`Test email sent to ${t.to} via ${t.via}`); } catch (ex) { toast(ex.message); }
    e.target.disabled = false;
  };
  document.getElementById('rs-resend').onclick = async () => {
    try { showResellerLink(await api('POST', `/api/admin/resellers/${r.id}/invite`, {}), r.email); } catch (ex) { toast(ex.message); }
  };
  document.getElementById('rs-logo').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 300 * 1024) return toast('The logo must be 300 KB or smaller');
    const reader = new FileReader();
    reader.onload = async () => {
      try { await api('PUT', `/api/admin/resellers/${r.id}/logo`, { data_url: reader.result }); toast('Logo uploaded'); route(); } catch (ex) { toast(ex.message); }
    };
    reader.readAsDataURL(file);
  };
  const rm = document.getElementById('rs-logo-remove');
  if (rm) rm.onclick = async () => { await api('PUT', `/api/admin/resellers/${r.id}/logo`, { data_url: null }); toast('Logo removed'); route(); };
}

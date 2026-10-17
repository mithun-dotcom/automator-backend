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

// ------------------------------------------------------------------ state + router

const state = { me: undefined, dash: null, admin: null, order: null };

async function route() {
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\/?/, '').split('/');

  if (parts[0] === 'invite' && parts[1]) return renderInvite(parts[1]);

  if (state.me === undefined) {
    try { state.me = await api('GET', '/api/me'); } catch { state.me = null; }
  }
  if (!state.me) return renderLogin();
  if (parts[0] === 'login' || parts[0] === '') return go(state.me.role === 'admin' ? '#/admin' : '#/dashboard');

  try {
    if (parts[0] === 'password') return renderPassword();
    if (state.me.role === 'admin') {
      if (parts[0] !== 'admin') return go('#/admin');
      return await renderAdmin(parts[1] || 'orders', parts[2], parts[3]);
    }
    if (parts[0] === 'admin') return go('#/dashboard');
    return await renderClient(parts[0], parts[1]);
  } catch (ex) {
    $app.innerHTML = `<div class="boot">${esc(ex.message)}</div>`;
  }
}
window.addEventListener('hashchange', route);

function shell(tabs, active, content) {
  const unread = state.dash ? state.dash.notifications.filter((n) => !n.read_at).length : 0;
  const isClient = state.me.role !== 'admin';
  $app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/"><img class="logo" src="logo.png" alt="MithMill"></a>
      <nav class="nav">${tabs.map(([href, label]) => `<a href="${href}" class="${href === active ? 'active' : ''}">${label}</a>`).join('')}</nav>
      <div class="topbar-right">
        ${isClient ? `<a class="btn btn-ghost btn-sm bell" href="#/notifications" aria-label="Notifications">🔔${unread ? `<span class="dot">${unread}</span>` : ''}</a>` : ''}
        <a class="muted small" href="#/password" title="Change password">${esc(state.me.email)}</a>
        <button class="btn btn-sm" id="logout">Log out</button>
      </div>
    </header>
    <main class="main">${content}</main>`;
  document.getElementById('logout').onclick = async () => {
    await api('POST', '/api/auth/logout');
    Object.assign(state, { me: null, dash: null, admin: null, order: null });
    go('#/login');
  };
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
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary" style="width:100%" type="submit">Log in</button>
      <div class="error"></div>
    </form>
    <p class="muted small" style="margin:16px 0 0">Access is by invitation only. Need an account or forgot your password? Contact your Mithmill account manager.</p>`);
  onSubmit(document.getElementById('f'), async (d) => {
    const r = await api('POST', '/api/auth/login', d);
    state.me = await api('GET', '/api/me');
    go(r.role === 'admin' ? '#/admin' : '#/dashboard');
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
    go('#/dashboard');
  });
}

function renderPassword() {
  const tabs = state.me.role === 'admin' ? ADMIN_TABS : CLIENT_TABS;
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
    go(state.me.role === 'admin' ? '#/admin' : '#/dashboard');
  });
}

// ------------------------------------------------------------------ client

const CLIENT_TABS = [['#/dashboard', 'Dashboard'], ['#/order', 'New order'], ['#/billing', 'Billing']];

async function renderClient(page, arg) {
  state.dash = await api('GET', '/api/dashboard');
  if (page === 'invoice' && arg) return renderInvoiceView(await api('GET', `/api/invoices/${encodeURIComponent(arg)}`), false);
  if (page === 'order') return renderOrder();
  if (page === 'billing') return renderBilling();
  if (page === 'notifications') return renderNotifications();
  return renderDashboard();
}

function batchesTable(orders) {
  if (!orders.length) return '<div class="empty">No orders yet. Place your first order to get mailboxes set up.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Batch</th><th>Type</th><th class="num">Mailboxes</th><th>Status</th><th class="num">Monthly</th><th>Next renewal</th><th>Ordered</th><th></th></tr></thead>
    <tbody>${orders.map((o) => `<tr>
      <td>#${o.id}</td>
      <td>${esc(o.inbox_label)}<div class="muted small">${esc(lines(o.domains).slice(0, 2).join(', '))}${lines(o.domains).length > 2 ? '…' : ''}</div></td>
      <td class="num">${o.quantity}</td>
      <td>${badge(o.status)}</td>
      <td class="num">${money(o.quantity * o.price_per_mailbox)}</td>
      <td>${o.status === 'active' ? fmtDate(o.next_billing_date) : '—'}</td>
      <td>${fmtDate(o.created_at)}</td>
      <td>${o.status !== 'cancelled' ? `<button class="btn btn-sm btn-danger" data-cancel="${o.id}">Cancel</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// Clients cancel by emailing us from their registered address. This builds
// the pre-written request for one batch.
function cancelEmail(o) {
  const { user, appUrl } = state.dash;
  const subject = `Cancellation request: Batch #${o.id}`;
  const body = [
    'Hi Mithmill team,',
    '',
    'I would like to cancel all the inboxes from this order.',
    '',
    `Order name: Batch #${o.id} - ${o.inbox_label} (${o.quantity} mailboxes)`,
    `CSV sheet link: ${o.csv_rows ? `${appUrl}/api/admin/orders/${o.id}/onboarding.csv` : 'No CSV uploaded'}`,
    `Order creation date: ${fmtDate(o.created_at)}`,
    `Payment amount: ${money(o.quantity * o.price_per_mailbox)} per month`,
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
      <div><h1>Hi ${esc(user.name || 'there')}</h1><p class="muted">${esc(user.company || user.email)}</p></div>
      <a class="btn btn-primary" href="#/order">+ New order</a>
    </div>
    <div class="stack">
      <div class="stats">
        <div class="card stat"><div class="label">Active mailboxes</div><div class="value">${stats.activeMailboxes}</div><div class="sub">${stats.activeBatches} active batch${stats.activeBatches === 1 ? '' : 'es'}</div></div>
        <div class="card stat"><div class="label">Being set up</div><div class="value">${stats.pendingMailboxes}</div><div class="sub">pending mailboxes</div></div>
        <div class="card stat"><div class="label">Monthly billing</div><div class="value">${money(stats.monthlyBilling)}</div><div class="sub">Next renewal ${fmtDate(stats.nextRenewal)}</div></div>
        <div class="card stat"><div class="label">Outstanding</div><div class="value">${money(stats.outstanding)}</div><div class="sub">${stats.unpaidInvoices} unpaid invoice${stats.unpaidInvoices === 1 ? '' : 's'} · <a href="#/billing">View</a></div></div>
      </div>
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
          <tbody>${active.map((o) => `<tr><td>#${o.id}</td><td>${esc(o.inbox_label)}</td><td class="num">${o.quantity}</td><td>${fmtDate(o.next_billing_date)}</td><td class="num">${money(o.quantity * o.price_per_mailbox)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty">No active batches yet.</div>'}
      </div>
      <div class="card">
        <div class="card-head"><h2>Invoices</h2></div>
        ${invoices.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Invoice</th><th>Description</th><th>Due</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody>${invoices.map((i) => {
            const s = i.status === 'unpaid' && i.due_date < today ? 'overdue' : i.status;
            return `<tr><td><a href="#/invoice/${i.id}">#${i.id}</a></td><td>${esc(i.description)}</td><td>${fmtDate(i.due_date)}</td><td>${badge(s)}${i.paid_at ? `<div class="muted small">${fmtDate(i.paid_at)}</div>` : ''}</td><td class="num">${money(i.amount)}</td><td><a class="btn btn-sm" href="#/invoice/${i.id}">View</a></td></tr>`;
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
            <div class="t-desc">${esc(TYPE_INFO[p.inbox_type] || '')}</div>
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

const ADMIN_TABS = [['#/admin/orders', 'Orders'], ['#/admin/clients', 'Clients & invites'], ['#/admin/invoices', 'Invoices'], ['#/admin/settings', 'Settings']];

async function renderAdmin(page, arg, sub) {
  state.admin = await api('GET', '/api/admin/overview');
  if (page === 'invoice') {
    if (arg === 'new') return invoiceEditor(null);
    const inv = await api('GET', `/api/admin/invoices/${encodeURIComponent(arg)}`);
    return sub === 'edit' ? invoiceEditor(inv) : renderInvoiceView(inv, true);
  }
  const pages = { orders: adminOrders, clients: adminClients, invoices: adminInvoices, settings: adminSettings };
  (pages[page] || adminOrders)();
}

const reloadAdmin = () => route();

function adminOrders() {
  const { orders } = state.admin;
  const filter = sessionStorage.getItem('orderFilter') || 'open';
  const shown = orders.filter((o) => (filter === 'all' ? true
    : filter === 'open' ? ['pending', 'in_progress'].includes(o.status) : o.status === filter));
  const counts = (s) => orders.filter((o) => (s === 'open' ? ['pending', 'in_progress'].includes(o.status) : s === 'all' || o.status === s)).length;
  const kv = (k, v) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '');

  shell(ADMIN_TABS, '#/admin/orders', `
    <div class="page-head">
      <div><h1>Orders</h1><p class="muted">Open an order and click ✓ Mark as completed once its mailboxes are delivered. That activates them for the client and creates the first invoice.</p></div>
      <div class="row">${[['open', 'To do'], ['active', 'Active'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([k, l]) => `<button class="btn btn-sm ${filter === k ? 'btn-primary' : ''}" data-filter="${k}">${l} (${counts(k)})</button>`).join('')}</div>
    </div>
    <div class="card">
      ${shown.length ? shown.map((o) => `
      <details class="order">
        <summary>
          <strong>#${o.id}</strong>
          <span>${esc(o.company || o.name || o.email)}<div class="muted small">${esc(o.email)}</div></span>
          <span class="hide-sm">${esc(o.inbox_label)}</span>
          <span class="hide-sm num">${o.quantity} boxes</span>
          <span class="hide-sm">${fmtDate(o.created_at)}</span>
          <span>${badge(o.status)}</span>
        </summary>
        <div class="order-body">
          <div class="stack" style="gap:14px">
            <div><h3>Domains</h3><pre>${esc(o.domains)}</pre></div>
            <div><h3>Usernames</h3><pre>${esc(o.usernames)}</pre></div>
            <dl class="kv">
              ${kv('Type', o.inbox_label)}
              ${kv('Mailboxes', String(o.quantity))}
              ${kv('Price', `${money(o.price_per_mailbox)} / mailbox → ${money(o.quantity * o.price_per_mailbox)}/mo`)}
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
            ${o.csv_rows ? `<div><a class="btn btn-primary btn-sm" href="/api/admin/orders/${o.id}/onboarding.csv">⬇ Download onboarding CSV (${o.csv_rows} rows)</a></div>` : '<div class="muted small">No onboarding CSV uploaded.</div>'}
          </div>
          <form class="order-form" data-id="${o.id}">
            ${['pending', 'in_progress'].includes(o.status) ? `<div class="complete-box">
              <button type="button" class="btn btn-success" data-complete="${o.id}">✓ Mark as completed</button>
              <div class="hint">Use this once the mailboxes are delivered. It activates them for the client, creates the first month's invoice (${money(o.quantity * o.price_per_mailbox)}), sets the renewal date one month from today and notifies the client.</div>
            </div>` : ''}
            <div class="field"><label>Status</label>
              <select name="status">${['pending', 'in_progress', 'active', 'cancelled'].map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s === 'active' ? 'Active (completed)' : STATUS_LABEL[s]}</option>`).join('')}</select>
              ${o.activated_at ? '' : '<div class="hint">Activating creates the first month\'s invoice and sets the renewal date one month from today.</div>'}
            </div>
            <div class="grid-2">
              <div class="field"><label>Mailboxes</label><input type="number" name="quantity" min="1" max="10000" required value="${o.quantity}"></div>
              <div class="field"><label>Price per mailbox ($)</label><input type="number" name="price_per_mailbox" step="0.01" min="0" required value="${o.price_per_mailbox}"></div>
            </div>
            ${o.status === 'active' ? `<div class="field"><label>Next renewal date</label><input type="date" name="next_billing_date" value="${esc(o.next_billing_date || '')}"><div class="hint">Reminders go out 7, 3 and 1 day before this date.</div></div>` : ''}
            <div class="field"><label>Internal notes</label><textarea name="admin_notes" style="min-height:64px">${esc(o.admin_notes)}</textarea></div>
            <button class="btn btn-primary" type="submit">Save</button>
            <div class="error"></div>
          </form>
        </div>
      </details>`).join('') : '<div class="empty">Nothing here.</div>'}
    </div>`);

  document.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => { sessionStorage.setItem('orderFilter', b.dataset.filter); adminOrders(); };
  });
  document.querySelectorAll('.order-form').forEach((form) => {
    onSubmit(form, async (d) => {
      const body = { status: d.status, admin_notes: d.admin_notes, quantity: Number(d.quantity), price_per_mailbox: d.price_per_mailbox };
      if (d.next_billing_date) body.next_billing_date = d.next_billing_date;
      const r = await api('PATCH', `/api/admin/orders/${form.dataset.id}`, body);
      toast(r.invoiceId ? `Order #${form.dataset.id} completed. Invoice #${r.invoiceId} created.` : `Order #${form.dataset.id} saved`);
      reloadAdmin();
    });
  });
  document.querySelectorAll('[data-complete]').forEach((b) => {
    b.onclick = async () => {
      const form = b.closest('form');
      const d = formData(form);
      const id = b.dataset.complete;
      const total = money(Number(d.quantity) * Number(d.price_per_mailbox));
      if (!confirm(`Mark order #${id} as completed?\n\nThis activates the mailboxes for the client, creates the first month's invoice (${total}) and sends them a notification.`)) return;
      b.disabled = true;
      try {
        const r = await api('PATCH', `/api/admin/orders/${id}`, {
          status: 'active', admin_notes: d.admin_notes, quantity: Number(d.quantity), price_per_mailbox: d.price_per_mailbox,
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

function adminClients() {
  const { clients, invites, mailEnabled, pricing, clientPricing } = state.admin;
  const labelOf = (t) => (pricing.find((p) => p.inbox_type === t) || {}).label || t;
  shell(ADMIN_TABS, '#/admin/clients', `
    <div class="page-head"><div><h1>Clients & invites</h1><p class="muted">The portal is invite-only. Clients can only join through a link you send.</p></div></div>
    <div class="stack">
      <form class="card card-pad" id="inv">
        <h2 style="margin-bottom:14px">Invite a client</h2>
        <div class="grid-2">
          <div class="field"><label for="i-email">Email</label><input id="i-email" name="email" type="email" required></div>
          <div class="field"><label for="i-name">Name</label><input id="i-name" name="name"></div>
        </div>
        <div class="field"><label for="i-company">Company</label><input id="i-company" name="company"></div>
        <div class="row"><button class="btn btn-primary" type="submit">Send invite</button>
          <span class="muted small">${mailEnabled ? 'The invite is emailed, and you also get the link to share.' : 'Email is not configured yet: copy the link and send it yourself.'}</span></div>
        <div class="error"></div>
        <div id="inv-link"></div>
      </form>

      <div class="card">
        <div class="card-head"><h2>Clients</h2><span class="muted small">${clients.length} total</span></div>
        ${clients.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Client</th><th>Pricing</th><th class="num">Active mailboxes</th><th class="num">Monthly</th><th>Joined</th><th></th></tr></thead>
          <tbody>${clients.map((c) => {
            const custom = clientPricing.filter((cp) => cp.user_id === c.id);
            return `<tr>
            <td>${esc(c.company || c.name)}<div class="muted small">${esc(c.name)} · ${esc(c.email)}</div></td>
            <td>${custom.length ? `<span class="badge b-in_progress">Custom</span><div class="muted small">${custom.map((cp) => `${esc(labelOf(cp.inbox_type))} ${money(cp.price_per_mailbox)}`).join('<br>')}</div>` : '<span class="muted small">Standard</span>'}</td>
            <td class="num">${c.active_mailboxes}</td><td class="num">${money(c.monthly)}</td><td>${fmtDate(c.created_at)}</td>
            <td><div class="row" style="flex-wrap:nowrap"><button class="btn btn-sm" data-prices="${c.id}">Edit pricing</button><button class="btn btn-sm btn-ghost" data-reset="${esc(c.email)}">Reset link</button></div></td>
          </tr>
          <tr class="price-row" id="prices-${c.id}" hidden><td colspan="6">
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

  onSubmit(document.getElementById('inv'), async (d) => {
    const r = await api('POST', '/api/admin/invites', d);
    state.admin = await api('GET', '/api/admin/overview');
    adminClients();
    showLink(r, d.email);
  });
  document.querySelectorAll('[data-reset]').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api('POST', '/api/admin/invites', { email: b.dataset.reset });
        state.admin = await api('GET', '/api/admin/overview');
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
      await api('PUT', `/api/admin/clients/${form.dataset.id}/pricing`, {
        prices: Object.entries(d).map(([inbox_type, v]) => ({ inbox_type, price_per_mailbox: v === '' ? null : v })),
      });
      toast('Client pricing saved');
      reloadAdmin();
    });
  });
  document.querySelectorAll('[data-revoke]').forEach((b) => {
    b.onclick = async () => {
      await api('DELETE', `/api/admin/invites/${b.dataset.revoke}`);
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

async function setInvoiceStatus(id, status) {
  if (status === 'void' && !confirm(`Void invoice #${id}?`)) return false;
  await api('PATCH', `/api/admin/invoices/${id}`, { status });
  toast(`Invoice #${id} updated`);
  return true;
}

function adminInvoices() {
  const { invoices, today } = state.admin;
  shell(ADMIN_TABS, '#/admin/invoices', `
    <div class="page-head">
      <div><h1>Invoices</h1><p class="muted">Renewal invoices are created automatically 7 days before each renewal. Create and edit any invoice here.</p></div>
      <a class="btn btn-primary" href="#/admin/invoice/new">+ New invoice</a>
    </div>
    <div class="card">
      ${invoices.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Client</th><th>Description</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>${invoices.map((i) => {
          const s = i.status === 'unpaid' && i.due_date < today ? 'overdue' : i.status;
          return `<tr><td><a href="#/admin/invoice/${i.id}">${i.id}</a></td><td>${esc(i.company || i.email)}</td><td>${esc(i.description)}</td><td>${fmtDate(i.issue_date || i.created_at)}</td><td>${fmtDate(i.due_date)}</td><td>${badge(s)}</td><td class="num">${money(i.amount)}</td>
          <td><div class="row" style="flex-wrap:nowrap">
            <a class="btn btn-sm" href="#/admin/invoice/${i.id}">View</a>
            <a class="btn btn-sm" href="#/admin/invoice/${i.id}/edit">Edit</a>
            ${i.status !== 'paid' ? `<button class="btn btn-sm" data-inv="${i.id}" data-status="paid">Mark paid</button>` : `<button class="btn btn-sm" data-inv="${i.id}" data-status="unpaid">Mark unpaid</button>`}
            ${i.status !== 'void' ? `<button class="btn btn-sm btn-ghost" data-inv="${i.id}" data-status="void">Void</button>` : ''}
          </div></td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty">No invoices yet. <a href="#/admin/invoice/new">Create one</a>.</div>'}
    </div>`);

  document.querySelectorAll('[data-inv]').forEach((b) => {
    b.onclick = async () => {
      try { if (await setInvoiceStatus(b.dataset.inv, b.dataset.status)) reloadAdmin(); } catch (ex) { toast(ex.message); }
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
              ${clients.map((c) => `<option value="${c.id}" ${String(c.id) === ed.user_id ? 'selected' : ''}>${esc(c.company || c.name)} (${esc(c.email)})</option>`).join('')}</select></div>
          <div class="field"><label for="e-order">Linked batch (optional)</label><select id="e-order"></select>
            <div class="hint">Choosing a batch adds a line for it.</div></div>
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
      <td><select data-i="${i}" data-k="inbox_type">${typeOptions(it.inbox_type)}</select></td>
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
        it[el.dataset.k] = el.value;
        // Picking a mailbox type fills in this client's price if none is set yet.
        if (el.dataset.k === 'inbox_type' && it.unit_price === '' && el.value && el.value !== 'other') {
          it.unit_price = String(priceFor(el.value));
          el.closest('tr').querySelector('[data-k="unit_price"]').value = it.unit_price;
        }
        recalc();
      };
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', handler);
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
  $('e-order').onchange = (e) => {
    ed.order_id = e.target.value;
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

  $('inv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; $('e-error').textContent = '';
    const body = {
      user_id: ed.user_id, order_id: ed.order_id || null, issue_date: ed.issue_date, due_date: ed.due_date,
      discount: ed.discount || 0, notes: ed.notes, items: ed.items, notify: $('e-notify').checked,
    };
    try {
      const r = isNew ? await api('POST', '/api/admin/invoices', body) : await api('PUT', `/api/admin/invoices/${inv.id}`, body);
      const id = isNew ? r.id : inv.id;
      toast(isNew ? `Invoice #${id} created` : `Invoice #${id} saved`);
      go(`#/admin/invoice/${id}`);
    } catch (ex) {
      $('e-error').textContent = ex.message;
      btn.disabled = false;
    }
  });
}

// ---- invoice page (admin + client), printable

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
        ${isAdmin ? `<a class="btn" href="#/admin/invoice/${inv.id}/edit">Edit</a>
          ${inv.status !== 'paid' ? '<button class="btn" data-set="paid">Mark paid</button>' : '<button class="btn" data-set="unpaid">Mark unpaid</button>'}
          ${inv.status !== 'void' ? '<button class="btn btn-ghost" data-set="void">Void</button>' : ''}` : ''}
        <button class="btn btn-primary" id="print">Print / Save PDF</button>
      </div>
    </div>
    <article class="invoice-sheet">
      <header class="inv-top">
        <img src="logo-full.png" alt="MithMill" class="inv-logo">
        <div class="inv-title"><div class="inv-word">INVOICE</div><div class="inv-num">#${inv.id}</div>${badge(status)}</div>
      </header>
      <section class="inv-meta">
        <div><div class="inv-label">Billed to</div><strong>${esc(inv.company || inv.name)}</strong>${inv.company && inv.name ? `<div>${esc(inv.name)}</div>` : ''}<div>${esc(inv.email)}</div></div>
        <div><div class="inv-label">Payable to</div><strong>Mixxbee LLC</strong><div>on behalf of Mithmill</div></div>
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
      ${inv.notes ? `<section class="inv-notes"><div class="inv-label">Notes</div><div>${esc(inv.notes)}</div></section>` : ''}
      <div class="note"><span class="note-icon">ℹ️</span><div><strong>Payment notice:</strong> ${esc(inv.paymentNote)}</div></div>
    </article>`);

  document.getElementById('print').onclick = () => window.print();
  document.querySelectorAll('[data-set]').forEach((b) => {
    b.onclick = async () => {
      try { if (await setInvoiceStatus(inv.id, b.dataset.set)) route(); } catch (ex) { toast(ex.message); }
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
      <form class="card card-pad" id="prices">
        <h2>Standard price per mailbox (USD / month)</h2>
        <p class="muted small" style="margin:4px 0 16px">Used for every client without custom pricing. Set a client's own prices under <a href="#/admin/clients">Clients &amp; invites</a> → Edit pricing. Existing batches keep the price they were ordered at; you can change it on the order.</p>
        <div class="grid-2">${pricing.map((p) => `
          <div class="field"><label for="p-${esc(p.inbox_type)}">${esc(p.label)}</label>
          <input id="p-${esc(p.inbox_type)}" name="${esc(p.inbox_type)}" type="number" step="0.01" min="0" required value="${p.price_per_mailbox}"></div>`).join('')}</div>
        <button class="btn btn-primary" type="submit">Save prices</button>
        <div class="error"></div>
      </form>
      <div class="card card-pad">
        <h2>Renewal reminders</h2>
        <p class="muted" style="margin:6px 0 14px">Clients get an in-portal notification${mailEnabled ? ' and an email' : ''} 7, 3 and 1 day before each batch renews. The check runs every hour; today is ${fmtDate(today)} (billing timezone).
        ${mailEnabled ? '' : '<br><strong>Email is not configured</strong>: set the SMTP_* environment variables on Render to send emails.'}</p>
        <div class="row"><button class="btn" id="run">Run the check now</button><span class="muted small" id="run-out"></span></div>
      </div>
    </div>`);

  onSubmit(document.getElementById('settings'), async (d) => {
    await api('PUT', '/api/admin/settings', d);
    toast('Settings saved');
  });
  onSubmit(document.getElementById('prices'), async (d) => {
    await api('PUT', '/api/admin/pricing', { prices: Object.entries(d).map(([inbox_type, v]) => ({ inbox_type, price_per_mailbox: v })) });
    toast('Prices saved');
  });
  document.getElementById('run').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('POST', '/api/admin/billing/run', {});
      document.getElementById('run-out').textContent = `Checked ${r.checked} active batches, sent ${r.remindersSent} reminders.`;
    } catch (ex) { toast(ex.message); } finally { e.target.disabled = false; }
  };
}

route();

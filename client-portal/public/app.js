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
    const err = form.querySelector('.error');
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
      return await renderAdmin(parts[1] || 'orders');
    }
    if (parts[0] === 'admin') return go('#/dashboard');
    return await renderClient(parts[0]);
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

async function renderClient(page) {
  state.dash = await api('GET', '/api/dashboard');
  if (page === 'order') return renderOrder();
  if (page === 'billing') return renderBilling();
  if (page === 'notifications') return renderNotifications();
  return renderDashboard();
}

function batchesTable(orders) {
  if (!orders.length) return '<div class="empty">No orders yet. Place your first order to get mailboxes set up.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Batch</th><th>Type</th><th class="num">Mailboxes</th><th>Status</th><th class="num">Monthly</th><th>Next renewal</th><th>Ordered</th></tr></thead>
    <tbody>${orders.map((o) => `<tr>
      <td>#${o.id}</td>
      <td>${esc(o.inbox_label)}<div class="muted small">${esc(lines(o.domains).slice(0, 2).join(', '))}${lines(o.domains).length > 2 ? '…' : ''}</div></td>
      <td class="num">${o.quantity}</td>
      <td>${badge(o.status)}</td>
      <td class="num">${money(o.quantity * o.price_per_mailbox)}</td>
      <td>${o.status === 'active' ? fmtDate(o.next_billing_date) : '—'}</td>
      <td>${fmtDate(o.created_at)}</td>
    </tr>`).join('')}</tbody></table></div>`;
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
    </div>`);
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
          <thead><tr><th>Invoice</th><th>Description</th><th>Due</th><th>Status</th><th class="num">Amount</th></tr></thead>
          <tbody>${invoices.map((i) => {
            const s = i.status === 'unpaid' && i.due_date < today ? 'overdue' : i.status;
            return `<tr><td>#${i.id}</td><td>${esc(i.description)}</td><td>${fmtDate(i.due_date)}</td><td>${badge(s)}${i.paid_at ? `<div class="muted small">${fmtDate(i.paid_at)}</div>` : ''}</td><td class="num">${money(i.amount)}</td></tr>`;
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

        <div class="grid-2">
          <div class="field"><label for="quantity">Number of mailboxes</label><input id="quantity" name="quantity" type="number" min="1" max="10000" required value="${v('quantity')}"></div>
          <div class="field"><label>Estimated monthly cost</label><input id="est" disabled value="${money((Number(data.quantity) || 0) * price.price_per_mailbox)}"></div>
        </div>

        <div class="grid-2">
          <div class="field"><label for="domains">Domain names</label><textarea id="domains" name="domains" required placeholder="acme-mail.com&#10;getacme.co">${v('domains')}</textarea><div class="hint">One domain per line.</div></div>
          <div class="field"><label for="usernames">Usernames</label><textarea id="usernames" name="usernames" required placeholder="John Smith - john&#10;Jane Doe - jane.doe">${v('usernames')}</textarea><div class="hint">One per line: full name and the part before the @.</div></div>
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
    onSubmit(form, async (d) => {
      Object.assign(data, d);
      if (!lines(d.domains).length) throw new Error('Add at least one domain');
      if (!lines(d.usernames).length) throw new Error('Add at least one username');
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

const ADMIN_TABS = [['#/admin/orders', 'Orders'], ['#/admin/clients', 'Clients & invites'], ['#/admin/invoices', 'Invoices'], ['#/admin/settings', 'Pricing & reminders']];

async function renderAdmin(page) {
  state.admin = await api('GET', '/api/admin/overview');
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
      <div><h1>Orders</h1><p class="muted">Set an order to Active to switch on the client's mailboxes and start monthly billing.</p></div>
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
          </div>
          <form class="order-form" data-id="${o.id}">
            <div class="field"><label>Status</label>
              <select name="status">${['pending', 'in_progress', 'active', 'cancelled'].map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
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
      await api('PATCH', `/api/admin/orders/${form.dataset.id}`, body);
      toast(`Order #${form.dataset.id} saved`);
      reloadAdmin();
    });
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

function adminInvoices() {
  const { invoices, clients, orders, today } = state.admin;
  shell(ADMIN_TABS, '#/admin/invoices', `
    <div class="page-head"><div><h1>Invoices</h1><p class="muted">Renewal invoices are created automatically 7 days before each renewal. Add one-off invoices here.</p></div></div>
    <div class="stack">
      <form class="card card-pad" id="newinv">
        <h2 style="margin-bottom:14px">Create invoice</h2>
        <div class="grid-2">
          <div class="field"><label for="v-user">Client</label>
            <select id="v-user" name="user_id" required><option value="">Choose…</option>
              ${clients.map((c) => `<option value="${c.id}">${esc(c.company || c.name)} (${esc(c.email)})</option>`).join('')}</select></div>
          <div class="field"><label for="v-order">Batch (optional)</label><select id="v-order" name="order_id"><option value="">None</option></select></div>
        </div>
        <div class="field"><label for="v-desc">Description</label><input id="v-desc" name="description" required></div>
        <div class="grid-2">
          <div class="field"><label for="v-amt">Amount (USD)</label><input id="v-amt" name="amount" type="number" step="0.01" min="0.01" required></div>
          <div class="field"><label for="v-due">Due date</label><input id="v-due" name="due_date" type="date" required value="${esc(today)}"></div>
        </div>
        <button class="btn btn-primary" type="submit">Create & notify client</button>
        <div class="error"></div>
      </form>
      <div class="card">
        <div class="card-head"><h2>All invoices</h2></div>
        ${invoices.length ? `<div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Client</th><th>Description</th><th>Due</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody>${invoices.map((i) => {
            const s = i.status === 'unpaid' && i.due_date < today ? 'overdue' : i.status;
            return `<tr><td>${i.id}</td><td>${esc(i.company || i.email)}</td><td>${esc(i.description)}</td><td>${fmtDate(i.due_date)}</td><td>${badge(s)}</td><td class="num">${money(i.amount)}</td>
            <td><div class="row" style="flex-wrap:nowrap">
              ${i.status !== 'paid' ? `<button class="btn btn-sm" data-inv="${i.id}" data-status="paid">Mark paid</button>` : `<button class="btn btn-sm" data-inv="${i.id}" data-status="unpaid">Mark unpaid</button>`}
              ${i.status !== 'void' ? `<button class="btn btn-sm btn-ghost" data-inv="${i.id}" data-status="void">Void</button>` : ''}
            </div></td></tr>`;
          }).join('')}</tbody></table></div>` : '<div class="empty">No invoices yet.</div>'}
      </div>
    </div>`);

  const userSel = document.getElementById('v-user');
  userSel.onchange = () => {
    const mine = orders.filter((o) => String(o.user_id) === userSel.value);
    document.getElementById('v-order').innerHTML = '<option value="">None</option>' +
      mine.map((o) => `<option value="${o.id}">#${o.id} ${esc(o.inbox_label)} × ${o.quantity}</option>`).join('');
  };
  onSubmit(document.getElementById('newinv'), async (d) => {
    await api('POST', '/api/admin/invoices', d);
    toast('Invoice created and client notified');
    reloadAdmin();
  });
  document.querySelectorAll('[data-inv]').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.status === 'void' && !confirm(`Void invoice #${b.dataset.inv}?`)) return;
      try {
        await api('PATCH', `/api/admin/invoices/${b.dataset.inv}`, { status: b.dataset.status });
        toast(`Invoice #${b.dataset.inv} updated`);
        reloadAdmin();
      } catch (ex) { toast(ex.message); }
    };
  });
}

function adminSettings() {
  const { pricing, mailEnabled, today } = state.admin;
  shell(ADMIN_TABS, '#/admin/settings', `
    <div class="page-head"><div><h1>Pricing & reminders</h1></div></div>
    <div class="stack">
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

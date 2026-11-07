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
  if ((data.code === 'vpn' || data.code === 'blocked') && !/^\/api\/(auth|invites)\//.test(url)) {
    // "Block VPN" is on and they're on a VPN, or the owner paused their access: nothing works until that changes.
    if (data.code === 'vpn') renderVpnBlocked(); else renderAccessPaused(data.error);
    throw Object.assign(new Error(data.error), { vpn: true });
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
  return `<div class="note note-info"><span class="note-icon">${icon('mail')}</span><div><strong>Need to cancel?</strong> ${esc(state.dash.cancelNote)}</div></div>`;
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
    try { state.me = await api('GET', '/api/me'); } catch (ex) { state.me = null; if (ex.vpn) return; }
  }
  if (!state.me) { updateWatchBar(); return renderLogin(); }
  updateWatchBar();
  applyClientBrand();
  if (!state.me.watching && !state.me.resellerClient) tawkIdentify();
  setAdminTabs();
  // Resellers sign the Reseller Agreement before anything else.
  if (isReseller() && !state.agreementOk && !state.me.watching && parts[0] !== 'password') {
    try {
      const ag = await api('GET', '/api/reseller/agreement');
      if (!ag.signed) return renderAgreement(ag);
      state.agreementOk = true;
    } catch (ex) {
      $app.innerHTML = `<div class="boot">${esc(ex.message)}</div>`;
      return;
    }
  }
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
window.addEventListener('hashchange', () => { pageEnter(); route(); });

// Tells the Tawk.to chat (loaded in index.html) who is chatting, so chats show
// the person's name, email and whether they're a client, reseller or admin.
let tawkDone = '';
function tawkIdentify() {
  const me = state.me;
  if (!me || !window.Tawk_API || tawkDone === me.email) return;
  const attrs = {
    name: me.name || me.email,
    email: me.email,
    role: me.role === 'admin' ? 'Owner' : me.role === 'staff' ? 'Team member' : me.role === 'reseller' ? 'Reseller' : 'Client',
    ...(me.company ? { company: me.company } : {}),
  };
  const apply = () => {
    try { window.Tawk_API.setAttributes(attrs, () => {}); tawkDone = me.email; } catch { /* chat not ready */ }
  };
  if (typeof window.Tawk_API.setAttributes === 'function') apply();
  else window.Tawk_API.onLoad = apply;
}

const ICONS = {
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  flame: '<path d="M12 22c4 0 7-2.7 7-6.8 0-4.2-3.2-6.4-4.4-9.7-.3-.8-1.3-1-1.8-.3C11.5 7.3 13 9 11 10.6 10 9.7 9.6 8.6 9.4 7.7c-.1-.6-.9-.8-1.2-.2C7 9.4 5 11.8 5 15.2 5 19.3 8 22 12 22z"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  receipt: '<path d="M5 2.5h14v19l-2.3-1.5-2.4 1.5-2.3-1.5-2.3 1.5-2.4-1.5L5 21.5z"/><path d="M9 7.5h6M9 11.5h6M9 15.5h4"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  x: '<path d="M17 7 7 17M7 7l10 10"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  minus: '<path d="M6 12h12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.8-3.5M4 4v4h4M4 13a8 8 0 0 0 14.8 3.5M20 20v-4h-4"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  send: '<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z"/>',
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  order: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  billing: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  orders: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  clients: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  invoices: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  team: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/><path d="m17 3 1.5 1.5L21 2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-7"/>',
  map: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  reseller: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---- Brand marks for mailbox types (Google, Microsoft, Azure; pre-warmed
// types get a small flame). The provider is read from the type key or label,
// so types the owner adds later pick up the right mark too.
const BRAND_SVG = {
  google: '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FBBC05" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#EA4335" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#34A853" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0 1 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#4285F4" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>',
  microsoft: '<svg viewBox="0 0 23 23" aria-hidden="true"><path fill="#F25022" d="M1 1h10v10H1z"/><path fill="#7FBA00" d="M12 1h10v10H12z"/><path fill="#00A4EF" d="M1 12h10v10H1z"/><path fill="#FFB900" d="M12 12h10v10H12z"/></svg>',
  azure: '<svg viewBox="0 0 96 96" aria-hidden="true"><defs><linearGradient id="az-a" x1="58.97" y1="9.23" x2="31.04" y2="91.7" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#114a8b"/><stop offset="1" stop-color="#0669bc"/></linearGradient><linearGradient id="az-c" x1="46.2" y1="11.48" x2="76.86" y2="93.18" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3ccbf4"/><stop offset="1" stop-color="#2892df"/></linearGradient></defs><path fill="url(#az-a)" d="M33.34 6.54h26.04l-27.03 80.1a4.15 4.15 0 0 1-3.94 2.81H8.15a4.14 4.14 0 0 1-3.93-5.47L29.4 9.37a4.15 4.15 0 0 1 3.94-2.83z"/><path fill="#0078d4" d="M71.18 60.26H29.89a1.91 1.91 0 0 0-1.31 3.31l26.53 24.76a4.17 4.17 0 0 0 2.85 1.12h23.38z"/><path fill="url(#az-c)" d="M66.6 9.36a4.14 4.14 0 0 0-3.93-2.82H33.65a4.15 4.15 0 0 1 3.93 2.82l25.18 74.62a4.15 4.15 0 0 1-3.93 5.47h29.02a4.15 4.15 0 0 0 3.93-5.47z"/></svg>',
  other: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#64748b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>',
};
const FLAME_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#f97316" d="M12 2s5 4.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 1-3.5S9 11 10.5 11C10.5 7 12 2 12 2z"/><path fill="#fde047" d="M12 13s2 1.6 2 3.4a2 2 0 0 1-4 0c0-1.3 2-3.4 2-3.4z"/></svg>';
function brandOf(type, label) {
  const k = `${type || ''} ${label || ''}`.toLowerCase();
  return {
    brand: /google|gmail|gsuite|workspace/.test(k) ? 'google' : /azure/.test(k) ? 'azure' : /m365|microsoft|office|outlook|365/.test(k) ? 'microsoft' : 'other',
    warm: /pre[\s_-]?warm/.test(k),
  };
}
// Just the mark, sized by the caller's font-size.
function brandLogo(type, label, cls = '') {
  const { brand, warm } = brandOf(type, label);
  return `<span class="brand-logo brand-${brand} ${cls}" title="${esc(label || '')}">${BRAND_SVG[brand]}${warm ? `<span class="brand-warm">${FLAME_SVG}</span>` : ''}</span>`;
}
// Mark + name, for tables and lists.
const typeChip = (type, label) => (label ? `<span class="type-chip">${brandLogo(type, label)}<span>${esc(label)}</span></span>` : '<span class="muted">—</span>');
// A mailbox's avatar: initials on a colour picked from the address, with the
// provider's mark as a badge.
const AVATAR_TONES = [['#eef2ff', '#4338ca'], ['#ecfeff', '#0e7490'], ['#fdf2f8', '#be185d'], ['#f0fdf4', '#15803d'], ['#fff7ed', '#c2410c'], ['#f5f3ff', '#6d28d9'], ['#eff6ff', '#1d4ed8'], ['#fefce8', '#a16207']];
// A person's avatar: initials of their name (or email) on a colour picked
// from their email, so each client keeps the same colour everywhere.
function personAvatar(name, email, cls = '') {
  const words = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const local = String(email || '').split('@')[0].split(/[._-]+/).filter(Boolean);
  const src = words.length ? words : local;
  const ini = ((src[0] || '?')[0] + (src[1] ? src[1][0] : (src[0] || '')[1] || '')).toUpperCase();
  let h = 0; for (const ch of String(email || name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = AVATAR_TONES[h % AVATAR_TONES.length];
  return `<span class="mb-avatar ${cls}" style="--av-bg:${bg};--av-fg:${fg}">${esc(ini)}</span>`;
}
// Admin lists: avatar and name; the chevron opens the details (contact, email, sold by).
function clientCell(c, extra = '') {
  const title = c.company || c.name || c.email;
  return `<details class="client-cell">
    <summary>${personAvatar(title, c.email)}<span class="cc-name">${esc(title)}</span><span class="cc-chev">${icon('chevron')}</span></summary>
    <div class="cc-body">
      ${c.company && c.name ? `<div class="cc-row">${icon('team')}<span>${esc(c.name)}</span></div>` : ''}
      <div class="cc-row">${icon('mail')}<span class="cc-email">${esc(c.email)}</span><button type="button" class="icon-btn icon-btn-sm" data-copy-ns="${esc(c.email)}" data-copy-what="Email" title="Copy email" aria-label="Copy ${esc(c.email)}">${icon('copy')}</button></div>
      <div class="cc-row">${icon('reseller')}<span>${c.seller ? `Sold by <strong>${esc(c.seller)}</strong>` : '<span class="muted">Sold by: not set</span>'}</span></div>
      ${extra}
    </div></details>`;
}
// A compact "More" menu for secondary actions.
const moreMenu = (items) => `<details class="menu"><summary class="btn btn-sm btn-ghost menu-btn" aria-label="More actions"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg></summary><div class="menu-pop">${items}</div></details>`;

function mailboxAvatar(email, type, label) {
  const local = String(email || '').split('@')[0].replace(/[^a-z0-9._-]/gi, '');
  const parts = local.split(/[._-]+/).filter(Boolean);
  const ini = ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : (parts[0] || '')[1] || '')).toUpperCase();
  let h = 0; for (const ch of String(email)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = AVATAR_TONES[h % AVATAR_TONES.length];
  return `<span class="mb-avatar" style="--av-bg:${bg};--av-fg:${fg}">${esc(ini)}${type || label ? `<span class="mb-avatar-badge">${brandLogo(type, label)}</span>` : ''}</span>`;
}
const NAV_ICONS = {
  '#/dashboard': 'dashboard', '#/mailboxes': 'mail', '#/admin/mailboxes': 'mail', '#/domains': 'globe', '#/admin/domains': 'globe', '#/order': 'order', '#/billing': 'billing', '#/notifications': 'bell',
  '#/admin/orders': 'orders', '#/admin/clients': 'clients', '#/admin/invoices': 'invoices', '#/admin/team': 'team', '#/admin/settings': 'settings', '#/admin/analytics': 'chart', '#/admin/resellers': 'reseller', '#/admin/payouts': 'billing', '#/admin/locations': 'map',
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
  const b = isClient && state.me.brand;
  const logo = (sub) => (b
    ? `<a class="sb-logo sb-logo-brand" href="#/">${b.logo ? `<span class="sb-brand-logo"><img src="${esc(b.logo)}" alt=""></span>` : ''}<div><div class="sb-name">${esc(b.name)}</div><div class="sb-sub">${sub}</div></div></a>`
    : `<a class="sb-logo" href="#/"><img src="logo-mark-white.png" alt=""><div><div class="sb-name">MithMill</div><div class="sb-sub">${sub}</div></div></a>`);

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
    if (state.me.watching) return switchAccount('/api/auth/stop-watching');
    await api('POST', '/api/auth/logout');
    Object.assign(state, { me: null, dash: null, admin: null, order: null, agreementOk: false });
    go('#/login');
  };
}

// ---- "Watch": the owner opens someone's dashboard as them, then comes back.

async function switchAccount(url) {
  try {
    await api('POST', url);
  } catch (ex) { toast(ex.message); return; }
  Object.assign(state, { me: undefined, dash: null, admin: null, order: null, agreementOk: false });
  document.body.classList.remove('nav-open');
  if (location.hash === '#/') route(); else location.hash = '#/';
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-watch]');
  if (!b) return;
  e.preventDefault();
  switchAccount(`/api/admin/watch/${b.dataset.watch}`);
});

const watchBtn = (id) => (isOwner() ? `<button class="btn btn-sm btn-watch" data-watch="${id}" title="Open their dashboard as them (view and edit)">${icon('eye')} Watch</button>` : '');

function updateWatchBar() {
  let bar = document.getElementById('watch-bar');
  const w = state.me && state.me.watching;
  document.body.classList.toggle('watching', Boolean(w));
  if (!w) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'watch-bar';
    bar.setAttribute('role', 'status');
    document.body.appendChild(bar);
  }
  const role = { client: 'client', reseller: 'reseller', staff: 'team member' }[state.me.role] || state.me.role;
  bar.innerHTML = `${icon('eye')}<span>Watching <strong>${esc((state.me.role === 'staff' ? state.me.name : state.me.company || state.me.name) || state.me.email)}</strong> (${role}). Changes are saved as them.</span>
    <button class="btn btn-sm" id="watch-stop">Back to my account</button>`;
  document.getElementById('watch-stop').onclick = () => switchAccount('/api/auth/stop-watching');
}

function welcome(name, stats, eyebrow = 'Welcome back') {
  return `<div class="welcome">
    <div><div class="eyebrow">${esc(eyebrow)}</div><div class="name">${esc(name)}</div></div>
    <div class="wstats">${stats.map(([v, l]) => `<div class="wstat"><div class="wv">${v}</div><div class="wl">${esc(l)}</div></div>`).join('')}</div>
  </div>`;
}

// ------------------------------------------------------------------ auth pages

// ---- A reseller's clients see the reseller's brand (white-label): login and
// invite pages (?b=<reseller id>, remembered on this browser), sidebar, title;
// no Mithmill chat, and no New order page (they order through the reseller).
let loginBrand = null;
const savedBrandId = () => { try { return localStorage.getItem('portalBrand'); } catch { return null; } };
let hostBrandChecked = false;
async function loadLoginBrand() {
  // A reseller's own domain shows their brand, whatever ?b says.
  if (!hostBrandChecked) {
    hostBrandChecked = true;
    try { const { brand } = await api('GET', '/api/brand-host'); if (brand) { loginBrand = brand; return; } } catch { /* main domain */ }
  } else if (loginBrand && loginBrand.host) return;
  const id = new URLSearchParams(location.search).get('b') || savedBrandId();
  if (!id || (loginBrand && String(loginBrand.id) === String(id))) return;
  try {
    const { brand } = await api('GET', `/api/brand/${encodeURIComponent(id)}`);
    loginBrand = brand;
    try { if (brand) localStorage.setItem('portalBrand', String(brand.id)); else localStorage.removeItem('portalBrand'); } catch { /* private mode */ }
  } catch { loginBrand = null; }
}
function hideChat() {
  const hide = () => { try { window.Tawk_API.hideWidget(); } catch { /* not loaded */ } };
  if (window.Tawk_API && typeof window.Tawk_API.hideWidget === 'function') hide();
  else if (window.Tawk_API) window.Tawk_API.onLoad = hide;
}
function applyClientBrand() {
  const me = state.me;
  if (!me || !me.resellerClient) return;
  const i = CLIENT_TABS.findIndex(([h]) => h === '#/order');
  if (i !== -1) CLIENT_TABS.splice(i, 1);
  hideChat();
  if (me.brand) {
    loginBrand = { id: me.brand.id, name: me.brand.name, logo: me.brand.logo };
    try { localStorage.setItem('portalBrand', String(me.brand.id)); } catch { /* private mode */ }
    document.title = `${me.brand.name} Client Portal`;
  }
}

function authCard(inner) {
  if (loginBrand) hideChat();
  const logo = loginBrand
    ? `${loginBrand.logo ? `<img src="${esc(loginBrand.logo)}" alt="${esc(loginBrand.name)}" style="max-height:64px">` : `<div class="auth-brand-name">${esc(loginBrand.name)}</div>`}`
    : '<img src="logo-full.png" alt="MithMill — From Cold to Gold: Email Strategies That Shine">';
  if (loginBrand) document.title = `${loginBrand.name} Client Portal`;
  $app.innerHTML = `<div class="auth"><div class="card"><div class="auth-logo">${logo}</div>${inner}</div></div>`;
}

async function renderLogin() {
  if (location.hash !== '#/login') history.replaceState(null, '', `${location.search}#/login`);
  await loadLoginBrand();
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
    <p class="muted small" style="margin:16px 0 0">Access is by invitation only. Need an account? Contact your ${esc(loginBrand ? loginBrand.name : 'Mithmill')} account manager.</p>`);
  onSubmit(document.getElementById('f'), async (d) => {
    const r = await api('POST', '/api/auth/login', d);
    state.me = await api('GET', '/api/me');
    go(isAdminRole(r.role) ? '#/admin' : '#/dashboard');
  });
}

function renderVpnBlocked() {
  if (document.getElementById('vpn-retry')) return;
  authCard(`
    <div class="vpn-icon" aria-hidden="true">${icon('shield')}</div>
    <h1>Turn off your VPN to connect</h1>
    <p class="muted">We detected a VPN or proxy on your connection. For security, this account can only be used without one.</p>
    <ol class="vpn-steps">
      <li>Turn off your VPN or proxy (also check browser VPN extensions).</li>
      <li>Click <strong>Try again</strong>.</li>
    </ol>
    <button class="btn btn-primary" style="width:100%" id="vpn-retry">Try again</button>
    <p class="muted small" style="margin:16px 0 0">Still seeing this with the VPN off? Contact your ${esc(loginBrand ? loginBrand.name : 'Mithmill')} account manager.</p>`);
  document.getElementById('vpn-retry').onclick = () => { state.me = undefined; route(); };
}

function renderAccessPaused(message) {
  authCard(`
    <div class="vpn-icon" aria-hidden="true">${icon('pause')}</div>
    <h1>Portal access paused</h1>
    <p class="muted">${esc(message || 'Your portal access is paused. Please contact MithMill.')}</p>
    <button class="btn btn-primary" style="width:100%" id="paused-retry">Try again</button>
    <p class="muted small" style="margin:16px 0 0"><a href="#/login" id="paused-logout">Log out</a></p>`);
  document.getElementById('paused-retry').onclick = () => { state.me = undefined; route(); };
  document.getElementById('paused-logout').onclick = async (e) => {
    e.preventDefault();
    await api('POST', '/api/auth/logout');
    state.me = null;
    renderLogin();
  };
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
      <p class="muted small">Nothing arrived after a few minutes? Check your spam folder, or contact your ${esc(loginBrand ? loginBrand.name : 'Mithmill')} account manager.</p>
      <a class="btn" href="#/login">Back to login</a>`);
  });
}

async function renderInvite(token) {
  authCard('<p class="muted" style="margin-top:16px">Checking your invite…</p>');
  let inv;
  try {
    inv = await api('GET', `/api/invites/${encodeURIComponent(token)}`);
    if (inv.brand) loginBrand = inv.brand; else await loadLoginBrand();
  } catch (ex) {
    authCard(`<h1>Invite not valid</h1><p class="muted">${esc(ex.message)}</p><a class="btn" href="#/login">Go to login</a>`);
    return;
  }
  authCard(`
    <h1>${inv.reset ? 'Set a new password' : `Welcome to ${esc(inv.brand ? inv.brand.name : 'Mithmill')}`}</h1>
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

const CLIENT_TABS = [['#/dashboard', 'Dashboard'], ['#/mailboxes', 'Mailboxes'], ['#/domains', 'Domains'], ['#/order', 'New order'], ['#/billing', 'Billing']];

async function renderClient(page, arg, sub) {
  state.dash = await api('GET', '/api/dashboard');
  if (page === 'invoice' && arg) {
    renderInvoiceView(await api('GET', `/api/invoices/${encodeURIComponent(arg)}`), false);
    // "⬇ PDF": open the print dialog, where the client saves it as a PDF.
    if (sub === 'pdf') { history.replaceState(null, '', `#/invoice/${arg}`); setTimeout(() => window.print(), 300); }
    return;
  }
  if (page === 'order') return state.me.resellerClient ? go('#/dashboard') : renderOrder();
  if (page === 'billing') return renderBilling();
  if (page === 'notifications') return renderNotifications();
  if (page === 'mailboxes') {
    const [{ mailboxes: rows }, seq] = await Promise.all([api('GET', '/api/mailboxes'), api('GET', '/api/sequencers')]);
    return renderMyMailboxes(rows, seq);
  }
  if (page === 'domains') {
    const [{ domains }, hosts] = await Promise.all([api('GET', '/api/domains'), api('GET', '/api/domain-hosts')]);
    return renderMyDomains(domains, hosts);
  }
  return renderDashboard();
}

// A batch with several mailbox types is one batch: its parts (parent_order_id)
// show as sections of it, with one total.
function groupBatches(orders) {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const groups = [];
  const seen = new Set();
  for (const o of orders) {
    if (o.parent_order_id && byId.has(o.parent_order_id)) continue;
    const parts = orders.filter((p) => p.parent_order_id === o.id);
    groups.push({ main: o, all: [o, ...parts] });
    seen.add(o.id); parts.forEach((p) => seen.add(p.id));
  }
  orders.filter((o) => !seen.has(o.id)).forEach((o) => groups.push({ main: o, all: [o] }));
  return groups;
}

function batchesTable(orders) {
  if (!orders.length) return `<div class="empty">${state.me && state.me.resellerClient ? 'No mailboxes yet.' : 'No orders yet. Place your first order to get mailboxes set up.'}</div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Batch</th><th>Type</th><th class="num">Mailboxes</th><th>Status</th><th class="num">Amount</th><th>Next renewal</th><th>Ordered</th><th></th></tr></thead>
    <tbody>${groupBatches(orders).map(({ main: o, all }) => {
      const live = all.filter((p) => p.status !== 'cancelled');
      const multi = all.length > 1;
      const mailboxes = all.filter((p) => p.inbox_type !== 'other').reduce((n, p) => n + p.quantity, 0);
      return `<tr>
      <td>${o.batch_name ? `<strong>${esc(o.batch_name)}</strong><div class="muted small">#${o.id}</div>` : `#${o.id}`}</td>
      <td>${multi ? all.map((p) => `<div class="batch-part"><strong>${p.inbox_type === 'other' ? `${brandLogo('other', '')} ${esc(p.batch_name || 'Other service')}` : typeChip(p.inbox_type, p.inbox_label)}</strong> <span class="muted small">× ${p.quantity}${p.status === 'cancelled' ? ' · cancelled' : ''} · ${money(cycleAmount(p))}</span></div>`).join('')
        : typeChip(o.inbox_type, o.inbox_label)}<div class="muted small">${esc(lines(o.domains).slice(0, 2).join(', '))}${lines(o.domains).length > 2 ? '…' : ''}</div></td>
      <td class="num">${multi ? mailboxes : o.quantity}</td>
      <td>${badge(o.status)}</td>
      <td class="num">${o.status === 'cancelled' ? '<span class="muted">—</span>' : money(live.reduce((t, p) => t + cycleAmount(p), 0))}</td>
      <td>${o.status === 'active' ? fmtDate(o.next_billing_date) : '—'}</td>
      <td>${fmtDate(o.created_at)}</td>
      <td>${o.status !== 'cancelled' ? `<button class="btn btn-sm btn-danger" data-cancel="${o.id}">Cancel</button>` : ''}</td>
    </tr>`;
    }).join('')}</tbody></table></div>`;
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
    `Hi ${state.dash.brandName || 'Mithmill'} team,`,
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
    <div class="modal-head"><h2>Cancel batch #${order.id}</h2><button class="btn btn-sm btn-ghost" data-close aria-label="Close">${icon('close')}</button></div>
    <div class="note"><span class="note-icon">${icon('alert')}</span><div><strong>Please copy this email and send it from your registered email, ${esc(user.email)}, to <a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a>.</strong> Requests from other addresses can't be accepted. Your mailboxes stay active until we confirm the cancellation.</div></div>
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
      ${state.me.resellerClient ? '' : '<a class="btn btn-primary" href="#/order">+ New order</a>'}
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
          <tbody>${active.map((o) => `<tr><td>${esc(batchTitle(o))}</td><td>${typeChip(o.inbox_type, o.inbox_label)}</td><td class="num">${o.quantity}</td><td>${fmtDate(o.next_billing_date)}</td><td class="num">${money(cycleAmount(o))}</td></tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty">No active batches yet.</div>'}
      </div>
      <div class="card">
        <div class="card-head"><h2>Invoices</h2></div>
        ${invoices.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Invoice</th><th>Description</th><th>Date</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody>${invoices.map((i) => {
            const s = i.status === 'unpaid' && i.due_date < today ? 'overdue' : i.status;
            return `<tr><td><a href="#/invoice/${i.id}">#${i.id}</a></td><td>${esc(i.description)}</td><td>${fmtDate(i.issue_date || i.created_at)}${i.status === 'unpaid' ? `<div class="muted small">Due ${fmtDate(i.due_date)}</div>` : ''}</td><td>${badge(s)}${i.paid_at ? `<div class="muted small">${fmtDate(i.paid_at)}</div>` : ''}</td><td class="num">${money(i.amount)}</td><td><div class="row" style="flex-wrap:nowrap"><a class="btn btn-sm" href="#/invoice/${i.id}">View</a><a class="btn btn-sm" href="#/invoice/${i.id}/pdf" title="Download as PDF">${icon('download')} PDF</a></div></td></tr>`;
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
            <div class="t-logo">${brandLogo(p.inbox_type, p.label)}</div>
            <div class="t-name">${esc(p.label)}</div>
            <div class="t-price">${money(p.price_per_mailbox)} per mailbox / month</div>
            <div class="t-desc">${esc(p.description || TYPE_INFO[p.inbox_type] || '')}</div>
          </button>`).join('')}</div>
        <div class="row" style="justify-content:flex-end;margin-top:20px"><button class="btn btn-primary" id="next1" ${data.inbox_type ? '' : 'disabled'}>Continue</button></div>
      </div>`;
  } else if (step === 2) {
    const v = (k) => esc(data[k] || '');
    const sel = (k, val) => (data[k] === val ? 'selected' : '');
    const support = state.dash.supportEmail || 'support@mithmill.com';
    // Pre-warmed types come on our own domains: nothing to ask about domains.
    const own = price.needs_domains !== false;
    body = `
      <form class="card card-pad" id="f2">
        <h2>${esc(price.label)} details</h2>
        <p class="muted small" style="margin:4px 0 16px">${money(price.price_per_mailbox)} per mailbox / month</p>

        ${own ? '' : `<div class="note note-info" style="margin-bottom:16px"><span class="note-icon">${icon('flame')}</span><div><strong>${esc(price.label)} come ready on our own warmed-up domains.</strong> You don't need to give us any domains or DNS access. Just tell us how many mailboxes you need and invite us to your sequencer below.</div></div>`}
        <div class="csv-box" ${own ? '' : 'hidden'}>
          <div class="csv-head">
            <div><h3>Onboarding sheet (CSV)</h3>
              <div class="muted small">One row per mailbox user: domain, full name, username, passwords, domain and sequencer access, profile picture link and domain forward.
              ${state.dash.csvRequiredMin > 0 ? `<strong>Required for orders of ${state.dash.csvRequiredMin} or more mailboxes.</strong>` : ''}</div></div>
            <a class="btn btn-sm" href="/api/onboarding-template.csv" download>${icon('download')} Download sample CSV</a>
          </div>
          <div class="row">
            <label class="btn btn-sm btn-primary file-btn">${icon('upload')} Upload filled CSV<input type="file" id="csv-file" accept=".csv,text/csv" hidden></label>
            <span class="small" id="csv-status">${data.onboarding_filename ? `<span class="ok-ico">${icon('check')}</span> ${esc(data.onboarding_filename)}: ${data.csv_users} users across ${data.csv_domains} domain${data.csv_domains === 1 ? '' : 's'} <button type="button" class="btn btn-sm btn-ghost" id="csv-remove">Remove</button>` : '<span class="muted">No file uploaded</span>'}</span>
          </div>
          <div class="error csv-err" id="csv-error" role="alert"></div>
        </div>

        <div class="grid-2">
          <div class="field"><label for="quantity">Number of mailboxes</label><input id="quantity" name="quantity" type="number" min="1" max="10000" required value="${v('quantity')}"></div>
          <div class="field"><label>Estimated monthly cost</label><input id="est" disabled value="${money((Number(data.quantity) || 0) * price.price_per_mailbox)}"></div>
        </div>

        <div id="domain-part" ${own ? '' : 'hidden'}>
        <div class="grid-2">
          <div class="field"><label for="domains">Domain names</label><textarea id="domains" name="domains" placeholder="acme-mail.com&#10;getacme.co">${v('domains')}</textarea><div class="hint">One domain per line.${data.onboarding_csv ? ' Filled in from your CSV.' : ''}</div></div>
          <div class="field"><label for="usernames">Usernames</label><textarea id="usernames" name="usernames" placeholder="John Smith - john&#10;Jane Doe - jane.doe">${v('usernames')}</textarea><div class="hint">One per line: full name and the part before the @.</div></div>
        </div>

        <h3 class="section-title">Domain access</h3>
        <div class="note note-info invite-note"><span class="note-icon">${icon('globe')}</span><div>
          <strong>Invite us to manage your domains' DNS:</strong> at your domain registrar or DNS provider (GoDaddy, Namecheap, Cloudflare…), add
          <strong>${esc(support)}</strong> as a user / delegate with DNS access.
          <label class="check invite-check"><input type="checkbox" name="domain_invited" id="domain_invited" ${data.domain_invited ? 'checked' : ''}> I've sent the invitation to ${esc(support)}</label>
        </div></div>
        <div id="domain-invited-msg" class="muted small" ${data.domain_invited ? '' : 'hidden'} style="margin:-6px 0 14px">Great, we'll accept it and set up the domains and usernames you listed above.</div>
        <div id="domain-manual" ${data.domain_invited ? 'hidden' : ''}>
        <div class="field"><label for="domain_access_method">Not invited us? How will we get access to your domains?</label>
          <select id="domain_access_method" name="domain_access_method" ${data.domain_invited || !own ? '' : 'required'}>
            <option value="">Choose…</option>
            ${Object.entries(ACCESS_LABEL).map(([k, l]) => `<option value="${k}" ${sel('domain_access_method', k)}>${esc(l)}</option>`).join('')}
          </select></div>
        <div class="grid-2">
          <div class="field"><label for="registrar">Domain registrar / DNS provider</label><input id="registrar" name="registrar" placeholder="GoDaddy, Namecheap, Cloudflare…" value="${v('registrar')}"></div>
          <div class="field"><label for="registrar_email">Registrar account email</label><input id="registrar_email" name="registrar_email" type="email" value="${v('registrar_email')}"></div>
        </div>
        <div class="field"><label for="domain_access_notes">Domain access notes</label><textarea id="domain_access_notes" name="domain_access_notes" style="min-height:64px">${v('domain_access_notes')}</textarea>
          <div class="hint">Please don't paste passwords here. If you're sharing a login, we'll contact you to collect it securely.</div></div>
        </div>
        </div>

        <h3 class="section-title">Sequencer access</h3>
        <div class="note note-info invite-note"><span class="note-icon">${icon('send')}</span><div>
          <strong>Invite us to your sequencer so we can connect the mailboxes:</strong> add <strong>${esc(support)}</strong> as a team member in your sequencer workspace.
          <label class="check invite-check"><input type="checkbox" name="sequencer_invited" id="sequencer_invited" ${data.sequencer_invited ? 'checked' : ''}> I've sent the invitation to ${esc(support)}</label>
        </div></div>
        <div class="grid-2">
          <div class="field"><label for="sequencer">Which sequencer?</label>
            <select id="sequencer" name="sequencer" required>
              <option value="">Choose…</option>
              ${SEQUENCERS.map((s) => `<option ${sel('sequencer', s)}>${s}</option>`).join('')}
            </select></div>
          <div class="field"><label for="sequencer_workspace">Workspace name</label><input id="sequencer_workspace" name="sequencer_workspace" value="${v('sequencer_workspace')}" ${data.sequencer_invited ? 'required' : ''}></div>
        </div>
        <div class="field" id="seq-other" ${data.sequencer === 'Other' ? '' : 'hidden'}><label for="sequencer_other">Sequencer name</label><input id="sequencer_other" name="sequencer_other" value="${v('sequencer_other')}" placeholder="e.g. Saleshandy" ${data.sequencer === 'Other' ? 'required' : ''}></div>
        <div class="grid-2" id="seq-manual" ${data.sequencer_invited ? 'hidden' : ''}>
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
            ${price.needs_domains === false ? row('Domains', 'Our own pre-warmed domains (nothing needed from you)') : ''}
            ${price.needs_domains === false ? '' : row('Domain access', data.domain_invited ? `Invited ${state.dash.supportEmail || 'support@mithmill.com'} to manage DNS` : ACCESS_LABEL[data.domain_access_method])}
            ${row('Registrar', data.registrar)}
            ${row('Registrar email', data.registrar_email)}
            ${row('Domain access notes', data.domain_access_notes)}
            ${row('Sequencer', data.sequencer === 'Other' ? data.sequencer_other : data.sequencer)}
            ${row('Sequencer access', data.sequencer_invited ? `Invited ${state.dash.supportEmail || 'support@mithmill.com'}` : '')}
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
    // Checkboxes as true/false (FormData leaves unticked ones out).
    const save = () => Object.assign(data, formData(form), {
      domain_invited: form.domain_invited.checked, sequencer_invited: form.sequencer_invited.checked,
    });
    // "I've sent the invitation" hides the access details we no longer need.
    const syncInvites = () => {
      const dom = form.domain_invited.checked;
      document.getElementById('domain-manual').hidden = dom;
      document.getElementById('domain-invited-msg').hidden = !dom;
      form.domain_access_method.required = !dom && price.needs_domains !== false;
      const seq = form.sequencer_invited.checked;
      document.getElementById('seq-manual').hidden = seq;
      form.sequencer_workspace.required = seq;
      const other = form.sequencer.value === 'Other';
      document.getElementById('seq-other').hidden = !other;
      form.sequencer_other.required = other;
    };
    ['domain_invited', 'sequencer_invited', 'sequencer'].forEach((n) => form[n].addEventListener('change', syncInvites));
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
      Object.assign(data, d, { domain_invited: form.domain_invited.checked, sequencer_invited: form.sequencer_invited.checked });
      if (data.domain_invited) delete data.domain_access_method;
      if (price.needs_domains === false) {
        ['domains', 'usernames', 'domain_access_method', 'registrar', 'registrar_email', 'domain_access_notes',
          'onboarding_csv', 'onboarding_filename', 'csv_users', 'csv_domains'].forEach((k) => delete data[k]);
        data.domain_invited = false;
        state.order.step = 3;
        renderOrder();
        window.scrollTo(0, 0);
        return;
      }
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
    ADMIN_TABS.push(['#/admin/orders', 'Batches'], ['#/admin/clients', 'Clients'], ['#/admin/mailboxes', 'Mailboxes'], ['#/admin/domains', 'Domains'], ['#/admin/invoices', 'Invoices'], ['#/admin/payouts', 'Payouts'], ['#/admin/settings', 'Settings']);
    return;
  }
  ADMIN_TABS.push(['#/admin/orders', 'Orders'], ['#/admin/clients', 'Clients & invites'], ['#/admin/mailboxes', 'Mailboxes'], ['#/admin/domains', 'Domains'], ['#/admin/invoices', 'Invoices']);
  if (isOwner()) ADMIN_TABS.unshift(['#/admin/analytics', 'Analytics']);
  if (isOwner()) ADMIN_TABS.push(['#/admin/resellers', 'Resellers'], ['#/admin/locations', 'Locations'], ['#/admin/team', 'Team'], ['#/admin/settings', 'Settings']);
}

async function renderAdmin(page, arg, sub) {
  const raw = await api('GET', `${API()}/overview`);
  // The owner's main pages leave out resellers' clients; they're on the Resellers page.
  const direct = (rows) => rows.filter((r) => !r.reseller_id);
  // Invoices: the owner also sees resellers' invoices there, tagged (team members never get them).
  state.admin = isOwner() && page !== 'invoice'
    ? { ...raw, orders: direct(raw.orders), clients: direct(raw.clients), invoices: page === 'invoices' ? raw.invoices : direct(raw.invoices) } : raw;
  if (isReseller()) {
    if (page === 'settings') return resellerSettings(await api('GET', '/api/reseller/settings'));
    if (page === 'payouts') return resellerPayouts(await api('GET', '/api/reseller/payouts'));
    if (['team', 'analytics', 'resellers'].includes(page)) return go('#/admin/orders');
  }
  if ((page === 'domains' || page === 'mailboxes') && !state.samples) state.samples = await api('GET', '/api/upload-samples');
  if (page === 'domains') return arg ? adminDomainClient(await api('GET', `${API()}/clients/${encodeURIComponent(arg)}/domains`)) : adminDomains();
  if (page === 'mailboxes') return arg ? adminMailboxClient(await api('GET', `${API()}/clients/${encodeURIComponent(arg)}/mailboxes`)) : adminMailboxes();
  if (page === 'locations') return isOwner() ? renderLocations(await api('GET', '/api/admin/locations')) : go('#/admin/orders');
  if (page === 'resellers') {
    if (!isOwner()) return go('#/admin/orders');
    return arg ? renderResellerDetail({
      ...(await api('GET', `/api/admin/resellers/${encodeURIComponent(arg)}`)),
      pay: await api('GET', `/api/admin/resellers/${encodeURIComponent(arg)}/payouts`),
    })
      : renderResellers(await api('GET', '/api/admin/resellers'));
  }
  if (page === 'invoice') {
    if (arg === 'new') return invoiceEditor(null);
    const inv = await api('GET', `${API()}/invoices/${encodeURIComponent(arg)}`);
    return sub === 'edit' ? invoiceEditor(inv) : renderInvoiceView(inv, true);
  }
  if (page === 'team' && isOwner()) return renderTeam(await api('GET', `${API()}/team`));
  if (page === 'analytics') return isOwner() ? renderAnalytics(await loadAnalytics()) : go('#/admin/orders');
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
  // Parts of a multi-type batch are billed on their parent's invoice: one row each batch.
  const parts = (o) => orders.filter((p) => p.parent_order_id === o.id && p.status === 'active');
  const rows = orders
    .filter((o) => o.status === 'active' && o.next_billing_date && days(o.next_billing_date) <= 30)
    .filter((o) => !(o.parent_order_id && orders.some((p) => p.id === o.parent_order_id && p.status === 'active')))
    .map((o) => { const ps = parts(o); return ps.length ? { ...o, quantity: o.quantity + ps.reduce((n, p) => n + p.quantity, 0), inbox_label: [o, ...ps].map((p) => `${p.quantity} × ${p.inbox_label}`).join(' + '), _amount: [o, ...ps].reduce((n, p) => n + cycleAmount(p), 0), _multi: true } : o; })
    .sort((a, b) => a.next_billing_date.localeCompare(b.next_billing_date));
  const invoiceFor = (o) => invoices.find((i) => i.order_id === o.id && i.period_start === o.next_billing_date && i.status !== 'void');
  return `<div class="card">
    <div class="card-head"><div><h2>Upcoming renewals</h2><div class="muted small">Next 30 days · clients are reminded 7, 3 and 1 day before</div></div>
      <span class="muted small">${rows.length} batch${rows.length === 1 ? '' : 'es'} · ${money(rows.reduce((n, o) => n + (o._amount ?? cycleAmount(o)), 0))}</span></div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Renews</th><th>Client</th><th>Batch</th><th>Cycle</th><th class="num">Amount</th><th>Invoice</th></tr></thead>
      <tbody>${rows.map((o) => {
        const d = days(o.next_billing_date);
        const inv = invoiceFor(o);
        return `<tr>
          <td><strong>${fmtDate(o.next_billing_date)}</strong><div class="muted small">${d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`}</div></td>
          <td>${esc(o.company || o.name || o.email)}<div class="muted small">${esc(o.email)}</div></td>
          <td>${esc(batchTitle(o))}<div class="muted small">${o._multi ? esc(o.inbox_label) : `${o.quantity} × ${esc(o.inbox_label)}`}</div></td>
          <td>${cycleName(cycleOf(o))}</td>
          <td class="num">${money(o._amount ?? cycleAmount(o))}</td>
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
          <span>${esc(o.company || o.name || o.email)}<div class="muted small">${o.parent_order_id ? `<strong>Part of batch #${o.parent_order_id}</strong> (same invoice) · ` : ''}${o.batch_name ? `${esc(o.batch_name)} · ` : ''}${esc(o.email)}${o.seller ? ` · Sold by ${esc(o.seller)}` : ''}</div></span>
          <span class="hide-sm">${typeChip(o.inbox_type, o.inbox_label)}</span>
          <span class="hide-sm num">${o.quantity} boxes</span>
          <span class="hide-sm">${o.status === 'active' && o.next_billing_date ? `${fmtDate(o.next_billing_date)}<div class="muted small">${cycleName(cycleOf(o))}</div>` : `<span class="muted small">Ordered</span> ${fmtDate(o.created_at)}`}</span>
          <span>${badge(o.status)}</span>
        </summary>
        <div class="order-body">
          <div class="stack" style="gap:14px">
            ${o.domains ? `<div><h3>Domains</h3><pre>${esc(o.domains)}</pre></div>` : ''}
            ${o.usernames ? `<div><h3>Usernames</h3><pre>${esc(o.usernames)}</pre></div>` : ''}
            ${o.parent_order_id ? `<div class="note note-info"><div>Part of <a href="#/admin/orders/${o.parent_order_id}">batch #${o.parent_order_id}</a>: billed on the same invoice and payment link, renews and cancels with it.</div></div>` : ''}
            <dl class="kv">
              ${kv('Type', o.inbox_label)}
              ${o.seller ? kv('Sold by', `${o.seller} (set on the client)`) : ''}
              ${kv('Mailboxes', String(o.quantity))}
              ${kv('Price', `${money(o.price_per_mailbox)} / mailbox / month → ${money(cycleAmount(o))} per ${perCycle(cycleOf(o))}`)}
              ${kv('Billing', `${cycleName(cycleOf(o))}${o.status === 'active' && o.next_billing_date ? `, next renewal ${fmtDate(o.next_billing_date)}` : ''}`)}
              ${o.domain_invited ? kv('DNS invitation', 'Client says they invited our support email') : ''}
              ${o.sequencer_invited ? kv('Sequencer invitation', 'Client says they invited our support email') : ''}
              ${o.domain_invited ? '' : kv('Domain access', ACCESS_LABEL[o.domain_access_method] || o.domain_access_method)}
              ${kv('Registrar', o.registrar)}
              ${kv('Registrar email', o.registrar_email)}
              ${kv('Access notes', o.domain_access_notes)}
              ${kv('Sequencer', o.sequencer)}
              ${kv('Workspace', o.sequencer_workspace)}
              ${kv('Sequencer email', o.sequencer_email)}
              ${kv('Sequencer notes', o.sequencer_notes)}
              ${kv('Client notes', o.notes)}
            </dl>
            ${isReseller() ? '' : o.csv_rows ? `<div><a class="btn btn-primary btn-sm" href="/api/admin/orders/${o.id}/onboarding.csv">${icon('download')} Download onboarding CSV (${o.csv_rows} rows)</a></div>` : '<div class="muted small">No onboarding CSV uploaded.</div>'}
          </div>
          <form class="order-form" data-id="${o.id}">
            ${['pending', 'in_progress'].includes(o.status) ? `<div class="complete-box">
              <button type="button" class="btn btn-success" data-complete="${o.id}">${icon('check')} Mark as completed</button>
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
    <div class="modal-head"><h2>Cancel subscription</h2><button type="button" class="btn btn-sm btn-ghost" data-close aria-label="Close">${icon('close')}</button></div>
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
      <div class="modal-head"><h2>Add batch</h2><button type="button" class="btn btn-sm btn-ghost" data-close aria-label="Close">${icon('close')}</button></div>
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
      <div class="note note-info billing-only" style="margin:-4px 0 16px"><span class="note-icon">${icon('calendar')}</span><div id="renew-preview"></div></div>
      <div class="field billing-only"><label>Invoices</label><select name="current_period">
        <option value="all_paid_current_unpaid" selected>Current period unpaid (still to be paid), earlier periods paid</option>
        <option value="all_paid">Everything already paid, including the current period</option>
        <option value="unpaid">Only the current period, unpaid</option>
        <option value="paid">Only the current period, paid</option>
        <option value="none">Don't create invoices</option></select>
        <div class="note note-info" style="margin-top:8px"><span class="note-icon">${icon('receipt')}</span><div id="inv-preview"></div></div></div>
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
    clearFilters('invoices'); // so the new invoice shows on the Invoices page
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
  dlg.innerHTML = `<div class="modal-head"><h2>Edit client</h2><button class="btn btn-sm btn-ghost" type="button" id="c-close" aria-label="Close">${icon('close')}</button></div>
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
// more space-separated values); rows that don't match are hidden. Every visit
// to the page starts unfiltered, so nothing stays hidden by an old filter.

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
    bar.classList.toggle('fb-active', Boolean(active));
    // Never a silently empty list: say the filters are hiding everything.
    let empty = bar.parentElement.querySelector('.fb-empty');
    if (!empty && table) {
      empty = document.createElement('div');
      empty.className = 'empty fb-empty';
      empty.innerHTML = 'Nothing matches your search and filters. <button type="button" class="btn btn-sm">Clear filters</button>';
      empty.querySelector('button').onclick = () => clear.click();
      table.closest('.table-wrap').after(empty);
    }
    if (empty) empty.hidden = !(active && shown === 0);
    const sum = rows.some((tr) => tr.dataset.amount !== undefined) ? ` · ${money(total)}` : '';
    bar.querySelector('.fb-count').textContent = active ? `${shown} of ${rows.length}${sum}` : '';
  };
  q.addEventListener('input', apply);
  selects.forEach((sel) => sel.addEventListener('change', apply));
  clear.onclick = () => { q.value = ''; selects.forEach((sel) => { sel.value = ''; }); apply(); q.focus(); };
  apply();
}

function clearFilters(key) {
  try { sessionStorage.removeItem(`fb:${key}`); } catch { /* private mode */ }
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
        ${isOwner() ? vpnToggle() : ''}
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
          <thead><tr><th>Client</th><th>Account</th><th>Pricing</th><th class="num">Active mailboxes</th><th class="num">Monthly</th><th></th></tr></thead>
          <tbody>${clients.map((c) => {
            const custom = clientPricing.filter((cp) => cp.user_id === c.id);
            return `<tr data-id="${c.id}" data-search="${searchText(c.company, c.name, c.email, c.seller)}" data-seller="${esc(c.seller || '__none')}"
              data-account="${c.password_set ? 'joined' : c.invited ? 'invited' : 'not_invited'}" data-active="${c.active_mailboxes > 0 ? 'yes' : 'no'}">
            <td>${clientCell(c, `<div class="cc-row">${icon('calendar')}<span>Added ${fmtDate(c.created_at)}</span></div>`)}</td>
            <td>${c.password_set ? '<span class="badge b-active">Joined</span>' : c.invited ? '<span class="badge b-in_progress">Invited</span>' : '<span class="badge b-pending">Not invited</span>'}
              ${isOwner() ? `<label class="access-toggle" title="Turn off to block this client from the portal for now"><span class="switch switch-sm"><input type="checkbox" data-access="${c.id}" aria-label="Portal access for ${esc(c.email)}" ${c.access_blocked ? '' : 'checked'}><span></span></span><span class="small ${c.access_blocked ? 'access-off' : 'muted'}">${c.access_blocked ? 'Access blocked' : 'Portal access'}</span></label>`
                : c.access_blocked ? '<div class="small access-off">Access blocked</div>' : ''}</td>
            <td>${custom.length ? `<span class="badge b-in_progress">Custom</span><div class="muted small">${custom.map((cp) => `${esc(labelOf(cp.inbox_type))} ${money(cp.price_per_mailbox)}`).join('<br>')}</div>` : '<span class="muted small">Standard</span>'}</td>
            <td class="num">${c.active_mailboxes}</td><td class="num">${money(c.monthly)}</td>
            <td><div class="row client-actions"><button class="btn btn-sm btn-primary" data-batch="${c.id}">+ Add batch</button>${watchBtn(c.id)}${moreMenu(`
              <button type="button" class="menu-item" data-edit="${c.id}">${icon('settings')}Edit client</button>
              <button type="button" class="menu-item" data-prices="${c.id}">${icon('billing')}Edit pricing</button>
              <button type="button" class="menu-item" data-reset="${esc(c.email)}">${icon('send')}${c.password_set ? 'Send reset link' : c.invited ? 'Resend invite' : 'Send invite'}</button>
              <a class="menu-item" href="#/admin/mailboxes/${c.id}">${icon('mail')}Mailboxes${c.mailbox_count ? ` (${c.mailbox_count})` : ''}</a>
              <a class="menu-item" href="#/admin/domains/${c.id}">${icon('globe')}Domains${c.domain_count ? ` (${c.domain_count})` : ''}</a>
              ${isOwner() ? `<div class="menu-sep"></div><button type="button" class="menu-item menu-danger" data-delete-client="${c.id}">${icon('close')}Delete client</button>` : ''}`)}</div></td>
          </tr>
          <tr class="price-row" id="prices-${c.id}" data-for="${c.id}" hidden><td colspan="6">
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
      <div class="note" style="margin-top:12px"><span class="note-icon">${icon('link')}</span><div style="min-width:0;flex:1">
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
      const r = await api('POST', `${API()}/clients`, { ...d, block_vpn: d.block_vpn === 'on' });
      toast(`${d.email} added. Now add their batches.`);
      state.admin = await api('GET', `${API()}/overview`);
      adminClients();
      openBatchDialog(r.id);
    } catch (ex) { err.textContent = ex.message; }
  };
  document.querySelectorAll('[data-batch]').forEach((b) => { b.onclick = () => openBatchDialog(Number(b.dataset.batch)); });
  wireAccessToggles();
  onSubmit(document.getElementById('inv'), async (d) => {
    const r = await api('POST', `${API()}/invites`, { ...d, block_vpn: d.block_vpn === 'on' });
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
  if (status === 'paid' && !confirm(`Mark invoice #${id} as paid?\n\nThe client gets a "Payment received, thank you for your purchase" email.`)) return false;
  const r = await api('PATCH', `${API()}/invoices/${id}`, { status });
  toast(r.thanked ? `Invoice #${id} marked paid · thank-you email sent to ${r.thanked}` : `Invoice #${id} updated`);
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
        ...(isOwner() && invoices.some((i) => i.reseller_id) ? [{ name: 'source', label: 'Clients: all', options: [['direct', 'Our clients'], ['reseller', 'Resellers\' clients'],
          ...[...new Set(invoices.filter((i) => i.reseller_id).map((i) => String(i.reseller_name || '')))].map((n) => [`r:${n.replace(/ /g, '\u00a0')}`, `Reseller: ${n}`])] }] : []),
        { name: 'month', label: 'Issued: any month', options: [...new Set(invoices.map((i) => String(i.issue_date || i.created_at).slice(0, 7)))].sort().reverse().map((m) => [m, monthName(m)]) },
      ]) : ''}
      ${invoices.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Client</th><th>Description</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>${invoices.map((i) => {
          const s = i.status === 'unpaid' && i.due_date < today ? 'overdue' : i.status;
          const in7 = i.status === 'unpaid' && i.due_date >= today && i.due_date <= week;
          return `<tr data-id="${i.id}" data-search="${searchText(`#${i.id}`, i.id, i.company, i.name, i.email, i.description, i.seller)}"
            data-status="${s === 'overdue' ? 'unpaid overdue' : s}${in7 ? ' due7' : ''}" data-seller="${esc(i.seller || '__none')}" data-source="${i.reseller_id ? `reseller r:${esc(String(i.reseller_name || '').replace(/ /g, '\u00a0'))}` : 'direct'}" data-amount="${Number(i.amount) || 0}" data-month="${String(i.issue_date || i.created_at).slice(0, 7)}"><td><a href="#/admin/invoice/${i.id}">${i.id}</a></td><td>${esc(i.company || i.name || i.email)}${(i.company || i.name) ? `<div class="muted small">${esc(i.email)}</div>` : ''}${i.reseller_id && isOwner() ? `<div><span class="badge b-in_progress">Reseller: ${esc(i.reseller_name || '')}</span></div>` : ''}${i.seller ? `<div class="muted small">Sold by ${esc(i.seller)}</div>` : ''}</td><td>${esc(i.description)}</td><td>${fmtDate(i.issue_date || i.created_at)}</td><td>${fmtDate(i.due_date)}</td><td>${badge(s)}</td><td class="num">${money(i.amount)}</td>
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
        ${!isNew && inv.status !== 'paid' ? `<label class="check" id="e-thank-wrap" hidden><input type="checkbox" id="e-thank" checked> Email the client a "Payment received, thank you" note</label>` : ''}
        ${isNew ? `<div class="batch-opt" id="e-batch-box">
          <label class="check"><input type="checkbox" id="e-batches" checked> <strong>Add the mailbox lines (and Other lines ticked Recurring) to the client's dashboard as active batches</strong></label>
          <div class="hint" style="margin:4px 0 10px 24px">Use this when the invoice is for mailboxes the client doesn't have as a batch yet. They renew from the issue date. Untick for one-off charges, or link an existing batch above instead.</div>
          <div style="margin-left:24px;max-width:420px">${cycleFields(1)}</div>
        </div>` : ''}
      </div>

      <div class="row" style="justify-content:flex-end;align-items:center">
        <span class="muted small">Save keeps it in the portal only. Save &amp; send also emails the invoice to the client.</span>
        <button class="btn" type="submit" value="save">${isNew ? 'Save invoice' : 'Save changes'}</button>
        <button class="btn btn-primary" type="submit" value="send">Save &amp; send to client</button>
      </div>
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
      <td><button type="button" class="btn btn-sm btn-ghost" data-remove="${i}" ${ed.items.length === 1 ? 'disabled' : ''} aria-label="Remove line">${icon('close')}</button></td>
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
  $('e-status').onchange = (e) => {
    $('e-paid-wrap').hidden = e.target.value !== 'paid';
    if ($('e-thank-wrap')) $('e-thank-wrap').hidden = e.target.value !== 'paid';
  };
  if (isNew) {
    wireCycleFields($('e-batch-box'));
    const syncBatchBox = () => { $('e-batch-box').hidden = Boolean(ed.order_id); };
    $('e-order').addEventListener('change', syncBatchBox);
    $('e-user').addEventListener('change', syncBatchBox);
    syncBatchBox();
  }

  $('inv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Which button: "Save" or "Save & send to client".
    const sendIt = e.submitter && e.submitter.value === 'send';
    const btns = [...e.target.querySelectorAll('[type=submit]')];
    btns.forEach((b) => { b.disabled = true; });
    $('e-error').textContent = '';
    const body = {
      user_id: ed.user_id, order_id: ed.order_id || null, issue_date: ed.issue_date, due_date: ed.due_date,
      discount: ed.discount || 0, notes: ed.notes, items: ed.items, notify: false,
      status: $('e-status').value, paid_date: $('e-paid').value, thank: $('e-thank') ? $('e-thank').checked : false,
      ...(isNew && !ed.order_id && $('e-batches').checked ? {
        create_batches: true,
        billing_cycle: $('e-batch-box').querySelector('[name=billing_cycle]').value,
        custom_months: $('e-batch-box').querySelector('[name=custom_months]').value,
      } : {}),
    };
    try {
      const r = isNew ? await api('POST', `${API()}/invoices`, body) : await api('PUT', `${API()}/invoices/${inv.id}`, body);
      if (isNew) clearFilters('invoices');
      const id = isNew ? r.id : inv.id;
      let msg = isNew ? `Invoice #${id} created${r.batchIds && r.batchIds.length ? ` and ${r.batchIds.length} batch${r.batchIds.length === 1 ? '' : 'es'} added to the dashboard` : ''}` : `Invoice #${id} saved${r.thanked ? ` · thank-you email sent to ${r.thanked}` : ''}`;
      if (sendIt) {
        try {
          const sent = await api('POST', `${API()}/invoices/${id}/send`);
          msg += ` · emailed to ${sent.to}`;
        } catch (ex) {
          msg += ` · but the email failed: ${ex.message}`;
        }
      }
      toast(msg);
      go(`#/admin/invoice/${id}`);
    } catch (ex) {
      $('e-error').textContent = ex.message;
      btns.forEach((b) => { b.disabled = false; });
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
        ${isAdmin && inv.status === 'unpaid' ? `<button class="btn btn-danger" id="send-urgent" title="${inv.urgent_sent_at ? `Last sent ${esc(fmtDate(inv.urgent_sent_at))}` : 'Critical alert: mailboxes expire in a few hours'}">${icon('alert')} Urgent reminder</button>` : ''}
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
        <div><div class="inv-label">Payable to</div>${inv.brand && !inv.brand.mixxbee ? `<strong>${esc(inv.brand.name)}</strong>` : `<strong>Mixxbee LLC</strong><div>on behalf of ${esc(inv.brand ? inv.brand.name : 'Mithmill')}</div>`}</div>
        <div class="inv-dates">
          <div><span class="inv-label">Issue date</span><span>${fmtDate(inv.issue_date || inv.created_at)}</span></div>
          <div><span class="inv-label">Due date</span><span>${fmtDate(inv.due_date)}</span></div>
          ${inv.paid_at ? `<div><span class="inv-label">Paid on</span><span>${fmtDate(inv.paid_at)}</span></div>` : ''}
        </div>
      </section>
      <div class="table-wrap"><table class="inv-items">
        <thead><tr><th>Mailbox type</th><th>Batch</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
        <tbody>${inv.items.map((it) => `<tr>
          <td>${typeLabel(it.inbox_type, inv.pricing) ? typeChip(it.inbox_type, typeLabel(it.inbox_type, inv.pricing)) : '—'}</td><td>${esc(it.batch_name) || '—'}</td><td>${esc(it.description)}</td>
          <td class="num">${qty(it.quantity)}</td><td class="num">${money(it.unit_price)}</td><td class="num">${money(it.quantity * it.unit_price)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="totals inv-totals">
        <div><span>Subtotal</span><span>${money(subtotal)}</span></div>
        ${inv.discount ? `<div><span>Discount</span><span>−${money(inv.discount)}</span></div>` : ''}
        <div class="grand"><span>Total due</span><span>${money(inv.amount)}</span></div>
      </div>
      ${isAdmin && !inv.order_id && inv.items.some((it) => (it.inbox_type && it.inbox_type !== 'other') || (it.inbox_type === 'other' && it.recurring)) ? `<div class="note no-print" id="to-batch">
        <span class="note-icon">${icon('alert')}</span>
        <div style="flex:1"><strong>These mailboxes aren't on the client's dashboard.</strong> This invoice isn't linked to a batch, so the client's active mailboxes and billing don't include it.
          <div class="row" style="margin-top:10px;align-items:flex-end">
            <div style="min-width:260px">${cycleFields(1)}</div>
            <button class="btn btn-primary" id="make-batch" style="margin-bottom:16px">Add as active batch</button>
          </div></div></div>` : ''}
      ${inv.payLinks && inv.payLinks.length ? `<section class="inv-pay no-print">${inv.payLinks.map((l) => `${l.hint ? `<div class="pay-hint">${esc(l.hint)}</div>` : ''}<a class="btn btn-primary btn-pay" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}
        <div class="muted small">After paying, send us the payment screenshot by replying to the invoice email or in your WhatsApp or Slack group with us.</div></section>` : ''}
      ${inv.notes ? `<section class="inv-notes"><div class="inv-label">Notes</div><div>${linkify(esc(inv.notes))}</div></section>` : ''}
      ${inv.brand && !inv.brand.mixxbee ? (inv.paymentNote ? `<div class="note"><span class="note-icon">ℹ️</span><div><strong>Payment details:</strong><div>${linkify(esc(inv.paymentNote)).replace(/\n/g, '<br>')}</div></div></div>` : '')
        : `<div class="note"><span class="note-icon">ℹ️</span><div><strong>Payment notice:</strong> ${esc(inv.paymentNote)}</div></div>`}
      ${inv.brand && !inv.brand.mixxbee ? '' : `<div class="inv-powered"><span>Payments powered by</span><img src="mixxbee-logo.png" alt="Mixxbee"></div>`}
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
  const verb = { added: 'added', edited: 'edited', deleted: 'deleted', invited: 'sent an invite:', revoked: 'revoked', cancelled: 'cancelled', sent: 'emailed', watched: 'opened the dashboard of' };
  const changeList = (changes, action) => (changes.length ? `<ul class="changes">${changes.map((c) => {
    const pre = (v) => (/\n/.test(v) || v.length > 80 ? `<pre>${esc(v)}</pre>` : `<span>${esc(v)}</span>`);
    if (action === 'added' || action === 'invited') return `<li><strong>${esc(c.field)}:</strong> ${pre(c.to)}</li>`;
    if (action === 'deleted' || action === 'revoked') return `<li><strong>${esc(c.field)}:</strong> <del>${pre(c.from)}</del></li>`;
    return `<li><strong>${esc(c.field)}:</strong> ${c.from ? `<del>${pre(c.from)}</del>` : '<span class="muted">(empty)</span>'} → ${c.to ? `<ins>${pre(c.to)}</ins>` : '<span class="muted">(empty)</span>'}</li>`;
  }).join('')}</ul>` : '<span class="muted small">No field changes</span>');

  shell(ADMIN_TABS, '#/admin/team', `
    <div class="page-head"><div><h1>Team</h1><p class="muted">Team members can add clients, send invites and manage orders, batches and invoices. Separated members only see the clients they added. Only you can manage the team and Settings.</p></div></div>
    <div class="stack">
      <form class="card card-pad" id="team-form">
        <h2 style="margin-bottom:14px">Add a team member</h2>
        <div class="grid-2">
          <div class="field"><label for="t-email">Email</label><input id="t-email" name="email" type="email" required></div>
          <div class="field"><label for="t-name">Name</label><input id="t-name" name="name" placeholder="Shown in the activity log and emails"></div>
        </div>
        <label class="sep-toggle"><span class="switch"><input type="checkbox" name="separated"><span></span></span>
          <span><strong>Separated</strong><span class="muted small">They only see the clients they add themselves, with those clients' batches and invoices. Other clients stay hidden.</span></span></label>
        ${vpnToggle()}
        <div class="row"><button class="btn btn-primary" type="submit">Send team invite</button><span class="muted small">They set their own password from the invite link.</span></div>
        <div class="error"></div>
        <div id="team-link"></div>
      </form>

      <div class="card">
        <div class="card-head"><h2>Members</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th title="Separated members only see the clients they added">Separated</th><th>Account</th><th>Added</th><th></th></tr></thead>
          <tbody>${members.map((m) => `<tr>
            <td>${esc(m.name || '—')}</td><td>${esc(m.email)}</td>
            <td>${m.role === 'admin' ? '<span class="badge b-in_progress">Owner</span>' : 'Team member'}</td>
            <td>${m.role === 'staff' ? `<label class="switch" title="Only sees the clients they added"><input type="checkbox" data-separate="${m.id}" aria-label="Separated: ${esc(m.email)}" ${m.separated ? 'checked' : ''}><span></span></label>` : '<span class="muted small">Sees all</span>'}</td>
            <td>${m.password_set ? '<span class="badge b-active">Joined</span>' : '<span class="badge b-pending">Not joined</span>'}</td>
            <td>${fmtDate(m.created_at)}</td>
            <td>${m.role === 'staff' ? `<div class="row" style="flex-wrap:nowrap;gap:6px">${watchBtn(m.id)}<button class="btn btn-sm btn-danger" data-remove-member="${m.id}" data-email="${esc(m.email)}">Remove</button></div>` : ''}</td>
          </tr>`).join('')}
          ${invites.map((i) => `<tr><td>${esc(i.name || '—')}</td><td>${esc(i.email)}</td><td>Team member</td><td>${i.separated ? '<span class="badge b-pending">Separated</span>' : '<span class="muted small">No</span>'}</td><td><span class="badge b-in_progress">Invited</span></td><td>${fmtDate(i.created_at)}</td>
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
    const r = await api('POST', `${API()}/team`, { ...d, separated: d.separated === 'on', block_vpn: d.block_vpn === 'on' });
    renderTeam(await api('GET', `${API()}/team`));
    document.getElementById('team-link').innerHTML = `<div class="note" style="margin-top:12px"><span class="note-icon">${icon('link')}</span><div style="flex:1;min-width:0">
      <strong>Team invite for ${esc(d.email)}</strong> ${r.emailed ? '(also emailed)' : '(not emailed — share it yourself)'}
      <div class="row" style="margin-top:8px;flex-wrap:nowrap"><input readonly value="${esc(r.link)}"></div></div></div>`;
  });
  document.querySelectorAll('[data-separate]').forEach((c) => {
    c.onchange = async () => {
      try {
        await api('PATCH', `${API()}/team/${c.dataset.separate}`, { separated: c.checked });
        toast(c.checked ? 'Separated: they now only see the clients they added' : 'They can now see all clients');
      } catch (ex) { c.checked = !c.checked; toast(ex.message); }
    };
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
      <div id="cf-card"></div>
      <form class="card card-pad" id="settings">
        <h2 style="margin-bottom:14px">Orders &amp; clients</h2>
        <div class="field"><label for="s-emails">Send new-order notifications to</label>
          <input id="s-emails" name="order_notify_emails" required value="${esc(settings.order_notify_emails)}">
          <div class="hint">One or more emails, separated by commas.</div></div>
        <div class="field"><label for="s-activity">Send team activity (who changed what) to</label>
          <input id="s-activity" name="activity_emails" value="${esc(settings.activity_emails || settings.order_notify_emails)}">
          <div class="hint">You get an email whenever a team member adds, edits or deletes something, with the before and after.</div></div>
        <div class="field"><label for="s-overdue">Send unpaid-invoice alerts to</label>
          <input id="s-overdue" name="overdue_alert_emails" value="${esc(settings.overdue_alert_emails)}">
          <div class="hint">You get an email to cancel the subscription when a renewal is unpaid the day after its renewal date, or a new invoice is unpaid 3 days after it was issued.</div></div>
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
          <thead><tr><th style="min-width:200px">Name</th><th style="min-width:260px">Description (shown to clients when ordering)</th><th class="num" style="width:130px">Price ($)</th><th style="width:130px">Offer to clients</th><th style="width:150px">Client gives domains</th><th style="width:70px"></th></tr></thead>
          <tbody>${pricing.map((p) => `<tr data-type="${esc(p.inbox_type)}">
            <td><input data-f="label" value="${esc(p.label)}" required></td>
            <td><input data-f="description" value="${esc(p.description || '')}" placeholder="Optional"></td>
            <td><input data-f="price_per_mailbox" type="number" step="0.01" min="0" required value="${p.price_per_mailbox}" class="num"></td>
            <td><label class="check"><input type="checkbox" data-f="active" ${p.active !== false ? 'checked' : ''}> ${p.active !== false ? 'Yes' : 'Hidden'}</label></td>
            <td><label class="check" title="Untick for pre-warmed mailboxes on your own domains: clients then aren't asked for domains, usernames, domain access or the CSV"><input type="checkbox" data-f="needs_domains" ${p.needs_domains !== false ? 'checked' : ''}> ${p.needs_domains !== false ? 'Yes' : 'No (pre-warmed)'}</label></td>
            <td><button type="button" class="btn btn-sm btn-ghost" data-del-type="${esc(p.inbox_type)}" title="Delete (only if never used)" aria-label="Delete">${icon('close')}</button></td>
          </tr>`).join('')}
          <tr class="add-type-row">
            <td><input id="nt-label" placeholder="New type, e.g. Zoho Mail"></td>
            <td><input id="nt-desc" placeholder="Optional description"></td>
            <td><input id="nt-price" type="number" step="0.01" min="0" placeholder="0.00" class="num"></td>
            <td colspan="3"><button type="button" class="btn btn-sm" id="add-type">+ Add mailbox type</button></td>
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
  cloudflareCard();
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
      needs_domains: tr.querySelector('[data-f=needs_domains]').checked,
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
  return `<span class="delta ${good ? 'up' : 'down'}">${icon(pct > 0 ? 'up' : 'down')}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%</span>`;
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

// The chosen Analytics period: a preset, or a month / custom dates.
const analyticsPeriod = { preset: 'this_month', month: '', from: '', to: '', seller: '' };
const isoDay = (d) => d.toISOString().slice(0, 10);
// [from, to] for a preset, from the business "today" (YYYY-MM-DD).
function presetRange(preset, today, p = analyticsPeriod) {
  const [y, m] = today.split('-').map(Number);
  const first = (yy, mm) => isoDay(new Date(Date.UTC(yy, mm - 1, 1)));
  const lastDay = (yy, mm) => isoDay(new Date(Date.UTC(yy, mm, 0)));
  switch (preset) {
    case 'last_month': return [first(y, m - 1), lastDay(y, m - 1)];
    case 'last_3': return [first(y, m - 2), today];
    case 'last_6': return [first(y, m - 5), today];
    case 'last_12': return [first(y, m - 11), today];
    case 'this_year': return [`${y}-01-01`, today];
    case 'last_year': return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    case 'month': { const [yy, mm] = (p.month || today.slice(0, 7)).split('-').map(Number); const end = lastDay(yy, mm); return [first(yy, mm), end > today ? today : end]; }
    case 'custom': return [p.from || first(y, m), p.to || today];
    default: return [first(y, m), today];
  }
}
const PRESETS = [['this_month', 'This month'], ['last_month', 'Last month'], ['month', 'Choose a month…'], ['last_3', 'Last 3 months'], ['last_6', 'Last 6 months'],
  ['last_12', 'Last 12 months'], ['this_year', 'This year'], ['last_year', 'Last year'], ['custom', 'Custom dates…']];
const prettyDay = (d, year = true) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
const rangeText = (a, b) => (a === b ? prettyDay(a) : a.slice(0, 4) === b.slice(0, 4) ? `${prettyDay(a, false)} – ${prettyDay(b)}` : `${prettyDay(a)} – ${prettyDay(b)}`);

async function loadAnalytics() {
  const today = (state.admin && state.admin.today) || isoDay(new Date());
  const [from, to] = presetRange(analyticsPeriod.preset, today);
  const seller = analyticsPeriod.seller ? `&seller=${encodeURIComponent(analyticsPeriod.seller)}` : '';
  return api('GET', `${API()}/analytics?from=${from}&to=${to}${seller}`);
}

function renderAnalytics(data) {
  const { period: cur, prev, outstanding, byType, topClients, recentPayments, bySeller = [], series, bucket, from, to, prevFrom, prevTo, today,
    sellers = [], seller = null, sellerSeries = [] } = data;
  const sellerName = (v) => (v ? v : 'Not set');
  const vs = `<span class="muted">vs ${rangeText(prevFrom, prevTo)}</span>`;
  const endVs = `<span class="muted">vs ${prettyDay(prevTo)}</span>`;
  const tile = (label, value, d, sub, cls = '') => `<div class="card kpi ${cls}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-delta">${d}</div>
    <div class="kpi-sub">${sub}</div>
  </div>`;
  const plural = (n, w) => `${count(n)} ${w}${Number(n) === 1 ? '' : 's'}`;
  const kpis = [
    tile('Mailboxes sold', count(cur.mailboxes_sold), `${delta(cur.mailboxes_sold, prev.mailboxes_sold)} ${vs}`,
      `${money(cur.sold_value)}/month in new batches · before: ${count(prev.mailboxes_sold)}`, 'kpi-hero'),
    tile('Payments received', money(cur.payments), `${delta(cur.payments, prev.payments)} ${vs}`,
      `${plural(cur.payment_count, 'payment')} · before: ${money(prev.payments)}`),
    tile('Invoiced', money(cur.invoiced), `${delta(cur.invoiced, prev.invoiced)} ${vs}`, `Before: ${money(prev.invoiced)}`),
    tile('New clients', count(cur.new_clients), `${delta(cur.new_clients, prev.new_clients)} ${vs}`, `Before: ${count(prev.new_clients)}`),
    tile('New batches', count(cur.new_batches), `${delta(cur.new_batches, prev.new_batches)} ${vs}`, `Before: ${count(prev.new_batches)}`),
    tile('Cancelled', plural(cur.cancellations, 'batch').replace('batchs', 'batches'), `${delta(cur.cancellations, prev.cancellations, { upIsGood: false })} ${vs}`,
      `${count(cur.mailboxes_cancelled)} mailboxes · before: ${count(prev.cancellations)}`),
    tile('Active mailboxes', count(cur.mailboxes), `${delta(cur.mailboxes, prev.mailboxes)} ${endVs}`, `On ${prettyDay(to)} · before: ${count(prev.mailboxes)}`),
    tile('Active clients', count(cur.active_clients), `${delta(cur.active_clients, prev.active_clients)} ${endVs}`, `On ${prettyDay(to)} · before: ${count(prev.active_clients)}`),
    tile('Monthly recurring revenue', money(cur.mrr), `${delta(cur.mrr, prev.mrr)} ${endVs}`, `On ${prettyDay(to)} · before: ${money(prev.mrr)}`),
  ].join('');

  const label = (k) => (bucket === 'day' ? prettyDay(k, false) : monthName(k, { month: 'short' }));
  const longLabel = (k) => (bucket === 'day' ? new Date(`${k}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : monthName(k, { month: 'long', year: 'numeric' }));
  const rowLabel = (k) => (bucket === 'day' ? new Date(`${k}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : monthName(k, { month: 'short', year: 'numeric' }));
  const CHARTS = [
    ['mailboxes_sold', 'Mailboxes sold', 'bar', false, (m) => count(m.mailboxes_sold), (m) => `${money(m.sold_value)}/month · ${plural(m.new_batches, 'batch').replace('batchs', 'batches')}`],
    ['payments', 'Payments received', 'bar', true, (m) => money(m.payments), (m) => plural(m.payment_count, 'payment')],
    ['mailboxes', 'Active mailboxes', 'line', false, (m) => count(m.mailboxes), (m) => `${count(m.mailboxes_cancelled)} cancelled`],
    ['mrr', 'Monthly recurring revenue', 'line', true, (m) => money(m.mrr), (m) => `${plural(m.active_clients, 'active client')}`],
    ['new_clients', 'New clients', 'bar', false, (m) => count(m.new_clients), () => ''],
    ['invoiced', 'Invoiced', 'bar', true, (m) => money(m.invoiced), () => ''],
  ];
  const maxSold = Math.max(...byType.map((t) => Number(t.sold)), 0) || 1;
  const p = analyticsPeriod;
  // Team member × day/month: mailboxes sold and payments (shown when not filtered to one person).
  function sellerMatrix() {
    if (seller !== null || !sellerSeries.length) return '';
    const totals = {};
    sellerSeries.forEach((r) => { const t = (totals[r.seller] = totals[r.seller] || { sold: 0, payments: 0 }); t.sold += r.sold; t.payments += Number(r.payments); });
    const cols = Object.keys(totals).filter((k) => totals[k].sold || totals[k].payments).sort((a, b) => totals[b].sold - totals[a].sold || totals[b].payments - totals[a].payments);
    if (!cols.length) return '';
    const cell = (k, c) => sellerSeries.find((r) => r.key === k && r.seller === c) || { sold: 0, payments: 0 };
    const val = (v) => (v.sold || Number(v.payments) ? `<strong>${count(v.sold)}</strong> <span class="muted small">mb</span><div class="muted small">${money(v.payments)}</div>` : '<span class="muted">—</span>');
    const keys = [...new Set(sellerSeries.map((r) => r.key))].reverse();
    return `<div class="card"><div class="card-head"><div><h2>Team members ${bucket === 'day' ? 'day by day' : 'month by month'}</h2><div class="muted small">Mailboxes sold (mb) and payments received, per Sold by. Pick a name in <strong>Sold by</strong> above to see only theirs.</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>${bucket === 'day' ? 'Date' : 'Month'}</th>${cols.map((c) => `<th class="num">${esc(sellerName(c))}</th>`).join('')}</tr></thead><tbody>
        ${keys.filter((k) => cols.some((c) => { const v = cell(k, c); return v.sold || Number(v.payments); })).map((k) => `<tr><td class="nowrap">${esc(rowLabel(k))}</td>${cols.map((c) => `<td class="num">${val(cell(k, c))}</td>`).join('')}</tr>`).join('')}
        <tr class="an-total"><td><strong>Total</strong></td>${cols.map((c) => `<td class="num">${val(totals[c])}</td>`).join('')}</tr>
      </tbody></table></div></div>`;
  }
  const [pf, pt] = presetRange(p.preset, today);

  shell(ADMIN_TABS, '#/admin/analytics', `
    <div class="page-head"><div><h1>Analytics</h1><div class="muted small"><strong>${rangeText(from, to)}</strong> compared with ${rangeText(prevFrom, prevTo)}${seller !== null ? ` · <strong>Sold by ${esc(sellerName(seller))}</strong> only` : ''}</div></div></div>
    <div class="stack">
      <form class="card an-filter" id="an-filter">
        <div class="field"><label for="an-preset">Period</label><select id="an-preset" name="preset">${PRESETS.map(([v, l]) => `<option value="${v}" ${v === p.preset ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="an-seller">Sold by</label><select id="an-seller" name="seller"><option value="">Everyone</option>
          ${sellers.map((v) => `<option value="${esc(v || '__none')}" ${(v || '__none') === p.seller ? 'selected' : ''}>${esc(sellerName(v))}</option>`).join('')}</select></div>
        <div class="field an-month" ${p.preset === 'month' ? '' : 'hidden'}><label for="an-month">Month</label><input id="an-month" name="month" type="month" max="${today.slice(0, 7)}" value="${esc(p.month || today.slice(0, 7))}"></div>
        <div class="field an-custom" ${p.preset === 'custom' ? '' : 'hidden'}><label for="an-from">From</label><input id="an-from" name="from" type="date" max="${today}" value="${esc(p.preset === 'custom' ? pf : from)}"></div>
        <div class="field an-custom" ${p.preset === 'custom' ? '' : 'hidden'}><label for="an-to">To</label><input id="an-to" name="to" type="date" max="${today}" value="${esc(p.preset === 'custom' ? pt : to)}"></div>
        <button class="btn btn-primary an-custom" type="submit" ${p.preset === 'custom' ? '' : 'hidden'}>Apply</button>
        <div class="muted small an-note">${bucket === 'day' ? 'Day by day' : 'Month by month'} below. Totals compare with the period just before; "active" figures are on the last day.</div>
      </form>
      <div class="kpis">${kpis}</div>
      <div class="note note-info"><span><strong>Outstanding now:</strong> ${money(outstanding.unpaid)} across ${plural(outstanding.unpaid_count, 'unpaid invoice')}${outstanding.overdue_count ? `, of which <strong>${money(outstanding.overdue)}</strong> (${count(outstanding.overdue_count)}) is past due` : ''}. <a href="#/admin/invoices">View invoices</a></span></div>
      <div class="charts">${CHARTS.map(([key, title]) => `<div class="card chart-card"><div class="chart-head"><h2>${title}</h2><div class="chart-now" id="now-${key}"></div></div><div class="chart" id="chart-${key}"></div></div>`).join('')}</div>
      <div class="charts">
        <div class="card"><div class="card-head"><div><h2>Mailboxes sold by type</h2><div class="muted small">${rangeText(from, to)} · active on ${prettyDay(to)}</div></div></div>
          ${byType.length ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th class="num">Sold</th><th class="num">Before</th><th class="num">Active</th><th class="num">MRR</th></tr></thead><tbody>
            ${byType.map((t) => `<tr><td><strong>${typeChip(t.inbox_type, t.label)}</strong><div class="hbar-track" style="margin-top:6px"><div class="hbar-fill" style="width:${(Number(t.sold) / maxSold) * 100}%"></div></div></td>
              <td class="num"><strong>${count(t.sold)}</strong><div class="muted small">${money(t.sold_value)}/mo</div></td><td class="num">${count(t.prev_sold)}</td><td class="num">${count(t.active)}</td><td class="num">${money(t.mrr)}</td></tr>`).join('')}
            <tr class="an-total"><td><strong>Total</strong></td><td class="num"><strong>${count(cur.mailboxes_sold)}</strong></td><td class="num">${count(prev.mailboxes_sold)}</td><td class="num">${count(cur.mailboxes)}</td><td class="num">${money(cur.mrr)}</td></tr>
          </tbody></table></div>` : '<div class="card-pad muted">No mailboxes in this period.</div>'}</div>
        <div class="card"><div class="card-head"><div><h2>Top clients by payments</h2><div class="muted small">${rangeText(from, to)} vs before</div></div></div>
          ${topClients.length ? `<div class="table-wrap"><table><thead><tr><th>Client</th><th class="num">This period</th><th class="num">Before</th></tr></thead><tbody>
            ${topClients.map((c) => `<tr><td><strong>${esc(c.company || c.name || c.email)}</strong><div class="muted small">${esc(c.email)}</div></td><td class="num">${money(c.this_period)}</td><td class="num">${money(c.prev_period)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="card-pad muted">No payments in this period.</div>'}</div>
      </div>
      <div class="card"><div class="card-head"><div><h2>Sales by team member</h2><div class="muted small">Mailboxes sold and payments received, by Sold by on the client</div></div></div>
        ${bySeller.length ? `<div class="table-wrap"><table><thead><tr><th>Sold by</th><th class="num">Mailboxes sold</th><th class="num">Before</th><th class="num">Payments</th><th class="num">Before</th></tr></thead><tbody>
          ${bySeller.map((r) => `<tr><td>${r.seller ? `<strong>${esc(r.seller)}</strong>` : '<span class="muted">Not set</span>'}</td>
            <td class="num"><strong>${count(r.sold)}</strong></td><td class="num">${count(r.prev_sold)}</td>
            <td class="num">${money(r.this_period)}<div class="muted small">${plural(r.this_count, 'payment')}</div></td>
            <td class="num">${money(r.prev_period)}<div class="muted small">${plural(r.prev_count, 'payment')}</div></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="card-pad muted">No sales in this period.</div>'}</div>
      ${sellerMatrix()}
      <div class="card"><div class="card-head"><div><h2>${bucket === 'day' ? 'Day by day' : 'Month by month'}</h2><div class="muted small">${rangeText(from, to)}</div></div></div>
        <div class="table-wrap"><table><thead><tr><th>${bucket === 'day' ? 'Date' : 'Month'}</th><th class="num">Mailboxes sold</th><th class="num">New batches</th><th class="num">Payments</th><th class="num">Invoiced</th><th class="num">New clients</th><th class="num">Cancelled</th><th class="num">Active mailboxes</th><th class="num">MRR</th></tr></thead><tbody>
          ${[...series].reverse().map((m) => `<tr${Number(m.mailboxes_sold) || Number(m.payments) ? '' : ' class="an-quiet"'}><td class="nowrap">${esc(rowLabel(m.key))}</td>
            <td class="num"><strong>${count(m.mailboxes_sold)}</strong></td><td class="num">${count(m.new_batches)}</td><td class="num">${money(m.payments)}</td><td class="num">${money(m.invoiced)}</td>
            <td class="num">${count(m.new_clients)}</td><td class="num">${count(m.cancellations)}${Number(m.mailboxes_cancelled) ? `<div class="muted small">${count(m.mailboxes_cancelled)} mb</div>` : ''}</td>
            <td class="num">${count(m.mailboxes)}</td><td class="num">${money(m.mrr)}</td></tr>`).join('')}
          <tr class="an-total"><td><strong>Total</strong></td><td class="num"><strong>${count(cur.mailboxes_sold)}</strong></td><td class="num">${count(cur.new_batches)}</td><td class="num">${money(cur.payments)}</td><td class="num">${money(cur.invoiced)}</td><td class="num">${count(cur.new_clients)}</td><td class="num">${count(cur.cancellations)}</td><td class="num">${count(cur.mailboxes)}</td><td class="num">${money(cur.mrr)}</td></tr>
        </tbody></table></div></div>
      <div class="card"><div class="card-head"><div><h2>Payments in this period</h2><div class="muted small">Latest 15</div></div></div>
        ${recentPayments.length ? `<div class="table-wrap"><table><thead><tr><th>Paid</th><th>Client</th><th>Invoice</th><th class="num">Amount</th></tr></thead><tbody>
          ${recentPayments.map((r) => `<tr><td>${fmtDate(r.paid_at)}</td><td>${esc(r.company || r.email)}</td><td><a href="#/admin/invoice/${r.id}">#${r.id}</a> <span class="muted small">${esc(r.description)}</span></td><td class="num">${money(r.amount)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="card-pad muted">No payments in this period.</div>'}</div>
    </div>`);

  const draw = () => {
    CHARTS.forEach(([key, , kind, isMoney, fmtV, extra]) => {
      const el = document.getElementById(`chart-${key}`);
      if (!el) return;
      document.getElementById(`now-${key}`).innerHTML = `<span class="chart-value">${fmtV(cur)}</span> ${delta(cur[key], prev[key], { upIsGood: true })}`;
      drawChart(el, series.map((m) => ({
        label: label(m.key),
        value: m[key],
        tip: `<div class="tip-title">${esc(longLabel(m.key))}</div><div class="tip-value">${fmtV(m)}</div>${extra(m) ? `<div class="tip-sub">${extra(m)}</div>` : ''}`,
      })), { kind, money: isMoney });
    });
  };
  draw();

  const form = document.getElementById('an-filter');
  const reload = async () => {
    try { renderAnalytics(await loadAnalytics()); } catch (ex) { toast(ex.message); }
  };
  form.preset.onchange = () => {
    p.preset = form.preset.value;
    form.querySelectorAll('.an-month').forEach((x) => { x.hidden = p.preset !== 'month'; });
    form.querySelectorAll('.an-custom').forEach((x) => { x.hidden = p.preset !== 'custom'; });
    if (p.preset === 'custom') { p.from = form.from.value; p.to = form.to.value; return; } // wait for Apply
    if (p.preset === 'month') p.month = form.month.value;
    reload();
  };
  form.month.onchange = () => { if (form.month.value) { p.month = form.month.value; reload(); } };
  form.seller.onchange = () => {
    p.seller = form.seller.value;
    if (p.preset === 'custom') { p.from = form.from.value; p.to = form.to.value; }
    reload();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!form.from.value || !form.to.value) { toast('Choose both dates'); return; }
    p.from = form.from.value; p.to = form.to.value;
    reload();
  };
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
  const loginLink = state.admin.clientLoginUrl || `${location.origin}/${whiteLabel ? `?b=${state.me.id}` : ''}#/login`;
  shell(ADMIN_TABS, '#/admin/clients', `
    <div class="page-head"><div><h1>Clients</h1><p class="muted">Your clients get their invoices and renewal reminders by email${whiteLabel ? ', under your brand' : ''}. Invite them to the client portal to see their mailboxes, domains and invoices${whiteLabel ? ' (with your logo and name)' : ''}.</p></div></div>
    <div class="stack">
      <div class="card card-pad login-link-card">
        <div><h2>Your clients' login link</h2><div class="muted small" style="margin-top:4px">${whiteLabel ? 'Opens the client portal with your logo and name. It\'s also in every invite email.' : 'The client portal login (under the MithMill brand while white-label is off).'}</div></div>
        <div class="row" style="flex-wrap:nowrap;margin-top:10px"><input readonly class="mono" value="${esc(loginLink)}" id="rc-login-link"><button class="btn" type="button" id="rc-copy-link">Copy</button></div>
      </div>
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
          <thead><tr><th>Client</th><th>Portal</th><th class="num">Active mailboxes</th><th class="num">Monthly</th><th>Added</th><th></th></tr></thead>
          <tbody>${clients.map((c) => `<tr data-id="${c.id}" data-search="${searchText(c.company, c.name, c.email)}" data-active="${c.active_mailboxes > 0 ? 'yes' : 'no'}">
            <td>${esc(c.company || c.name || c.email)}<div class="muted small">${c.name && c.company ? `${esc(c.name)} · ` : ''}${esc(c.email)}</div></td>
            <td>${c.password_set ? '<span class="badge b-active">Joined</span>' : c.invited ? '<span class="badge b-in_progress">Invited</span>' : '<span class="badge b-pending">Not invited</span>'}
              <div><button class="btn btn-sm btn-ghost" data-rc-invite="${c.id}" data-email="${esc(c.email)}">${c.password_set ? 'Send reset link' : c.invited ? 'Resend invite' : 'Send invite'}</button></div></td>
            <td class="num">${c.active_mailboxes}</td><td class="num">${money(c.monthly)}</td>
            <td><div class="row client-actions"><button class="btn btn-sm btn-primary" data-batch="${c.id}">+ Add batch</button><button class="btn btn-sm" data-edit="${c.id}">Edit</button><button class="btn btn-sm btn-danger" data-delete-client="${c.id}">Delete</button></div></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No clients yet. Add your first one above.</div>'}
      </div>
    </div>`);

  wireFilterBar('rclients');
  wireClientInvites();
  document.getElementById('rc-copy-link').onclick = async () => {
    try { await navigator.clipboard.writeText(loginLink); toast('Login link copied'); } catch { document.getElementById('rc-login-link').select(); }
  };
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
      <div class="card card-pad agree-status"><div><h2>Reseller Agreement</h2><div class="muted small" style="margin-top:4px">You signed the Mithmill Reseller Agreement & Payment Policy.</div></div>
        <a class="btn btn-sm" href="/api/reseller/agreement.pdf">${icon('download')} Download signed PDF</a></div>
      ${st.white_label ? `<form class="card card-pad" id="rs-form">
        <h2 style="margin-bottom:14px">Your clients' emails</h2>
        <div class="grid-2">
          <div class="field"><label>Sender name</label><input name="sender_name" value="${esc(st.sender_name)}" placeholder="${esc(st.brand_name)}"><div class="hint">Shown as who the email is from.</div></div>
          <div class="field"><label>Reply-to email</label><input name="reply_to" type="email" value="${esc(st.reply_to)}" placeholder="billing@yourcompany.com"><div class="hint">Where your clients' replies (and payment screenshots) go.</div></div>
        </div>
        ${st.sender_email ? `<p class="muted small" style="margin:-4px 0 14px">Emails are sent from <strong>${esc(st.sender_email)}</strong>.</p>` : ''}
        <div class="field"><label>Support email (in the email footer)</label><input name="support_email" type="email" value="${esc(st.support_email)}"></div>
        ${st.use_mixxbee ? `<div class="note note-info" style="margin:0 0 14px"><span>Your clients pay through <strong>Mixxbee LLC</strong> (Mithmill's payment processor). Invoices and emails show your brand with "Payments powered by Mixxbee". Payment links go in each invoice's notes, where they become Pay buttons.</span></div>
          <input type="hidden" name="payment_note" value="${esc(st.payment_note)}">`
        : `<div class="field"><label>Payment details</label><textarea name="payment_note" style="min-height:110px" placeholder="e.g. bank details, or a payment link such as https://buy.stripe.com/...">${esc(st.payment_note)}</textarea>
          <div class="hint">Shown on every invoice and reminder email. Per-invoice payment links go in the invoice's notes, where they become Pay buttons.</div></div>`}
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
            <td>${r.password_set ? '<span class="badge b-active">Joined</span>' : '<span class="badge b-in_progress">Invited</span>'}
              <label class="access-toggle" title="Turn off to block this reseller from the portal for now"><span class="switch switch-sm"><input type="checkbox" data-access="${r.id}" aria-label="Portal access for ${esc(r.email)}" ${r.active ? 'checked' : ''}><span></span></span><span class="small ${r.active ? 'muted' : 'access-off'}">${r.active ? 'Portal access' : 'Access blocked'}</span></label></td>
            <td><label class="switch"><input type="checkbox" data-wl="${r.id}" ${r.white_label ? 'checked' : ''}><span></span></label></td>
            <td class="num">${r.clients}</td><td class="num">${r.mailboxes}</td><td class="num">${money(r.monthly)}</td><td class="num">${money(r.unpaid)}</td>
            <td><div class="row" style="flex-wrap:nowrap;gap:6px"><a class="btn btn-sm" href="#/admin/resellers/${r.id}">Open</a>${watchBtn(r.id)}</div></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No resellers yet.</div>'}
      </div>
    </div>`);
  onSubmit(document.getElementById('rs-invite'), async (d) => {
    const r = await api('POST', '/api/admin/resellers', d);
    toast(`${d.email} invited`);
    location.hash = `#/admin/resellers/${r.id}`;
    setTimeout(() => showResellerLink(r, d.email), 600);
  });
  wireAccessToggles();
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
  box.innerHTML = `<div class="note" style="margin-top:12px"><span class="note-icon">${icon('link')}</span><div style="min-width:0;flex:1">
    <strong>${r.reset ? 'Password reset' : 'Invite'} link for ${esc(email)}</strong> ${r.emailed ? '(also emailed)' : '(not emailed — share it yourself)'}
    <div class="row" style="margin-top:8px;flex-wrap:nowrap"><input readonly value="${esc(r.link)}" id="rs-link-val"><button type="button" class="btn btn-sm" id="rs-copy">Copy</button></div></div></div>`;
  document.getElementById('rs-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(r.link); toast('Link copied'); } catch { document.getElementById('rs-link-val').select(); }
  };
}

function renderResellerDetail({ reseller: r, clients, orders, invoices, today, mailAccount, pay, agreement, agreementVersion }) {
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

      <div class="card card-pad agree-status">
        <div><h2>Reseller Agreement</h2>
          <div class="muted small" style="margin-top:4px">${agreement
            ? `Signed by <strong>${esc(agreement.signer_name)}</strong>${agreement.signer_title ? ` (${esc(agreement.signer_title)})` : ''} on ${fmtDate(agreement.signed_at)} · version ${esc(agreement.version)}${agreement.version !== agreementVersion ? ` · <strong>they'll be asked to sign the new version ${esc(agreementVersion)}</strong>` : ''}`
            : `Not signed yet. They'll be asked to read and sign version ${esc(agreementVersion)} when they next log in, before they can use their dashboard.`}</div></div>
        ${agreement ? `<a class="btn btn-sm" href="/api/admin/resellers/${r.id}/agreement.pdf">${icon('download')} Signed PDF</a>` : `<span class="badge b-pending">Not signed</span>`}
      </div>

      <form class="card card-pad" id="rs-brand">
        <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:14px">
          <div><h2>White-label</h2><div class="muted small" style="margin-top:4px">On: their clients' emails and invoices use the branding below. Off: they go out under MithMill's brand.</div></div>
          <label class="switch switch-lg"><input type="checkbox" name="white_label" ${r.white_label ? 'checked' : ''}><span></span></label>
        </div>
        <div class="row mixxbee-row" style="justify-content:space-between;align-items:flex-start;margin:-4px 0 16px;padding:12px 14px;border:1px solid var(--border);border-radius:10px">
          <div><strong>Use our payment processing (Mixxbee)</strong><div class="muted small" style="margin-top:4px">On: their clients pay through Mixxbee LLC, like Mithmill's clients (this also turns White-label on). Invoices and emails keep their brand and logo, and show "Payments powered by Mixxbee" and "Mixxbee LLC on behalf of ${esc(r.brand_name || 'their brand')}". Their own payment details below aren't used. Payment links go in each invoice's notes, as for your own invoices.</div></div>
          <label class="switch switch-lg"><input type="checkbox" name="use_mixxbee" ${r.use_mixxbee ? 'checked' : ''}><span></span></label>
        </div>
        <div class="field"><label>Their own portal domain <span class="muted small">(optional)</span></label>
          <div class="row" style="flex-wrap:nowrap"><input name="custom_domain" class="mono" value="${esc(r.custom_domain || '')}" placeholder="portal.theirbrand.com">${r.custom_domain ? '<button type="button" class="btn" id="rs-domain-check">Check</button>' : ''}</div>
          <div class="hint">Their clients use this address for the portal, with their brand, instead of client.mithmill.com. Set it up in 2 steps:
            1) at their DNS host, add a <strong>CNAME</strong> record for that name pointing to <span class="mono">${esc(r.portal_host || 'mithmill-client-portal.onrender.com')}</span>;
            2) in Render → mithmill-client-portal → Settings → Custom Domains → <strong>Add</strong> the same domain (Render issues the HTTPS certificate). Then click Check.</div>
          <div id="rs-domain-result"></div></div>
        <div class="grid-2">
          <div class="field"><label>Brand name</label><input name="brand_name" required value="${esc(r.brand_name)}"></div>
          <div class="field"><label>Website</label><input name="website" value="${esc(r.website)}" placeholder="https://"></div>
        </div>
        <div class="field" style="max-width:320px"><label>Monthly order commitment (inboxes)</label><input name="monthly_commitment" type="number" min="0" step="1" value="${r.monthly_commitment ?? ''}" placeholder="e.g. 1000">
          <div class="hint">Shown in their Reseller Agreement (section 5).</div></div>
        <div class="field"><label>Logo</label>
          <div class="row" style="align-items:center">
            <div class="logo-box">${r.has_logo ? `<img src="/brand/${r.id}/logo?v=${r.logo_version}" alt="">` : '<span class="muted small">No logo</span>'}</div>
            <label class="btn btn-sm">Upload logo<input type="file" id="rs-logo" accept="image/png,image/jpeg,image/gif,image/webp" hidden></label>
            ${r.has_logo ? '<button type="button" class="btn btn-sm btn-ghost" id="rs-logo-remove">Remove</button>' : ''}
          </div><div class="hint">PNG or JPG, up to 300 KB. A wide logo on a white or transparent background works best.</div></div>
        <div class="grid-2">
          <div class="field"><label>Sender name</label><input name="sender_name" value="${esc(r.sender_name)}" placeholder="${esc(r.brand_name)}"></div>
          <div class="field"><label>Sending email (From)</label><input name="sender_email" type="email" value="${esc(r.sender_email)}" placeholder="e.g. billing@theirbrand.com"></div>
        </div>
        <div class="hint" style="margin:-8px 0 14px">The address their clients' emails come from. To send from it through MithMill's mail account, add it once in Gmail for ${esc(mailAccount || 'the portal\'s mail account')}: <strong>Settings → Accounts → Send mail as → Add another email address</strong>, and confirm the code sent to it. Until then, Gmail shows your own address instead. Or enter their own mail server below.</div>
        <div class="grid-2">
          <div class="field"><label>Reply-to email</label><input name="reply_to" type="email" value="${esc(r.reply_to)}"><div class="hint">Where their clients' replies go.</div></div>
          <div class="field"><label>Support email (email footer)</label><input name="support_email" type="email" value="${esc(r.support_email)}"></div>
        </div>
        <div class="field"><label>Payment details</label><textarea name="payment_note" style="min-height:90px" placeholder="Their payment method: bank details, or a payment link">${esc(r.payment_note)}</textarea>
          <div class="hint">Replaces the Mixxbee LLC notice on their clients' invoices and emails while white-label is on (not used when "Use our payment processing" is on). The reseller can also edit this, the sender name and the reply-to.</div></div>
        <details class="smtp-box" ${r.smtp_host ? 'open' : ''}><summary><strong>Send from their own email address</strong> <span class="muted small">(optional: their mail server)</span></summary>
          <p class="muted small">Sends through their own mail account instead of MithMill's, so no Gmail "Send mail as" step is needed. For Google Workspace: smtp.gmail.com, port 465, the sending email as the username, and an app password.</p>
          <div class="grid-2">
            <div class="field"><label>SMTP server</label><input name="smtp_host" value="${esc(r.smtp_host)}" placeholder="smtp.gmail.com"></div>
            <div class="field"><label>Port</label><input name="smtp_port" type="number" value="${esc(r.smtp_port)}"></div>
          </div>
          <div class="grid-2">
            <div class="field"><label>Username</label><input name="smtp_user" value="${esc(r.smtp_user)}" autocomplete="off"></div>
            <div class="field"><label>Password ${r.has_smtp_pass ? '<span class="muted small">(saved; leave blank to keep)</span>' : ''}</label><input name="smtp_pass" type="password" autocomplete="new-password"></div>
          </div>
        </details>
        <div class="row" style="justify-content:space-between;margin-top:8px">
          <div class="row"><button class="btn btn-primary" type="submit">Save</button><button type="button" class="btn" id="rs-test">Send me a test email</button></div>
          <label class="check"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> Reseller can log in</label>
        </div>
        <div class="error"></div>
      </form>

      <form class="card" id="rs-prices">
        <div class="card-head"><div><h2>Their prices</h2><div class="muted small">What this reseller pays you per mailbox per month. Their payout on each invoice is the invoice total minus these prices. Leave blank for your standard price.</div></div></div>
        <div class="table-wrap"><table><thead><tr><th>Mailbox type</th><th class="num">Standard price</th><th class="num" style="width:180px">Their price ($)</th></tr></thead><tbody>
          ${pay.prices.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${money(p.standard)}</td>
            <td class="num"><input type="number" step="0.01" min="0" class="num" data-type="${esc(p.inbox_type)}" value="${p.price === null ? '' : p.price}" placeholder="${money(p.standard)}"></td></tr>`).join('')}
        </tbody></table></div>
        <div class="card-pad" style="padding-top:12px"><button class="btn btn-primary" type="submit">Save prices</button> <span class="muted small">Unpaid invoices are recalculated; paid ones keep the price they were paid at.</span><div class="error"></div></div>
      </form>

      <div class="card">
        <div class="card-head"><div><h2>Payouts</h2><div class="muted small">Their payout = invoice total − their cost. Earned counts paid invoices.</div></div></div>
        <div class="card-pad">
          ${payoutTiles(pay.earnings)}
          <form class="row" id="rs-payout" style="margin-top:16px;align-items:flex-end">
            <div class="field" style="margin:0;width:140px"><label>Amount ($)</label><input name="amount" type="number" step="0.01" min="0.01" required value="${pay.earnings.balance > 0 ? pay.earnings.balance : ''}"></div>
            <div class="field" style="margin:0;width:170px"><label>Paid on</label><input name="paid_on" type="date" value="${esc(today)}"></div>
            <div class="field" style="margin:0;flex:1;min-width:180px"><label>Note (optional)</label><input name="note" placeholder="e.g. Wise transfer, October"></div>
            <button class="btn btn-primary" type="submit">Record payout</button>
          </form>
          <div class="error" id="rs-payout-err"></div>
        </div>
        ${pay.payouts.length ? `<div class="table-wrap"><table><thead><tr><th>Paid on</th><th>Note</th><th class="num">Amount</th><th></th></tr></thead><tbody>
          ${pay.payouts.map((p) => `<tr><td>${fmtDate(p.paid_on)}</td><td>${esc(p.note) || '<span class="muted">—</span>'}</td><td class="num">${money(p.amount)}</td>
            <td><button class="btn btn-sm btn-ghost" data-del-payout="${p.id}">Delete</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No payouts recorded yet.</div>'}
      </div>

      <div class="card">
        <div class="card-head"><div><h2>Their clients</h2><div class="muted small">The reseller doesn't see that you can see these.${r.white_label || r.use_mixxbee ? ` Clients' login link: <span class="mono">${esc(location.origin)}/?b=${r.id}#/login</span>` : ''}</div></div><span class="muted small">${clients.length}</span></div>
        ${clients.length ? `<div class="table-wrap"><table><thead><tr><th>Client</th><th>Portal</th><th class="num">Active mailboxes</th><th class="num">Monthly</th><th class="num">Batches</th><th>Added</th></tr></thead><tbody>
          ${clients.map((c) => `<tr><td><strong>${esc(c.company || c.name || c.email)}</strong><div class="muted small">${c.name && c.company ? `${esc(c.name)} · ` : ''}<a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div></td>
            <td>${c.password_set ? '<span class="badge b-active">Joined</span>' : c.invited ? '<span class="badge b-in_progress">Invited</span>' : '<span class="badge b-pending">Not invited</span>'}
              <div><button class="btn btn-sm btn-ghost" data-rc-invite="${c.id}" data-email="${esc(c.email)}">${c.password_set ? 'Send reset link' : c.invited ? 'Resend invite' : 'Send invite'}</button>${watchBtn(c.id)}</div></td>
            <td class="num">${c.active_mailboxes}</td><td class="num">${money(c.monthly)}</td><td class="num">${c.batch_count}</td><td>${fmtDate(c.created_at)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No clients yet.</div>'}
      </div>

      <div class="card">
        <div class="card-head"><h2>Their batches</h2><span class="muted small">${active.length} active</span></div>
        ${orders.length ? `<div class="table-wrap"><table><thead><tr><th>Batch</th><th>Client</th><th class="num">Mailboxes</th><th class="num">Price</th><th>Renews</th><th>Status</th></tr></thead><tbody>
          ${orders.map((o) => `<tr><td>${esc(batchTitle(o))}<div class="muted small">${typeChip(o.inbox_type, o.inbox_label)}${o.domains ? ` · ${esc(o.domains.split('\n').filter(Boolean).length)} domain(s)` : ''}</div></td>
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

  wireClientInvites();
  const dc = document.getElementById('rs-domain-check');
  if (dc) {
    dc.onclick = async () => {
      dc.disabled = true; dc.textContent = 'Checking…';
      const box = document.getElementById('rs-domain-result');
      try {
        const c = await api('POST', `/api/admin/resellers/${r.id}/domain-check`);
        const line = (ok, label, detail) => `<div class="small" style="margin-top:4px"><span class="${ok ? 'ok-ico' : 'bad-ico'}">${icon(ok ? 'check' : 'x')}</span> <strong>${label}</strong> ${esc(detail)}</div>`;
        box.innerHTML = line(c.dns.ok, 'DNS:', c.dns.ok ? `points to ${c.target}` : `${c.domain} should be a CNAME to ${c.target} (found: ${c.dns.found || 'nothing'})`)
          + line(c.https.ok, 'HTTPS:', c.https.ok ? `https://${c.domain} is live with their brand` : c.https.error)
          + (c.dns.ok && c.https.ok ? `<div class="small" style="margin-top:6px">All set. Their clients' links now use <a href="https://${esc(c.domain)}/#/login" target="_blank" rel="noopener">https://${esc(c.domain)}</a>.</div>` : '');
      } catch (ex) { box.textContent = ex.message; }
      dc.disabled = false; dc.textContent = 'Check';
    };
  }
  const f = document.getElementById('rs-brand');
  // Mixxbee processing is white-label paid through us: switching it on switches white-label on too.
  f.use_mixxbee.addEventListener('change', () => { if (f.use_mixxbee.checked) f.white_label.checked = true; });
  f.white_label.addEventListener('change', () => { if (!f.white_label.checked) f.use_mixxbee.checked = false; });
  onSubmit(f, async (d) => {
    await api('PUT', `/api/admin/resellers/${r.id}`, {
      ...d, white_label: f.white_label.checked, use_mixxbee: f.use_mixxbee.checked, active: f.active.checked, smtp_port: Number(d.smtp_port) || 465,
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
  onSubmit(document.getElementById('rs-prices'), async () => {
    const prices = [...document.querySelectorAll('#rs-prices input[data-type]')].map((i) => ({ inbox_type: i.dataset.type, price: i.value }));
    const res = await api('PUT', `/api/admin/resellers/${r.id}/pricing`, { prices });
    toast(`Prices saved${res.recalculated ? ` · ${res.recalculated} unpaid invoice${res.recalculated === 1 ? '' : 's'} recalculated` : ''}`);
    route();
  });
  const pf = document.getElementById('rs-payout');
  pf.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/admin/resellers/${r.id}/payouts`, formData(pf));
      toast('Payout recorded');
      route();
    } catch (ex) { document.getElementById('rs-payout-err').textContent = ex.message; }
  };
  document.querySelectorAll('[data-del-payout]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this payout record?')) return;
      try { await api('DELETE', `/api/admin/resellers/${r.id}/payouts/${b.dataset.delPayout}`); toast('Payout deleted'); route(); } catch (ex) { toast(ex.message); }
    };
  });
  const rm = document.getElementById('rs-logo-remove');
  if (rm) rm.onclick = async () => { await api('PUT', `/api/admin/resellers/${r.id}/logo`, { data_url: null }); toast('Logo removed'); route(); };
}

// Earned / pending / paid out / balance tiles, for both the reseller and the owner.
function payoutTiles(e) {
  const tile = (label, value, sub, strong) => `<div class="pay-tile${strong ? ' strong' : ''}"><div class="kpi-label">${label}</div><div class="kpi-value">${money(value)}</div><div class="kpi-sub">${sub}</div></div>`;
  return `<div class="pay-tiles">
    ${tile('Total payout earned', e.earned, `From paid invoices (${money(e.sales)} sales − ${money(e.cost)} cost)`)}
    ${tile('Pending', e.pending, 'From unpaid invoices, once they\'re paid')}
    ${tile('Paid out', e.paid_out, 'Payouts made so far')}
    ${tile('Balance due', e.balance, e.balance > 0 ? 'Earned but not paid out yet' : 'Nothing owed right now', true)}
  </div>`;
}

// Reseller: what they earn. Payout on an invoice = its total − their cost (their prices).
function resellerPayouts({ earnings, prices, invoices, payouts }) {
  shell(ADMIN_TABS, '#/admin/payouts', `
    <div class="page-head"><div><h1>Payouts</h1><p class="muted">Your payout on each invoice is what you charge your client minus your price from MithMill.</p></div></div>
    <div class="stack">
      <div class="card card-pad">${payoutTiles(earnings)}</div>
      <div class="charts">
        <div class="card"><div class="card-head"><div><h2>Your prices</h2><div class="muted small">Per mailbox per month</div></div></div>
          <div class="table-wrap"><table><thead><tr><th>Mailbox type</th><th class="num">Your price</th></tr></thead><tbody>
            ${prices.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${money(p.price === null ? p.standard : p.price)}</td></tr>`).join('')}
          </tbody></table></div></div>
        <div class="card"><div class="card-head"><h2>Payouts received</h2></div>
          ${payouts.length ? `<div class="table-wrap"><table><thead><tr><th>Paid on</th><th>Note</th><th class="num">Amount</th></tr></thead><tbody>
            ${payouts.map((p) => `<tr><td>${fmtDate(p.paid_on)}</td><td>${esc(p.note) || '<span class="muted">—</span>'}</td><td class="num">${money(p.amount)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No payouts yet.</div>'}</div>
      </div>
      <div class="card"><div class="card-head"><h2>Payout per invoice</h2><span class="muted small">${invoices.length} invoice${invoices.length === 1 ? '' : 's'}</span></div>
        ${invoices.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Client</th><th>Date</th><th>Status</th><th class="num">Invoice total</th><th class="num">Your cost</th><th class="num">Your payout</th></tr></thead><tbody>
          ${invoices.map((i) => {
            const payout = i.amount - (i.reseller_cost || 0);
            return `<tr><td><a href="#/admin/invoice/${i.id}">${i.id}</a></td><td>${esc(i.company || i.name || i.email)}<div class="muted small">${esc(i.description)}</div></td>
              <td>${fmtDate(i.issue_date || i.created_at)}</td><td>${badge(i.status)}</td><td class="num">${money(i.amount)}</td>
              <td class="num">${money(i.reseller_cost || 0)}</td><td class="num"><strong class="${payout < 0 ? 'neg' : ''}">${money(payout)}</strong></td></tr>`;
          }).join('')}
        </tbody></table></div>` : '<div class="empty">No invoices yet.</div>'}
      </div>
    </div>`);
}

// ------------------------------------------------------------------ reseller agreement

// Shown to a reseller until they sign the current Reseller Agreement: the full
// text, their details and rates, their name and a signature (drawn or uploaded).
function renderAgreement(ag) {
  const para = (b) => (b.type === 'h2' ? `<h2>${esc(b.text)}</h2>` : b.type === 'h3' ? `<h3>${esc(b.text)}</h3>`
    : b.type === 'li' ? `<li>${esc(b.text)}</li>` : `<p>${esc(b.text)}</p>`);
  // Group consecutive bullets into lists.
  let body = '';
  let inList = false;
  for (const b of ag.blocks) {
    if (b.type === 'li' && !inList) { body += '<ul>'; inList = true; }
    if (b.type !== 'li' && inList) { body += '</ul>'; inList = false; }
    body += para(b);
  }
  if (inList) body += '</ul>';
  const r = ag.reseller;
  $app.innerHTML = `<div class="agree-page"><div class="card agree-card">
    <div class="agree-head"><img src="logo-full.png" alt="MithMill"><div class="muted small">Version ${esc(ag.version)}</div></div>
    <h1>${esc(ag.title)}</h1>
    <p class="muted">Before using your reseller dashboard, please read the agreement below and sign it. A signed PDF copy will be emailed to you and to Mithmill.</p>
    <div class="agree-details">
      <div><span class="muted small">Business</span><strong>${esc(r.brand || '—')}</strong></div>
      <div><span class="muted small">Email</span><strong>${esc(r.email)}</strong></div>
      <div><span class="muted small">Monthly commitment</span><strong>${r.commitment ? `${Number(r.commitment).toLocaleString('en-US')} inboxes` : 'As agreed with Mithmill'}</strong></div>
      ${ag.prices.length ? `<div class="agree-rates"><span class="muted small">Your wholesale rates (per mailbox / month)</span>${ag.prices.map((p) => `<span>${esc(p.label)}: <strong>${money(p.price)}</strong></span>`).join('')}</div>` : ''}
    </div>
    <div class="agree-text" id="agree-text" tabindex="0">${body}</div>
    <form id="agree-form">
      <div class="grid-2">
        <div class="field"><label for="ag-name">Your full name</label><input id="ag-name" name="signer_name" required value="${esc(r.name || '')}" autocomplete="name"></div>
        <div class="field"><label for="ag-title">Title / role (optional)</label><input id="ag-title" name="signer_title" placeholder="e.g. Founder"></div>
      </div>
      <div class="field"><label>Signature</label>
        <div class="seg sig-tabs" role="group"><button type="button" class="on" data-sig="draw">Draw</button><button type="button" data-sig="upload">Upload image</button></div>
        <div class="sig-draw"><canvas id="sig-pad" width="600" height="180" aria-label="Draw your signature"></canvas>
          <div class="row" style="justify-content:space-between"><span class="muted small">Sign with your mouse or finger.</span><button type="button" class="btn btn-sm btn-ghost" id="sig-clear">Clear</button></div></div>
        <div class="sig-upload" hidden><input type="file" id="sig-file" accept="image/png,image/jpeg"><div class="hint">A photo or scan of your signature, PNG or JPG, up to 1 MB.</div>
          <img id="sig-preview" alt="" hidden></div>
      </div>
      <label class="check" style="margin-bottom:14px"><input type="checkbox" id="ag-agree"> I have read and agree to the ${esc(ag.title)} (version ${esc(ag.version)}).</label>
      <div class="error"></div>
      <div class="row" style="justify-content:space-between"><button type="button" class="btn btn-ghost" id="ag-logout">Log out</button><button class="btn btn-primary" type="submit">Sign and continue</button></div>
    </form>
  </div></div>`;

  // Drawing pad.
  const pad = document.getElementById('sig-pad');
  const ctx = pad.getContext('2d');
  ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827';
  let drawing = false; let drawn = false;
  const pos = (e) => { const b = pad.getBoundingClientRect(); return [(e.clientX - b.left) * (pad.width / b.width), (e.clientY - b.top) * (pad.height / b.height)]; };
  pad.addEventListener('pointerdown', (e) => { drawing = true; pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
  pad.addEventListener('pointermove', (e) => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); drawn = true; });
  ['pointerup', 'pointercancel'].forEach((t) => pad.addEventListener(t, () => { drawing = false; }));
  document.getElementById('sig-clear').onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; };

  let mode = 'draw'; let uploaded = null;
  document.querySelectorAll('[data-sig]').forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.sig;
      document.querySelectorAll('[data-sig]').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelector('.sig-draw').hidden = mode !== 'draw';
      document.querySelector('.sig-upload').hidden = mode !== 'upload';
    };
  });
  document.getElementById('sig-file').onchange = (e) => {
    const file = e.target.files[0];
    uploaded = null;
    if (!file) return;
    if (file.size > 1024 * 1024) { toast('The image must be 1 MB or smaller'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => { uploaded = reader.result; const img = document.getElementById('sig-preview'); img.src = uploaded; img.hidden = false; };
    reader.readAsDataURL(file);
  };
  document.getElementById('ag-logout').onclick = async () => {
    await api('POST', '/api/auth/logout');
    Object.assign(state, { me: null, agreementOk: false });
    go('#/login');
  };
  onSubmit(document.getElementById('agree-form'), async (d) => {
    if (!document.getElementById('ag-agree').checked) throw new Error('Tick the box to confirm you agree');
    let signature = null;
    if (mode === 'draw') {
      if (!drawn) throw new Error('Draw your signature in the box, or upload an image');
      // White background so the signature shows on any PDF viewer.
      const c = document.createElement('canvas'); c.width = pad.width; c.height = pad.height;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(pad, 0, 0);
      signature = c.toDataURL('image/png');
    } else {
      if (!uploaded) throw new Error('Choose an image of your signature');
      signature = uploaded;
    }
    await api('POST', '/api/reseller/agreement', { signer_name: d.signer_name, signer_title: d.signer_title, signature, agree: true });
    state.agreementOk = true;
    toast('Thank you! Your signed agreement has been emailed to you.');
    go('#/admin/orders');
    route();
  });
}

// ------------------------------------------------------------------ locations (owner)

const flag = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : '');
const KIND_LABEL = { invite: 'Accepted invite', login: 'Logged in', reset: 'Reset password', vpn_blocked: 'Blocked: VPN on' };

// Owner's "Portal access" switches (Locations and Clients): off blocks them from the portal until turned back on.
function wireAccessToggles() {
  document.querySelectorAll('input[data-access]').forEach((c) => {
    c.onchange = async () => {
      const who = c.getAttribute('aria-label').replace('Portal access for ', '');
      if (!c.checked && !confirm(`Block ${who} from the portal? They're logged out right away and can't log in until you turn access back on. Emails (invoices, reminders) still go out.`)) { c.checked = true; return; }
      try {
        await api('PATCH', `/api/admin/access/${c.dataset.access}`, { blocked: !c.checked });
        const row = c.closest('tr');
        if (row && row.dataset.access) row.dataset.access = c.checked ? 'on' : 'blocked';
        const label = c.closest('.access-toggle');
        if (label) { const t = label.lastElementChild; t.textContent = c.checked ? 'Portal access' : 'Access blocked'; t.className = `small ${c.checked ? 'muted' : 'access-off'}`; }
        const cl = (state.admin && state.admin.clients || []).find((x) => String(x.id) === c.dataset.access);
        if (cl) cl.access_blocked = !c.checked;
        toast(c.checked ? 'Portal access turned back on' : 'Portal access blocked');
      } catch (ex) { c.checked = !c.checked; toast(ex.message); }
    };
  });
}

// Owner-only "Block VPN" switch for invite forms.
const vpnToggle = () => `<label class="sep-toggle"><span class="switch"><input type="checkbox" name="block_vpn"><span></span></span>
  <span><strong>Block VPN</strong><span class="muted small">They can't accept the invite or log in while a VPN or proxy is on, so you see where they really are (Locations).</span></span></label>`;

// Where each client, reseller and team member accepted their invite and logs
// in from, with the owner's per-person "Block VPN" switch.
function renderLocations({ people }) {
  const byCountry = {};
  people.filter((p) => p.country).forEach((p) => { byCountry[p.country] = (byCountry[p.country] || { n: 0, cc: p.country_code }); byCountry[p.country].n += 1; });
  const countries = Object.entries(byCountry).sort((a, b) => b[1].n - a[1].n);
  const type = (p) => (p.role === 'reseller' ? 'reseller' : p.role === 'staff' ? 'team' : 'client');
  const typeLabel = { client: 'Client', reseller: 'Reseller', team: 'Team member' };
  const typeBadge = { client: 'b-active', reseller: 'b-in_progress', team: 'b-pending' };
  shell(ADMIN_TABS, '#/admin/locations', `
    <div class="page-head"><div><h1>Client / reseller locations</h1><p class="muted">Approximate city and country from where each client, reseller and team member accepted their invite and logs in. Turn on <strong>Block VPN</strong> for anyone who must connect without a VPN, so their real location shows. Only you can see this page.</p></div></div>
    <div class="stack">
      ${countries.length ? `<div class="card card-pad"><div class="country-chips">${countries.map(([c, v]) => `<span class="chip">${flag(v.cc)} ${esc(c)} <strong>${v.n}</strong></span>`).join('')}</div></div>` : ''}
      <div class="card">
        ${people.length ? filterBar('locations', [
          { name: 'type', label: 'Type: all', options: [['client', 'Clients'], ['reseller', 'Resellers'], ['team', 'Team members']] },
          { name: 'access', label: 'Access: any', options: [['on', 'Access on'], ['blocked', 'Access blocked']] },
          { name: 'vpn', label: 'Block VPN: any', options: [['on', 'Block VPN on'], ['off', 'Block VPN off']] },
          { name: 'country', label: 'Country: any', options: [...countries.map(([c]) => [c, c]), ['__none', 'Unknown']] },
        ]) : ''}
        ${people.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Profile</th><th>Type</th><th title="Turn off to block them from the portal for now">Portal access</th><th title="Can't accept the invite, log in or use the portal over a VPN or proxy">Block VPN</th><th>City</th><th>Country</th><th>Last IP</th><th>Joined</th><th>Last login</th><th class="num">Logins</th><th></th></tr></thead>
          <tbody>${people.map((p) => `<tr data-id="${p.id}" data-search="${searchText(p.name, p.company, p.email, p.city, p.country, p.reseller_name)}"
              data-type="${type(p)}" data-access="${p.access_blocked ? 'blocked' : 'on'}" data-vpn="${p.block_vpn ? 'on' : 'off'}" data-country="${esc(p.country || '__none')}">
            <td>${p.role === 'staff' ? `<strong>${esc(p.name || p.email)}</strong><div class="muted small">${esc(p.email)}</div>`
              : `<strong>${esc(p.company || p.name || p.email)}</strong><div class="muted small">${p.company && p.name ? `${esc(p.name)} · ` : ''}${esc(p.email)}</div>`}
              ${p.reseller_name ? `<div class="muted small">via reseller ${esc(p.reseller_name)}</div>` : ''}</td>
            <td><span class="badge ${typeBadge[type(p)]}">${typeLabel[type(p)]}</span>${p.password_set ? '' : '<div class="muted small">Not joined yet</div>'}</td>
            <td><label class="switch" title="Portal access"><input type="checkbox" data-access="${p.id}" aria-label="Portal access for ${esc(p.email)}" ${p.access_blocked ? '' : 'checked'}><span></span></label>
              ${p.access_blocked ? '<div class="access-off small">Blocked</div>' : ''}</td>
            <td><label class="switch" title="Block VPN"><input type="checkbox" data-block-vpn="${p.id}" aria-label="Block VPN for ${esc(p.email)}" ${p.block_vpn ? 'checked' : ''}><span></span></label>
              ${p.vpn_blocked ? `<div class="vpn-hits small">${p.vpn_blocked} blocked</div>` : ''}</td>
            <td>${esc(p.city) || '<span class="muted">—</span>'}${p.region && p.region !== p.city ? `<div class="muted small">${esc(p.region)}</div>` : ''}</td>
            <td>${p.country ? `${flag(p.country_code)} ${esc(p.country)}` : '<span class="muted">Unknown</span>'}${p.countries > 1 ? `<div class="muted small">${p.countries} countries seen</div>` : ''}</td>
            <td class="small">${esc(p.last_ip || '—')}</td>
            <td>${p.joined_at ? fmtDate(p.joined_at) : '<span class="muted">—</span>'}</td>
            <td>${p.last_seen ? fmtWhen(p.last_seen) : '<span class="muted">Not since tracking began</span>'}</td>
            <td class="num">${p.logins}</td>
            <td><div class="row" style="flex-wrap:nowrap;gap:6px"><button class="btn btn-sm" data-history="${p.id}">History</button>${watchBtn(p.id)}</div></td>
          </tr>
          <tr data-for="${p.id}" class="loc-history" hidden><td colspan="11"><div class="muted small">Loading…</div></td></tr>`).join('')}</tbody></table></div>`
          : '<div class="empty">No clients, resellers or team members yet.</div>'}
      </div>
      <p class="muted small">Locations are looked up from IP addresses, so they're approximate: VPNs, mobile networks and company proxies can show a nearby city or another country. Recording started when this page was added; earlier logins aren't included.</p>
    </div>`);
  wireFilterBar('locations');
  wireAccessToggles();
  document.querySelectorAll('[data-block-vpn]').forEach((c) => {
    c.onchange = async () => {
      try {
        await api('PATCH', `/api/admin/locations/${c.dataset.blockVpn}`, { block_vpn: c.checked });
        c.closest('tr').dataset.vpn = c.checked ? 'on' : 'off';
        toast(c.checked ? 'Block VPN on: they must turn off their VPN to connect' : 'Block VPN off');
      } catch (ex) { c.checked = !c.checked; toast(ex.message); }
    };
  });
  document.querySelectorAll('[data-history]').forEach((b) => {
    b.onclick = async () => {
      const row = document.querySelector(`tr[data-for="${b.dataset.history}"]`);
      row.hidden = !row.hidden;
      if (row.hidden || row.dataset.loaded) return;
      try {
        const { events } = await api('GET', `/api/admin/locations/${b.dataset.history}`);
        row.dataset.loaded = '1';
        row.firstElementChild.innerHTML = events.length ? `<table class="sub-table"><thead><tr><th>When</th><th>What</th><th>Location</th><th>IP</th><th>Device</th></tr></thead><tbody>
          ${events.map((e) => `<tr${e.kind === 'vpn_blocked' ? ' class="vpn-row"' : ''}><td>${fmtWhen(e.created_at)}</td><td>${KIND_LABEL[e.kind] || esc(e.kind)}${e.vpn === false ? ' <span class="muted small">· no VPN</span>' : ''}</td>
            <td>${e.country ? `${flag(e.country_code)} ${esc([e.city, e.region, e.country].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', '))}` : '<span class="muted">Unknown</span>'}</td>
            <td class="small">${esc(e.ip)}</td><td class="small muted">${esc(deviceOf(e.user_agent))}</td></tr>`).join('')}</tbody></table>`
          : '<div class="muted small">No activity recorded yet.</div>';
      } catch (ex) { row.firstElementChild.textContent = ex.message; }
    };
  });
}

// "Chrome on Windows" from a user-agent string.
function deviceOf(ua) {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : '';
  const os = /Windows/.test(s) ? 'Windows' : /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ') || '—';
}

// ------------------------------------------------------------------ mailboxes

// Mailbox logins with the password hidden until Show. pwUrl(id) fetches one
// password; admin adds the batch column and Delete / admin switch.
const CONN_LABEL = { queued: 'Queued', running: 'Connecting…', connected: 'Connected', failed: 'Failed' };
const CONN_ICON = { queued: 'clock', running: 'refresh', connected: 'check', failed: 'x' };
const connChips = (m) => (m.connections || []).map((c) => `<span class="conn-chip conn-${c.status}" title="${esc(c.error || '')}"><img class="conn-logo" src="/brand-logo/${encodeURIComponent(c.provider || 'other')}" alt=""><span>${esc(c.label)}</span><span class="conn-st">${icon(CONN_ICON[c.status] || 'clock')}${c.status !== 'connected' ? (CONN_LABEL[c.status] || c.status) : ''}</span></span>${c.status === 'failed' && c.error ? `<div class="small access-off conn-err">${esc(c.error)}</div>` : ''}`).join('');

function mailboxTable(rows, { pwUrl, admin = false, types = [], select = false, conns = false }) {
  if (!rows.length) return '';
  const typeCell = (m) => (admin
    ? `<select class="dom-type" data-mb-type="${m.id}" aria-label="Mailbox type for ${esc(m.email)}"><option value="">Not set</option>${types.map((t) => `<option value="${esc(t.inbox_type)}" ${t.inbox_type === m.inbox_type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`
    : typeChip(m.inbox_type, m.inbox_label));
  return `<div class="table-wrap"><table class="mb-table">
    <thead><tr>${select ? '<th style="width:28px"><input type="checkbox" id="mb-all" aria-label="Select all"></th>' : ''}<th>Email</th><th>Password</th><th>Mailbox type</th><th>Created</th>${conns ? '<th>Sequencers</th>' : ''}${admin ? '<th>Batch</th><th>Admin</th><th></th>' : ''}</tr></thead>
    <tbody>${rows.map((m) => `<tr data-mb="${m.id}" data-search="${searchText(m.email, m.batch_name)}">
      ${select ? `<td><input type="checkbox" class="mb-sel" value="${m.id}" aria-label="Select ${esc(m.email)}"></td>` : ''}
      <td><div class="mb-email">${mailboxAvatar(m.email, m.inbox_type, m.inbox_label)}<span class="mono">${esc(m.email)}</span>
        <button class="icon-btn" data-copy-text="${esc(m.email)}" title="Copy email" aria-label="Copy ${esc(m.email)}">${icon('copy')}</button>
        ${m.is_admin ? '<span class="badge b-in_progress">Admin</span>' : ''}</div></td>
      <td><div class="mb-pw"><span class="mono mb-pw-val">••••••••••</span>
        <button class="btn btn-sm" data-show-pw="${m.id}">Show password</button>
        <button class="icon-btn" data-copy-pw="${m.id}" title="Copy password" aria-label="Copy password for ${esc(m.email)}">${icon('copy')}</button></div></td>
      <td class="mb-type">${typeCell(m)}</td>
      <td class="small mb-created">${m.created_on ? fmtDate(String(m.created_on).slice(0, 10)) : '<span class="muted">—</span>'}</td>
      ${conns ? `<td class="mb-conns">${connChips(m) || '<span class="muted small">—</span>'}</td>` : ''}
      ${admin ? `<td class="small">${m.order_id ? esc(m.batch_name || `#${m.order_id}`) : '<span class="muted">—</span>'}</td>
        <td><label class="switch switch-sm" title="Admin mailbox"><input type="checkbox" data-mb-admin="${m.id}" aria-label="Admin: ${esc(m.email)}" ${m.is_admin ? 'checked' : ''}><span></span></label></td>
        <td><button class="btn btn-sm btn-ghost" data-mb-del="${m.id}" data-email="${esc(m.email)}">Delete</button></td>` : ''}
    </tr>`).join('')}</tbody></table></div>`;
}

function wireMailboxTable(pwUrl) {
  const cache = {};
  const getPw = async (id) => (cache[id] = cache[id] || (await api('GET', pwUrl(id))).password);
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { toast(`Couldn't copy. Select it and copy it yourself.`); }
  };
  document.querySelectorAll('[data-show-pw]').forEach((b) => {
    b.onclick = async () => {
      const val = b.parentElement.querySelector('.mb-pw-val');
      if (b.dataset.shown) { val.textContent = '••••••••••'; b.textContent = 'Show password'; delete b.dataset.shown; return; }
      try { val.textContent = await getPw(b.dataset.showPw); b.textContent = 'Hide'; b.dataset.shown = '1'; } catch (ex) { toast(ex.message); }
    };
  });
  document.querySelectorAll('[data-copy-pw]').forEach((b) => {
    b.onclick = async () => { try { await copy(await getPw(b.dataset.copyPw), 'Password'); } catch (ex) { toast(ex.message); } };
  });
  document.querySelectorAll('[data-copy-text]').forEach((b) => { b.onclick = () => copy(b.dataset.copyText, 'Email'); });
  const search = document.getElementById('mb-search');
  if (search) {
    search.oninput = () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      document.querySelectorAll('tr[data-mb]').forEach((tr) => { tr.hidden = !words.every((w) => tr.dataset.search.includes(w)); });
    };
  }
}

// ---- Domain hosts and sequencers: logos, a tile picker and account cards.
const provLogo = (key, cls = '') => `<span class="prov-logo ${cls}"><img src="/brand-logo/${encodeURIComponent(key)}" alt="" loading="lazy" decoding="async"></span>`;
// "Smartlead (beta)" -> { name: 'Smartlead', tag: 'beta' }
const provName = (p) => { const m = String(p.name || p.key || '').match(/^(.*?)\s*\(([^)]+)\)$/); return m ? { name: m[1], tag: m[2] } : { name: p.name || p.key, tag: '' }; };
function providerPicker(providers, id) {
  return `<input type="hidden" name="provider" id="${id}">
    <div class="prov-grid" data-picker="${id}">${providers.map((p, i) => {
      const { name, tag } = provName(p);
      return `<button type="button" class="prov-tile" data-prov="${esc(p.key)}" style="--i:${i}" aria-pressed="false">
        ${provLogo(p.key)}<span class="prov-name">${esc(name)}</span>${tag ? `<span class="prov-tag">${esc(tag)}</span>` : ''}
        <span class="prov-check" aria-hidden="true">${icon('check')}</span></button>`;
    }).join('')}</div>`;
}
// Clicking a tile picks it and fills the form's fields; the rest of the form
// stays folded away until then.
function wirePicker(id, onPick) {
  const input = document.getElementById(id);
  const grid = document.querySelector(`[data-picker="${id}"]`);
  if (!input || !grid) return;
  const form = input.form;
  grid.querySelectorAll('.prov-tile').forEach((t) => {
    t.onclick = () => {
      grid.querySelectorAll('.prov-tile').forEach((x) => { x.classList.toggle('sel', x === t); x.setAttribute('aria-pressed', String(x === t)); });
      input.value = t.dataset.prov;
      form.classList.add('picked');
      onPick(t.dataset.prov);
      const first = form.querySelector('.prov-body input:not([type=hidden])');
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 250);
    };
  });
}
// One connected account: logo, name, details, stats, actions.
const acctCard = ({ key, title, meta, stats = '', actions = '', error = '' }) => `<div class="acct">
  ${provLogo(key, 'prov-logo-lg')}
  <div class="acct-main"><div class="acct-title">${title}<span class="acct-live" title="Connected"></span></div><div class="acct-meta">${meta}</div>${error}</div>
  ${stats ? `<div class="acct-stats">${stats}</div>` : ''}
  <div class="acct-actions">${actions}</div></div>`;

// Client: their mailbox logins, and their sequencers (Instantly, …) to
// connect the mailboxes to in the background with one click.
let mbRefresh = null;
function renderMyMailboxes(rows, seqData = {}) {
  const { sequencers: seqs = [], providers = [] } = seqData;
  const admins = rows.filter((m) => m.is_admin).length;
  const prov = (k) => providers.find((p) => p.key === k) || {};
  const pending = seqs.some((s) => s.pending);
  shell(CLIENT_TABS, '#/mailboxes', `
    <div class="page-head"><div><h1>Mailboxes</h1><p class="muted">Your mailbox logins. Keep these passwords private.</p></div>
      ${rows.length ? `<div class="row"><a class="btn" href="/api/mailboxes.csv">${icon('download')} Download CSV</a></div>` : ''}</div>
    <div class="stack">
      <div class="card">
        <div class="card-head"><div class="head-ico"><span class="head-badge">${icon('send')}</span><div><h2>Sequencers</h2><div class="muted small">Connect your sequencer once, then add your mailboxes to it with one click. We sign each mailbox in to Google / Microsoft for you in the background.</div></div></div></div>
        ${seqs.length ? `<div class="acct-list">${seqs.map((s) => acctCard({
          key: s.provider,
          title: esc(s.label),
          meta: `${esc(provName(prov(s.provider)).name || s.provider)}${s.hint ? ` · key <span class="mono">${esc(s.hint)}</span>` : ''}`,
          stats: prov(s.provider).csvOnly ? '<span class="pill">Import with the CSV</span>' : `<span class="pill pill-ok"><strong>${s.connected}</strong> connected</span>${s.pending ? `<span class="pill pill-run"><span class="spin"></span>${s.pending} in progress</span>` : ''}${s.failed ? `<span class="pill pill-bad">${s.failed} failed</span>` : ''}`,
          actions: `${prov(s.provider).csvOnly ? `<a class="btn btn-sm btn-primary" href="/api/sequencers/${s.id}/export.csv">${icon('download')} CSV for ${esc(s.label)}</a>` : `
              <button class="btn btn-sm btn-primary" data-seq-all="${s.id}" ${rows.length ? '' : 'disabled'}>Connect all mailboxes</button>
              <button class="btn btn-sm" data-seq-sel="${s.id}" ${rows.length ? '' : 'disabled'}>Connect selected</button>
              ${s.failed ? `<button class="btn btn-sm" data-seq-retry="${s.id}">Retry failed</button>` : ''}`}
            <button class="btn btn-sm btn-ghost" data-seq-del="${s.id}" data-name="${esc(s.label)}">Remove</button>`,
        })).join('')}</div>` : ''}
        <form class="card-pad prov-form" id="seq-form">
          <div class="prov-head"><h3>${seqs.length ? 'Add another sequencer' : 'Connect your sequencer'}</h3><span class="muted small">Pick one. You'll paste its API key next.</span></div>
          ${providerPicker(providers, 'seq-provider')}
          <div class="prov-body">
            <div id="seq-fields"></div>
            <div class="row"><button class="btn btn-primary" type="submit">Test &amp; connect</button><span class="muted small secure-note">${icon('lock')} Keys are checked first, then stored encrypted.</span></div>
            <div class="error"></div>
          </div>
        </form>
      </div>
      ${rows.length ? `<div class="card">
        <div class="card-head"><div><h2>${rows.length} mailbox${rows.length === 1 ? '' : 'es'}</h2>${admins ? `<div class="muted small">${admins === 1 ? 'The admin mailbox is' : 'Admin mailboxes are'} marked <strong>Admin</strong>.${seqs.length ? ' Tick mailboxes to connect only those.' : ''}</div>` : ''}</div>
          ${rows.length > 8 ? '<input id="mb-search" class="mb-search" type="search" placeholder="Search email…">' : ''}</div>
        ${mailboxTable(rows, { pwUrl: (id) => `/api/mailboxes/${id}/password`, select: seqs.length > 0, conns: seqs.length > 0 })}
      </div>` : '<div class="card"><div class="empty">Your mailboxes will appear here once they\'re set up. We\'ll let you know when they\'re ready.</div></div>'}
    </div>`);
  wireMailboxTable((id) => `/api/mailboxes/${id}/password`);
  const reload = async () => {
    if (!location.hash.startsWith('#/mailboxes')) return;
    const [{ mailboxes: r }, sq] = await Promise.all([api('GET', '/api/mailboxes'), api('GET', '/api/sequencers')]);
    renderMyMailboxes(r, sq);
  };
  // While connections are running, refresh every 8 seconds.
  clearTimeout(mbRefresh);
  if (pending) mbRefresh = setTimeout(() => { reload().catch(() => {}); }, 8000);

  const all = document.getElementById('mb-all');
  if (all) all.onchange = () => document.querySelectorAll('.mb-sel').forEach((c) => { if (!c.closest('tr').hidden) c.checked = all.checked; });
  wirePicker('seq-provider', (key) => {
    const p = prov(key);
    document.getElementById('seq-fields').innerHTML = !p.key ? '' : `
      <p class="muted small" style="margin:0 0 10px">${esc(p.help)}</p>
      <div class="grid-2">${p.fields.map((f) => `<div class="field"><label for="sf-${f.key}">${esc(f.label)}</label>
        <input id="sf-${f.key}" name="cred_${f.key}" ${f.secret ? 'type="password"' : ''} autocomplete="off" required></div>`).join('')}
        <div class="field"><label for="sf-label">Name it <span class="muted small">(optional)</span></label><input id="sf-label" name="label" placeholder="e.g. ${esc(provName(p).name)} main workspace"></div></div>`;
  });
  onSubmit(document.getElementById('seq-form'), async (d) => {
    const creds = Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('cred_')).map(([k, v]) => [k.slice(5), v]));
    await api('POST', '/api/sequencers', { provider: d.provider, label: d.label, creds });
    toast('Sequencer connected');
    await reload();
  });
  const start = async (id, body, b) => {
    b.disabled = true;
    try {
      const r = await api('POST', `/api/sequencers/${id}/connect`, body);
      toast(r.queued ? `Connecting ${r.queued} mailbox${r.queued === 1 ? '' : 'es'} in the background (about a minute each). You can leave this page.` : 'Those mailboxes are already connected or in progress');
    } catch (ex) { toast(ex.message); }
    await reload();
  };
  document.querySelectorAll('[data-seq-all]').forEach((b) => { b.onclick = () => start(b.dataset.seqAll, {}, b); });
  document.querySelectorAll('[data-seq-retry]').forEach((b) => { b.onclick = () => start(b.dataset.seqRetry, { mailbox_ids: rows.filter((m) => (m.connections || []).some((c) => String(c.sequencer_id) === b.dataset.seqRetry && c.status === 'failed')).map((m) => m.id), retry: true }, b); });
  document.querySelectorAll('[data-seq-sel]').forEach((b) => {
    b.onclick = () => {
      const ids = [...document.querySelectorAll('.mb-sel:checked')].map((c) => Number(c.value));
      if (!ids.length) { toast('Tick the mailboxes to connect first'); return; }
      start(b.dataset.seqSel, { mailbox_ids: ids, retry: true }, b);
    };
  });
  document.querySelectorAll('[data-seq-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Remove ${b.dataset.name}? Its keys are deleted here (mailboxes already added stay in the sequencer).`)) return;
      try { await api('DELETE', `/api/sequencers/${b.dataset.seqDel}`); await reload(); } catch (ex) { toast(ex.message); }
    };
  });
}

// Admin: clients and how many mailbox logins each has.
function adminMailboxes() {
  const clients = state.admin.clients;
  shell(ADMIN_TABS, '#/admin/mailboxes', `
    <div class="page-head"><div><h1>Mailboxes</h1><p class="muted">Upload each client's mailbox logins as a CSV. Clients see them on their Mailboxes page, with the password hidden until they click Show.</p></div>
      <div class="row"><a class="btn" href="/api/mailboxes-template.csv">${icon('download')} Sample CSV</a></div></div>
    <div class="stack">
    ${uploadGuide('mailboxes', !clients.some((c) => c.mailbox_count))}
    <div class="card">
      ${clients.length ? `${filterBar('mbclients', [
          { name: 'seller', label: 'Sold by: anyone', options: sellerOptions(clients) },
          { name: 'logins', label: 'Logins: any', options: [['missing', 'Missing logins'], ['uploaded', 'Uploaded'], ['none', 'None yet']] },
        ])}
      <div class="table-wrap"><table>
        <thead><tr><th>Client</th><th class="num">Mailboxes bought</th><th class="num">Logins uploaded</th><th></th></tr></thead>
        <tbody>${clients.map((c) => `<tr data-id="${c.id}" data-search="${searchText(c.name, c.company, c.email, c.seller)}" data-seller="${esc(c.seller || '__none')}" data-logins="${!c.mailbox_count ? 'none' : c.active_mailboxes && c.mailbox_count < c.active_mailboxes ? 'missing uploaded' : 'uploaded'}">
          <td>${clientCell(c)}</td>
          <td class="num">${c.active_mailboxes || '<span class="muted">0</span>'}</td>
          <td class="num">${c.mailbox_count ? `<strong>${c.mailbox_count}</strong>` : '<span class="muted">0</span>'}${c.active_mailboxes && c.mailbox_count < c.active_mailboxes ? '<div class="small access-off">Missing logins</div>' : ''}</td>
          <td><a class="btn btn-sm ${c.mailbox_count ? '' : 'btn-primary'}" href="#/admin/mailboxes/${c.id}">${c.mailbox_count ? 'Manage' : 'Upload logins'}</a></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No clients yet.</div>'}
    </div>
    </div>`);
  wireFilterBar('mbclients');
}

// Admin: one client's mailbox logins, with the CSV upload.
function adminMailboxClient({ client, mailboxes: rows, batches, types }) {
  const who = client.company || client.name || client.email;
  const pwUrl = (id) => `${API()}/mailboxes/${id}/password`;
  shell(ADMIN_TABS, '#/admin/mailboxes', `
    <div class="page-head"><div><p class="muted small" style="margin:0 0 4px"><a href="#/admin/mailboxes">← Mailboxes</a></p><h1>${esc(who)}</h1><p class="muted">${esc(client.email)} · ${rows.length} mailbox login${rows.length === 1 ? '' : 's'}</p></div>
      <div class="row">${rows.length ? `<a class="btn" href="${API()}/clients/${client.id}/mailboxes.csv">${icon('download')} Download CSV</a>` : ''}${watchBtn(client.id)}</div></div>
    <div class="stack">
      <form class="card card-pad" id="mb-upload">
        <h2 style="margin-bottom:4px">Upload mailbox logins</h2>
        <p class="muted small" style="margin:0 0 14px">CSV columns: <span class="mono">email</span>, <span class="mono">password</span>, <span class="mono">admin</span> (<strong>yes</strong> for the admin mailbox), <span class="mono">type</span> (mailbox type, e.g. Google Workspace) and <span class="mono">created</span> (creation date, e.g. 2026-11-01). The mailboxes' domains are added to <a href="#/admin/domains/${client.id}">Domains</a> with their type, and DNS is checked. <a href="/api/mailboxes-template.csv">Download the sample</a>.</p>
        <div class="grid-2">
          <div class="field"><label for="mb-file">CSV file</label><input id="mb-file" type="file" accept=".csv,text/csv" required></div>
          <div class="field"><label for="mb-type">Mailbox type</label><select id="mb-type" name="inbox_type"><option value="csv">From the CSV's type column (or the batch's)</option>${types.map((t) => `<option value="${esc(t.inbox_type)}">${esc(t.label)} (rows without a type)</option>`).join('')}</select></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="mb-batch">Batch (optional)</label><select id="mb-batch" name="order_id"><option value="">Not linked to a batch</option>
            ${batches.map((o) => `<option value="${o.id}">${esc(o.batch_name || `Batch #${o.id}`)} · ${o.quantity} × ${esc(o.label)}${o.status === 'cancelled' ? ' (cancelled)' : ''}</option>`).join('')}</select></div>
        </div>
        <label class="check"><input type="checkbox" name="notify" checked> Email ${esc(who)} that their mailboxes are ready${client.password_set ? '' : ' <span class="muted small">(they haven\'t joined yet, so it waits in their notifications)</span>'}</label>
        <label class="check"><input type="checkbox" name="replace"> Replace: remove this client's logins that aren't in the file${batches.length ? ' (only the chosen batch\'s, if one is chosen)' : ''}</label>
        <div class="row" style="margin-top:12px"><button class="btn btn-primary" type="submit">Upload</button><a class="btn" href="/api/mailboxes-template.csv">${icon('download')} Sample CSV</a><span class="muted small">Logins already here with the same email are updated.</span></div>
        <div class="error"></div>
      </form>
      ${uploadGuide('mailboxes', !rows.length)}
      <div class="card">
        <div class="card-head"><h2>Mailbox logins</h2>${rows.length ? `<div class="row">${rows.length > 8 ? '<input id="mb-search" class="mb-search" type="search" placeholder="Search email…">' : ''}<button class="btn btn-sm btn-danger" id="mb-del-all">Delete all</button></div>` : ''}</div>
        ${rows.length ? mailboxTable(rows, { pwUrl, admin: true, types, conns: rows.some((m) => (m.connections || []).length) }) : '<div class="empty">No logins uploaded yet.</div>'}
      </div>
      ${isOwner() ? '<div id="conn-log"></div>' : ''}
    </div>`);
  wireMailboxTable(pwUrl);
  connectionLog(client.id);
  onSubmit(document.getElementById('mb-upload'), async (d) => {
    const file = document.getElementById('mb-file').files[0];
    if (!file) throw new Error('Choose the CSV file');
    if (file.size > 2 * 1024 * 1024) throw new Error('The file is too big (2 MB max)');
    const r = await api('POST', `${API()}/clients/${client.id}/mailboxes`, {
      csv: await file.text(), order_id: d.order_id || null, inbox_type: d.inbox_type, notify: d.notify === 'on', replace: d.replace === 'on',
    });
    const dom = r.domains && r.domains.total ? ` ${r.domains.total} domain${r.domains.total === 1 ? '' : 's'} on Domains${r.domains.added ? ` (${r.domains.added} new)` : ''}, DNS checked.` : '';
    toast(`Uploaded: ${r.added} new, ${r.updated} updated${r.removed ? `, ${r.removed} removed` : ''}.${dom}${r.notified ? ' Client emailed.' : ''}`);
    route();
  });
  document.querySelectorAll('[data-mb-type]').forEach((s) => {
    s.onchange = async () => {
      try { await api('PATCH', `${API()}/mailboxes/${s.dataset.mbType}`, { inbox_type: s.value || null }); toast('Mailbox type saved'); } catch (ex) { toast(ex.message); route(); }
    };
  });
  document.querySelectorAll('[data-mb-admin]').forEach((c) => {
    c.onchange = async () => {
      try { await api('PATCH', `${API()}/mailboxes/${c.dataset.mbAdmin}`, { is_admin: c.checked }); route(); } catch (ex) { c.checked = !c.checked; toast(ex.message); }
    };
  });
  document.querySelectorAll('[data-mb-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Delete the login for ${b.dataset.email}? The client won't see it any more.`)) return;
      try { await api('DELETE', `${API()}/mailboxes/${b.dataset.mbDel}`); route(); } catch (ex) { toast(ex.message); }
    };
  });
  const all = document.getElementById('mb-del-all');
  if (all) {
    all.onclick = async () => {
      if (!confirm(`Delete all ${rows.length} mailbox logins for ${who}? The client won't see them any more.`)) return;
      try { await api('DELETE', `${API()}/clients/${client.id}/mailboxes`); toast('All logins deleted'); route(); } catch (ex) { toast(ex.message); }
    };
  }
}

// ------------------------------------------------------------------ domains

const PROVIDER_NAME = { google: 'Google Workspace', microsoft: 'Microsoft 365', zoho: 'Zoho', other: 'Other provider', none: 'No MX' };

// MX / SPF / DMARC / DKIM chips from a domain's last DNS check.
// The four DNS checks of a domain's last run: ok true / false, or null when
// not checked for its provider.
function dnsChecks(d) {
  const r = d.dns;
  if (!r) return null;
  const has = (re) => r.issues.some((i) => re.test(i));
  return [
    { label: 'MX', ok: r.mx.length > 0 && !has(/^MX points/), title: r.mx.join(', ') || 'No MX records' },
    { label: 'SPF', ok: Boolean(r.spf) && !has(/^SPF/), title: r.spf || 'No SPF record' },
    { label: 'DMARC', ok: Boolean(r.dmarc), title: r.dmarc || 'No DMARC record' },
    { label: 'DKIM', ok: r.dkim, title: r.dkim === null ? 'Not checked for this provider' : r.dkim ? 'DKIM found' : 'DKIM not found' },
  ];
}
function dnsChips(d) {
  const checks = dnsChecks(d);
  if (!checks) return '';
  return `<div class="dns-chips">${checks.map((c) => `<span class="dns-chip ${c.ok === null ? 'dc-na' : c.ok ? 'dc-ok' : 'dc-bad'}" title="${esc(c.title)}"><span class="dc-ico">${icon(c.ok === null ? 'minus' : c.ok ? 'check' : 'x')}</span>${c.label}</span>`).join('')}</div>`;
}
// Overall health: a ring filled by the share of checks that pass, a label and the score.
const DNS_HEALTH = { ok: ['dh-ok', 'Healthy'], warning: ['dh-warn', 'Needs attention'], error: ['dh-err', 'DNS problem'] };
function dnsBadge(d) {
  const checks = dnsChecks(d);
  if (!d.dns_status || !checks) return '<span class="dns-health dh-wait"><span class="spin"></span><span class="dh-label">Checking DNS…</span></span>';
  const counted = checks.filter((c) => c.ok !== null);
  const passed = counted.filter((c) => c.ok).length;
  const pct = counted.length ? Math.round((passed / counted.length) * 100) : 0;
  const [cls, label] = DNS_HEALTH[d.dns_status] || DNS_HEALTH.warning;
  return `<span class="dns-health ${cls}"><span class="dh-ring" style="--p:${pct}"><span>${icon(d.dns_status === 'ok' ? 'check' : d.dns_status === 'error' ? 'x' : 'alert')}</span></span><span class="dh-label">${label}</span><span class="dh-score">${passed}/${counted.length}</span></span>`;
}
const dnsIssues = (d) => (d.dns && d.dns.issues.length ? `<div class="dns-issues">${d.dns.issues.map((i) => `<div class="dns-issue">${icon('alert')}<span>${esc(i)}</span></div>`).join('')}</div>` : '');

// Client: their domains and DNS health.
// Cloudflare status of a domain: badge plus what's happening with the nameservers.
function cfCell(d, { client = false } = {}) {
  if (!d.cf_status) return '<span class="cf-none">Not on Cloudflare</span>';
  const logo = '<img class="cf-logo" src="/brand-logo/cloudflare" alt="Cloudflare">';
  const ns = (d.cf_nameservers || []).map((n) => `<div class="cf-ns-row"><span class="mono">${esc(n)}</span><button class="icon-btn icon-btn-sm" type="button" data-copy-ns="${esc(n)}" title="Copy" aria-label="Copy ${esc(n)}">${icon('copy')}</button></div>`).join('');
  const host = d.host_label || '';
  if (d.cf_status === 'error') return `<span class="cf-st cf-err">${logo}Cloudflare error</span><div class="cf-msg cf-msg-bad">${icon('alert')}<span>${esc(d.cf_error)}</span></div>`;
  if (d.cf_status === 'active') return `<span class="cf-st cf-ok">${logo}Active on Cloudflare</span>`;
  let line = '';
  if (d.ns_status === 'updated') line = `<div class="cf-msg">${icon('clock')}<span>Nameservers switched${host ? ` at ${esc(host)}` : ''}${d.ns_updated_at ? ` on ${fmtDate(d.ns_updated_at)}` : ''}. Waiting for Cloudflare to see them (usually minutes, up to 24 hours).</span></div>`;
  else if (d.ns_status === 'failed') line = `<div class="cf-msg cf-msg-bad">${icon('alert')}<span>Couldn't switch the nameservers. ${esc(d.ns_error)}</span></div>`;
  else line = `<div class="cf-msg">${icon('info')}<span>${client ? 'Set these nameservers at your domain host' : 'The client sets these nameservers at their host'}${host ? ` (${esc(host)})` : ''}:</span></div>`;
  return `<span class="cf-st cf-wait">${logo}<span class="spin"></span>Pending</span>${line}${ns ? `<div class="cf-ns">${ns}</div>` : ''}`;
}

// Client: their domains, DNS health, and (when Cloudflare is set up) their
// domain hosts and adding domains that move to Mithmill's Cloudflare.
function renderMyDomains(rows, hostsData = {}) {
  const { hosts = [], providers = [], cloudflareReady = false, serverIp = '' } = hostsData;
  const problems = rows.filter((d) => d.dns_status && d.dns_status !== 'ok').length;
  const prov = (k) => providers.find((p) => p.key === k) || {};
  shell(CLIENT_TABS, '#/domains', `
    <div class="page-head"><div><h1>Domains</h1><p class="muted">Your sending domains, the mailbox type on each, and their DNS health (checked daily).</p></div></div>
    <div class="stack">
      ${cloudflareReady ? `<div class="charts">
        <div class="card">
          <div class="card-head"><div class="head-ico"><span class="head-step">1</span><div><h2>Your domain hosts</h2><div class="muted small">Where your domains are registered. Connect one with its API key so we can switch the nameservers for you.</div></div></div></div>
          ${hosts.length ? `<div class="acct-list">${hosts.map((h) => acctCard({
            key: h.provider,
            title: esc(h.label),
            meta: `${esc(provName(prov(h.provider)).name || h.provider)}${h.hint ? ` · key <span class="mono">${esc(h.hint)}</span>` : ''}`,
            stats: `<span class="pill"><strong>${h.domain_count}</strong> domain${h.domain_count === 1 ? '' : 's'}</span>`,
            actions: `<button class="btn btn-sm btn-ghost" data-host-del="${h.id}" data-name="${esc(h.label)}">Remove</button>`,
            error: h.last_error ? `<div class="small access-off">${esc(h.last_error)}</div>` : '',
          })).join('')}</div>` : ''}
          <form class="card-pad prov-form" id="host-form">
            <div class="prov-head"><h3>${hosts.length ? 'Add another domain host' : 'Where are your domains registered?'}</h3><span class="muted small">Pick your registrar. You'll paste its API key next.</span></div>
            ${providerPicker(providers, 'host-provider')}
            <div class="prov-body">
              <div id="host-fields"></div>
              <div class="row"><button class="btn btn-primary" type="submit">Test &amp; connect</button><span class="muted small secure-note">${icon('lock')} Keys are checked first, then stored encrypted.</span></div>
              <div class="error"></div>
            </div>
          </form>
        </div>
        <form class="card card-pad" id="dom-client-add">
          <div class="head-ico" style="margin-bottom:10px"><span class="head-step">2</span><h2>Add domains</h2></div>
          <p class="muted small" style="margin:0 0 14px">We add each domain to our Cloudflare (keeping its current DNS records, so email keeps working) and switch its nameservers at your host. The domain is active once Cloudflare sees the new nameservers.</p>
          <div class="field"><label for="dc-text">Domains (one per line)</label><textarea id="dc-text" name="text" rows="5" placeholder="yourdomain.com&#10;getyourdomain.com" required></textarea></div>
          <div class="field"><label for="dc-host">Registered at</label><select id="dc-host" name="host_id" required>${hosts.length ? hosts.map((h) => `<option value="${h.id}">${esc(h.label)} (${esc(prov(h.provider).name || h.provider)})</option>`).join('') : '<option value="">Connect a domain host first</option>'}</select></div>
          <div class="row"><button class="btn btn-primary" type="submit" ${hosts.length ? '' : 'disabled'}>Add &amp; move to Cloudflare</button></div>
          <div class="error"></div>
        </form>
      </div>` : ''}
      <div class="card">
      ${rows.length ? `<div class="card-head"><div><h2>${rows.length} domain${rows.length === 1 ? '' : 's'}</h2>${problems ? `<div class="small access-off">${problems} need${problems === 1 ? 's' : ''} attention. We're on it; we'll contact you if we need anything.</div>` : '<div class="muted small">All DNS records look good.</div>'}</div></div>
      <div class="table-wrap"><table class="dom-table">
        <thead><tr><th>Domain</th><th>Mailbox type</th><th class="num">Mailboxes</th><th>Cloudflare</th><th>DNS</th><th>Last checked</th><th></th></tr></thead>
        <tbody>${rows.map((d) => `<tr>
          <td><strong class="mono">${esc(d.domain)}</strong>${d.host_label ? `<div class="muted small">${esc(d.host_label)}</div>` : ''}</td>
          <td>${typeChip(d.inbox_type, d.inbox_label)}</td>
          <td class="num">${d.mailbox_count || '<span class="muted">0</span>'}</td>
          <td class="cf-cell">${cfCell(d, { client: true })}</td>
          <td>${dnsBadge(d)}${dnsChips(d)}</td>
          <td class="small">${d.dns_checked_at ? fmtWhen(d.dns_checked_at) : '—'}</td>
          <td><div class="row" style="flex-wrap:nowrap;gap:6px">${d.cf_status && d.cf_status !== 'active' ? `<button class="btn btn-sm" data-dc-check="${d.id}">${d.ns_status === 'failed' || d.cf_status === 'error' ? 'Retry' : 'Check now'}</button>` : ''}
            ${d.added_by_client ? `<button class="btn btn-sm btn-ghost" data-dc-del="${d.id}" data-domain="${esc(d.domain)}">Remove</button>` : ''}</div></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Your domains will appear here once they\'re added.</div>'}
      </div>
    </div>`);
  const reload = async () => renderMyDomains((await api('GET', '/api/domains')).domains, await api('GET', '/api/domain-hosts'));
  const hostForm = document.getElementById('host-form');
  if (hostForm) {
    wirePicker('host-provider', (key) => {
      const p = prov(key);
      document.getElementById('host-fields').innerHTML = !p.key ? '' : `
        <p class="muted small" style="margin:0 0 10px">${esc(p.help)}</p>
        ${p.needsIp && serverIp ? `<div class="note note-info" style="margin:0 0 12px"><span>Whitelist this IP in Namecheap: <strong class="mono">${esc(serverIp)}</strong></span></div>` : ''}
        ${p.fields.map((f) => `<div class="field"><label for="hf-${f.key}">${esc(f.label)}${f.optional ? ' <span class="muted small">(optional)</span>' : ''}</label>
          <input id="hf-${f.key}" name="cred_${f.key}" ${f.secret ? 'type="password" autocomplete="off"' : 'autocomplete="off"'} ${f.optional ? '' : 'required'}></div>`).join('')}
        <div class="field"><label for="hf-label">Name it <span class="muted small">(optional)</span></label><input id="hf-label" name="label" placeholder="e.g. Main ${esc(provName(p).name)}"></div>`;
    });
    onSubmit(hostForm, async (d) => {
      const creds = Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('cred_')).map(([k, v]) => [k.slice(5), v]));
      await api('POST', '/api/domain-hosts', { provider: d.provider, label: d.label, creds });
      toast('Domain host connected');
      await reload();
    });
  }
  const addForm = document.getElementById('dom-client-add');
  if (addForm) {
    onSubmit(addForm, async (d) => {
      const btn = addForm.querySelector('[type=submit]');
      btn.textContent = 'Adding… (this can take a minute)';
      const r = await api('POST', '/api/domains', { text: d.text, host_id: d.host_id });
      toast(`${r.added} domain${r.added === 1 ? '' : 's'} added${r.failed ? `, ${r.failed} need${r.failed === 1 ? 's' : ''} attention (see below)` : ''}`);
      await reload();
    });
  }
  document.querySelectorAll('[data-host-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Remove ${b.dataset.name}? Its API keys are deleted. Domains already moved stay on Cloudflare.`)) return;
      try { await api('DELETE', `/api/domain-hosts/${b.dataset.hostDel}`); await reload(); } catch (ex) { toast(ex.message); }
    };
  });
  document.querySelectorAll('[data-dc-check]').forEach((b) => {
    b.onclick = async () => { b.disabled = true; b.textContent = 'Checking…'; try { await api('POST', `/api/domains/${b.dataset.dcCheck}/connect`, {}); } catch (ex) { toast(ex.message); } await reload(); };
  });
  document.querySelectorAll('[data-dc-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Remove ${b.dataset.domain} from your list? (It stays on Cloudflare; ask us if you want it removed there too.)`)) return;
      try { await api('DELETE', `/api/domains/${b.dataset.dcDel}`); await reload(); } catch (ex) { toast(ex.message); }
    };
  });
}

// Admin: clients and their domains.
function adminDomains() {
  const clients = state.admin.clients;
  shell(ADMIN_TABS, '#/admin/domains', `
    <div class="page-head"><div><h1>Domains</h1><p class="muted">Each client's sending domains and the mailbox type on each. DNS (MX, SPF, DMARC, DKIM) is checked when a domain is added and again every day.</p></div>
      <div class="row"><a class="btn" href="/api/domains-template.csv">${icon('download')} Sample CSV</a></div></div>
    <div class="stack">
    ${uploadGuide('domains', false)}
    <div class="card">
      ${clients.length ? `${filterBar('domclients', [
          { name: 'seller', label: 'Sold by: anyone', options: sellerOptions(clients) },
          { name: 'dns', label: 'DNS: any', options: [['issues', 'Needs attention'], ['ok', 'All healthy'], ['none', 'No domains']] },
        ])}
      <div class="table-wrap"><table>
        <thead><tr><th>Client</th><th class="num">Domains</th><th>DNS</th><th></th></tr></thead>
        <tbody>${clients.map((c) => `<tr data-id="${c.id}" data-search="${searchText(c.name, c.company, c.email, c.seller)}" data-seller="${esc(c.seller || '__none')}" data-dns="${!c.domain_count ? 'none' : c.domain_issues ? 'issues' : 'ok'}">
          <td>${clientCell(c)}</td>
          <td class="num">${c.domain_count || '<span class="muted">0</span>'}</td>
          <td>${!c.domain_count ? '<span class="cf-none">No domains yet</span>' : c.domain_issues ? `<span class="dns-health dh-warn"><span class="dh-ring" style="--p:${Math.round(((c.domain_count - c.domain_issues) / c.domain_count) * 100)}"><span>${icon('alert')}</span></span><span class="dh-label">${c.domain_issues} need${c.domain_issues === 1 ? 's' : ''} attention</span></span>` : `<span class="dns-health dh-ok"><span class="dh-ring" style="--p:100"><span>${icon('check')}</span></span><span class="dh-label">All healthy</span></span>`}</td>
          <td><a class="btn btn-sm ${c.domain_count ? '' : 'btn-primary'}" href="#/admin/domains/${c.id}">${c.domain_count ? 'Manage' : 'Add domains'}</a></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No clients yet.</div>'}
    </div>
    </div>`);
  wireFilterBar('domclients');
}

// Admin: one client's domains.
function adminDomainClient({ client, domains, batches, types }) {
  const who = client.company || client.name || client.email;
  const typeOptions = (sel, blank) => `${blank ? `<option value="">${blank}</option>` : ''}${types.map((t) => `<option value="${esc(t.inbox_type)}" ${t.inbox_type === sel ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}`;
  const issues = domains.filter((d) => d.dns_status && d.dns_status !== 'ok').length;
  shell(ADMIN_TABS, '#/admin/domains', `
    <div class="page-head"><div><p class="muted small" style="margin:0 0 4px"><a href="#/admin/domains">← Domains</a></p><h1>${esc(who)}</h1><p class="muted">${esc(client.email)} · ${domains.length} domain${domains.length === 1 ? '' : 's'}${issues ? ` · <span class="access-off">${issues} need${issues === 1 ? 's' : ''} attention</span>` : ''}</p></div>
      <div class="row"><a class="btn" href="#/admin/mailboxes/${client.id}">Mailboxes</a>${watchBtn(client.id)}</div></div>
    <div class="stack">
      <form class="card card-pad" id="dom-add">
        <h2 style="margin-bottom:4px">Add domains</h2>
        <p class="muted small" style="margin:0 0 14px">Domains are also added automatically from uploaded <a href="#/admin/mailboxes/${client.id}">mailboxes</a> and from batches. One domain per line. To give a domain its own mailbox type, write <span class="mono">domain, type</span> (e.g. <span class="mono">acme.com, Google Workspace</span>). DNS is checked right away.</p>
        <div class="field"><label for="dom-text">Domains</label><textarea id="dom-text" name="text" rows="5" placeholder="acme.com&#10;getacme.com&#10;tryacme.com, Microsoft 365 (Admin)" required></textarea>
          <div class="hint">Or load a CSV (columns <span class="mono">domain</span>, <span class="mono">type</span>): <input id="dom-file" type="file" accept=".csv,text/csv,text/plain" class="inline-file"> <a href="/api/domains-template.csv">Download the sample CSV</a></div></div>
        <div class="grid-2">
          <div class="field"><label for="dom-type">Mailbox type</label><select id="dom-type" name="inbox_type"><option value="auto">Detect from DNS (or the batch's type)</option>${typeOptions(null)}</select></div>
          <div class="field"><label for="dom-batch">Batch (optional)</label><select id="dom-batch" name="order_id"><option value="">Not linked to a batch</option>
            ${batches.map((o) => `<option value="${o.id}">${esc(o.batch_name || `Batch #${o.id}`)} · ${o.quantity} × ${esc(o.label)}${o.status === 'cancelled' ? ' (cancelled)' : ''}</option>`).join('')}</select></div>
        </div>
        <div class="row"><button class="btn btn-primary" type="submit">Add & check DNS</button><button class="btn" type="button" id="dom-import">Import from batches</button><span class="muted small">Import adds the domains written on this client's batches.</span></div>
        <div class="error"></div>
      </form>
      ${uploadGuide('domains', !domains.length)}
      <div class="card">
        <div class="card-head"><h2>Domains</h2>${domains.length ? `<div class="row">${domains.length > 8 ? '<input id="mb-search" class="mb-search" type="search" placeholder="Search domain…">' : ''}<button class="btn btn-sm" id="dom-check-all">Recheck all DNS</button></div>` : ''}</div>
        ${domains.length ? `<div class="table-wrap"><table class="dom-table">
          <thead><tr><th>Domain</th><th>Mailbox type</th><th>Detected</th><th>DNS</th><th>Cloudflare</th><th class="num">Mailboxes</th><th>Created</th><th>Checked</th><th></th></tr></thead>
          <tbody>${domains.map((d) => `<tr data-mb="${d.id}" data-search="${searchText(d.domain, d.inbox_label, d.batch_name)}">
            <td><strong class="mono">${esc(d.domain)}</strong>${d.order_id ? `<div class="muted small">${esc(d.batch_name || `Batch #${d.order_id}`)}</div>` : ''}</td>
            <td><select class="dom-type" data-dom-type="${d.id}" aria-label="Mailbox type for ${esc(d.domain)}">${typeOptions(d.inbox_type, 'Not set')}</select></td>
            <td class="small">${d.dns ? `${esc(PROVIDER_NAME[d.dns.detected] || d.dns.detected)}${d.dns.mx[0] ? `<div class="muted mono" style="font-size:11px">${esc(d.dns.mx[0])}</div>` : ''}` : '—'}</td>
            <td>${dnsBadge(d)}${dnsChips(d)}${dnsIssues(d)}</td>
            <td class="cf-cell">${cfCell(d)}${d.cf_status !== 'active' ? `<div style="margin-top:6px"><button class="btn btn-sm" data-dom-cf="${d.id}">${d.cf_status ? 'Check / retry' : 'Add to Cloudflare'}</button></div>` : ''}</td>
            <td class="num">${d.mailbox_count || '<span class="muted">0</span>'}</td>
            <td class="small">${d.created_on ? fmtDate(String(d.created_on).slice(0, 10)) : '<span class="muted">—</span>'}</td>
            <td class="small">${d.dns_checked_at ? fmtWhen(d.dns_checked_at) : '—'}</td>
            <td><div class="row" style="flex-wrap:nowrap;gap:6px"><button class="btn btn-sm" data-dom-check="${d.id}">Recheck</button><button class="btn btn-sm btn-ghost" data-dom-del="${d.id}" data-domain="${esc(d.domain)}">Delete</button></div></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No domains yet. Add them above, or import the ones written on this client\'s batches.</div>'}
      </div>
    </div>`);
  wireMailboxTable(() => '');
  const busy = (b, text) => { b.disabled = true; b.textContent = text; };
  onSubmit(document.getElementById('dom-add'), async (d) => {
    const r = await api('POST', `${API()}/clients/${client.id}/domains`, { text: d.text, inbox_type: d.inbox_type, order_id: d.order_id || null });
    const st = r.status || {};
    toast(`${r.added} added${r.updated ? `, ${r.updated} updated` : ''}. DNS: ${st.ok || 0} OK${st.warning ? `, ${st.warning} need attention` : ''}${st.error ? `, ${st.error} with problems` : ''}`);
    route();
  });
  document.getElementById('dom-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) { toast('The file is too big (1 MB max)'); return; }
    // The server reads "domain, type" lines and skips the header.
    const text = (await file.text()).replace(/^\uFEFF/, '').replace(/"/g, '');
    document.getElementById('dom-text').value = text.trim();
    toast(`${text.trim().split(/\r?\n/).length - 1} rows loaded. Check them, then click Add & check DNS.`);
  };
  document.getElementById('dom-import').onclick = async (e) => {
    busy(e.target, 'Importing…');
    try { const r = await api('POST', `${API()}/clients/${client.id}/domains/import`); toast(r.added ? `${r.added} domain${r.added === 1 ? '' : 's'} imported and checked` : 'No new domains on the batches'); route(); } catch (ex) { toast(ex.message); route(); }
  };
  const all = document.getElementById('dom-check-all');
  if (all) all.onclick = async () => { busy(all, 'Checking…'); try { await api('POST', `${API()}/clients/${client.id}/domains/check`); toast('DNS rechecked'); } catch (ex) { toast(ex.message); } route(); };
  document.querySelectorAll('[data-dom-cf]').forEach((b) => {
    b.onclick = async () => {
      busy(b, 'Working…');
      try { const r = await api('POST', `${API()}/domains/${b.dataset.domCf}/cloudflare`); if (r && !r.ok) toast(r.error); } catch (ex) { toast(ex.message); }
      route();
    };
  });
  document.querySelectorAll('[data-dom-check]').forEach((b) => {
    b.onclick = async () => { busy(b, 'Checking…'); try { await api('POST', `${API()}/domains/${b.dataset.domCheck}/check`); } catch (ex) { toast(ex.message); } route(); };
  });
  document.querySelectorAll('[data-dom-type]').forEach((s) => {
    s.onchange = async () => {
      s.disabled = true;
      try { await api('PATCH', `${API()}/domains/${s.dataset.domType}`, { inbox_type: s.value || null }); toast('Mailbox type saved, DNS rechecked'); } catch (ex) { toast(ex.message); }
      route();
    };
  });
  document.querySelectorAll('[data-dom-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Remove ${b.dataset.domain} from this client's domains?`)) return;
      try { await api('DELETE', `${API()}/domains/${b.dataset.domDel}`); route(); } catch (ex) { toast(ex.message); }
    };
  });
}

// ------------------------------------------------------------------ upload guides

// "How to upload" for the team: the columns, steps and a preview of the
// sample file, with a download. open: shown expanded.
function uploadGuide(kind, open) {
  const sample = (state.samples || {})[kind] || [];
  const g = kind === 'mailboxes' ? {
    title: 'How to upload mailboxes',
    file: '/api/mailboxes-template.csv',
    cols: [
      ['email', 'The mailbox address. Required.'],
      ['password', 'Its password. Required. The client sees it hidden until they click Show.'],
      ['admin', '<strong>yes</strong> for the admin mailbox; leave empty for the others.'],
      ['type', `Mailbox type, e.g. ${(state.admin && state.admin.pricing || []).slice(0, 3).map((p) => esc(p.label)).join(', ') || 'Google Workspace'}. Empty: the type chosen on the upload form, or the batch's.`],
      ['created', 'Date the mailbox was created, e.g. 2026-11-01 (also 01/11/2026 or 1 Nov 2026). Optional.'],
    ],
    steps: ['Download the sample CSV and open it in Google Sheets or Excel.', 'Replace the example rows with the client\'s mailboxes: one row per mailbox. Keep the header row.',
      'Save it as CSV (Google Sheets: File → Download → CSV. Excel: Save As → CSV UTF-8).', 'Open the client below, choose the file and click Upload. Their domains are added to Domains automatically.'],
  } : {
    title: 'How to add domains',
    file: '/api/domains-template.csv',
    cols: [['domain', 'The domain, e.g. acmegrowth.com. Required.'], ['type', 'Mailbox type on that domain. Empty: the type chosen on the form, the batch\'s, or detected from DNS.']],
    steps: ['Paste domains (one per line, optionally "domain, type"), or download the sample CSV, fill it in and upload it.',
      'Domains also come in automatically from uploaded mailboxes and from batches.', 'DNS (MX, SPF, DMARC, DKIM) is checked right away and every day.'],
  };
  return `<details class="card upload-guide"${open ? ' open' : ''}>
    <summary><span>${icon('invoices')} <strong>${g.title}</strong></span><span class="muted small">Sample CSV, columns and steps</span></summary>
    <div class="ug-body">
      <ol class="ug-steps">${g.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
      <div class="ug-cols">${g.cols.map(([c, d]) => `<div><span class="mono ug-col">${c}</span><span class="small">${d}</span></div>`).join('')}</div>
      ${sample.length ? `<div class="muted small" style="margin:14px 0 6px">Sample file:</div>
      <div class="table-wrap ug-sample"><table><thead><tr>${sample[0].map((h) => `<th class="mono">${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${sample.slice(1).map((r) => `<tr>${r.map((v) => `<td class="mono">${v ? esc(v) : '<span class="muted">(empty)</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
      <div class="row" style="margin-top:14px"><a class="btn btn-primary" href="${g.file}">${icon('download')} Download sample CSV</a></div>
    </div>
  </details>`;
}

// Settings: Mithmill's Cloudflare account (owner). Clients' domains are added
// there and their nameservers switched to it.
async function cloudflareCard() {
  const box = document.getElementById('cf-card');
  if (!box || !isOwner()) return;
  let cf;
  try { cf = await api('GET', '/api/admin/cloudflare'); } catch (ex) { box.innerHTML = ''; return; }
  box.innerHTML = `<form class="card card-pad" id="cf-form">
    <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:12px">
      <div><h2>Cloudflare</h2><div class="muted small" style="margin-top:4px">Clients' domains are added to this account, and their nameservers are switched to it from their domain host.</div></div>
      ${cf.tokenSet ? '<span class="badge dns-st dns-ok">Connected</span>' : '<span class="badge dns-st dns-warn">Not connected</span>'}</div>
    <div class="grid-2">
      <div class="field"><label for="cf-acc">Account ID</label><input id="cf-acc" name="account_id" class="mono" required value="${esc(cf.accountId)}" placeholder="32 characters">
        <div class="hint">Cloudflare dashboard → your account → Overview (right side) → Account ID.</div></div>
      <div class="field"><label for="cf-token">API token or Global API Key</label><input id="cf-token" name="api_token" type="password" autocomplete="off" placeholder="${cf.tokenSet ? `Saved (${esc(cf.tokenHint)}). Leave empty to keep it` : 'Paste the token'}" ${cf.tokenSet ? '' : 'required'}>
        <div class="hint">My Profile → API Tokens → Create Token → Custom token with: <strong>Zone → Zone → Edit</strong> and <strong>Zone → DNS → Edit</strong>; Account resources: <strong>Include → your account</strong>; Zone resources: <strong>Include → All zones from that account</strong>.</div></div>
    </div>
    <div class="field"><label for="cf-email">Cloudflare login email <span class="muted small">(only if you use the Global API Key)</span></label><input id="cf-email" name="email" type="email" value="${esc(cf.email || '')}" placeholder="Leave empty for an API token">
      <div class="hint">API tokens work on their own. The Global API Key (My Profile → API Tokens → Global API Key → View) also needs the email you log in to Cloudflare with.</div></div>
    <div class="row"><button class="btn btn-primary" type="submit">${cf.tokenSet ? 'Save & test' : 'Connect Cloudflare'}</button>${cf.tokenSet ? '<button class="btn" type="button" id="cf-test">Test connection</button>' : ''}<span class="muted small">The token is checked first, then stored encrypted. It's never shown again.</span></div>
    <div class="error"></div>
  </form>`;
  onSubmit(document.getElementById('cf-form'), async (d) => {
    const r = await api('PUT', '/api/admin/cloudflare', d);
    toast(`Cloudflare connected: ${r.account}`);
    cloudflareCard();
  });
  const t = document.getElementById('cf-test');
  if (t) t.onclick = async () => { try { const r = await api('POST', '/api/admin/cloudflare/test'); toast(`Working: ${r.account}`); } catch (ex) { toast(ex.message); } };
}

// Owner: the client's recent sequencer connections, with what was on screen
// when one failed (for fixing a sign-in step).
async function connectionLog(clientId) {
  const box = document.getElementById('conn-log');
  if (!box) return;
  let jobs;
  try { ({ jobs } = await api('GET', `/api/admin/clients/${clientId}/connect-jobs`)); } catch { return; }
  if (!jobs.length) return;
  box.innerHTML = `<div class="card"><div class="card-head"><div><h2>Sequencer connection log</h2><div class="muted small">The client's recent connections. Failed ones show the step and what was on screen.</div></div></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Mailbox</th><th>Sequencer</th><th>Result</th></tr></thead><tbody>
    ${jobs.map((j) => `<tr><td class="small nowrap">${fmtWhen(j.created_at)}</td><td class="mono small">${esc(j.email)}</td><td>${esc(j.sequencer)}</td>
      <td><span class="conn-chip conn-${j.status === 'done' ? 'connected' : j.status}">${j.status === 'done' ? 'Connected' : CONN_LABEL[j.status] || j.status}</span>
        ${j.step ? `<span class="muted small"> · ${esc(j.step)}</span>` : ''}${j.error ? `<div class="small ${j.status === 'failed' ? 'access-off' : 'muted'}">${esc(j.error)}</div>` : ''}
        ${j.diag ? `<details class="small"><summary>On screen</summary><div class="mono" style="white-space:pre-wrap;font-size:11px">${esc([
          `URL: ${j.diag.url || ''}`, `Title: ${j.diag.title || ''}`, `Headings: ${(j.diag.headings || []).join(' | ')}`,
          `Buttons: ${(j.diag.buttons || []).join(' | ')}`, `Inputs: ${(j.diag.inputs || []).join(' | ')}`, `Text: ${j.diag.text || ''}`].join('\n'))}</div></details>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// "Send invite" for a reseller's client (reseller's Clients page and the
// owner's reseller page): emails the invite in the reseller's brand.
function wireClientInvites() {
  document.querySelectorAll('[data-rc-invite]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api('POST', `${isReseller() ? '/api/reseller' : '/api/admin'}/clients/${b.dataset.rcInvite}/invite`);
        if (r.emailed) toast(`${r.reset ? 'Password link' : 'Invite'} emailed to ${b.dataset.email}`);
        else prompt(`Email isn't set up, so send this link to ${b.dataset.email} yourself:`, r.link);
        route();
      } catch (ex) { toast(ex.message); b.disabled = false; }
    };
  });
}


// ------------------------------------------------------------------ motion
// The premium feel: a ripple where a button is pressed, pages that ease in on
// navigation, and headline numbers that count up. All of it is skipped when
// the person's system asks for reduced motion.
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.btn, .type, .sb-nav a, .icon-btn, .tab, .chip-btn');
  if (!el || el.disabled || reduceMotion()) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2.2;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  el.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove());
}, { passive: true });

let enterTimer = null;
function pageEnter() {
  if (reduceMotion()) return;
  document.body.dataset.enter = '1';
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => { delete document.body.dataset.enter; }, 900);
}

// "$1,234.50", "286", "12%": counts from 0 to the value, keeping its format.
function countUp(el) {
  const text = el.textContent.trim();
  const m = text.match(/^([^\d-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/);
  if (!m) return;
  const target = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(target) || target === 0) return;
  const decimals = (m[2].split('.')[1] || '').length;
  const fmt = (n) => m[1] + n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + m[3];
  const t0 = performance.now();
  const dur = 900;
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 4);
    el.textContent = fmt(target * e);
    if (k < 1) requestAnimationFrame(tick); else el.textContent = text;
  };
  requestAnimationFrame(tick);
}
new MutationObserver(() => {
  if (!document.body.dataset.enter) return;
  document.querySelectorAll('.wv:not([data-counted]), .stat .value:not([data-counted])').forEach((el) => { el.dataset.counted = '1'; countUp(el); });
}).observe(document.getElementById('app'), { childList: true, subtree: true });
pageEnter();

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy-ns]');
  if (!b) return;
  navigator.clipboard.writeText(b.dataset.copyNs).then(() => { toast(`${b.dataset.copyWhat || 'Nameserver'} copied`); b.classList.add('copied'); setTimeout(() => b.classList.remove('copied'), 1200); }).catch(() => toast(b.dataset.copyNs));
});

document.addEventListener('click', (e) => {
  document.querySelectorAll('details.menu[open]').forEach((m) => { if (!m.contains(e.target) || e.target.closest('.menu-item')) m.open = false; });
});
// Menus open as a floating panel (fixed, so table scroll areas don't clip them).
document.addEventListener('toggle', (e) => {
  const m = e.target;
  if (!(m instanceof HTMLDetailsElement) || !m.classList.contains('menu') || !m.open) return;
  document.querySelectorAll('details.menu[open]').forEach((x) => { if (x !== m) x.open = false; });
  const pop = m.querySelector('.menu-pop');
  const r = m.querySelector('summary').getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = '';
  pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  const ph = pop.offsetHeight;
  if (r.bottom + 6 + ph > window.innerHeight - 8) pop.style.top = `${Math.max(8, r.top - ph - 6)}px`;
}, true);
window.addEventListener('scroll', () => document.querySelectorAll('details.menu[open]').forEach((x) => { x.open = false; }), { passive: true });

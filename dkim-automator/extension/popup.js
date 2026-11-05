const $ = id => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get(['serverUrl', 'key', 'enabled', 'signOut', 'status', 'log']);
  $('signOut').checked = !!s.signOut;
  $('serverUrl').value = s.serverUrl || self.DKIM_DEFAULTS.serverUrl || '';
  $('key').value = s.key || self.DKIM_DEFAULTS.key || '';
  $('enabled').checked = s.enabled !== false;
  render(s.status, s.log);
}

function render(st = {}, log = []) {
  const el = $('status');
  if (st.needsYou) {
    el.className = 'status bad';
    el.textContent = `Needs you in the pinned tab → ${st.needsYou}`;
  } else if (st.connected) {
    el.className = 'status ok';
    el.textContent = st.current ? `Connected — working: ${st.current}` : 'Connected — waiting for work';
  } else {
    el.className = 'status' + (st.error ? ' bad' : '');
    el.textContent = st.error ? `Not connected: ${st.error}` : 'Not connected yet';
  }
  $('log').textContent = log.slice().reverse().join('\n');
}

async function save() {
  let url = $('serverUrl').value.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
  // servers outside *.onrender.com need an extra host permission
  if (url && !/\.onrender\.com$/.test(new URL(url).hostname)) {
    const ok = await chrome.permissions.request({ origins: [new URL(url).origin + '/*'] });
    if (!ok) { alert('Permission to reach that server was not granted.'); return; }
  }
  await chrome.storage.local.set({ serverUrl: url, key: $('key').value, enabled: $('enabled').checked, signOut: $('signOut').checked });
}

$('save').onclick = async () => { await save(); chrome.runtime.sendMessage('poll'); };
$('poll').onclick = async () => { await save(); $('status').textContent = 'Checking…'; chrome.runtime.sendMessage('poll'); };
chrome.storage.onChanged.addListener(async () => {
  const s = await chrome.storage.local.get(['status', 'log']);
  render(s.status, s.log);
});
load();

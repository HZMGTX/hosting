// Users & invites, audit log, and the signed-in user's account (password, 2FA, sessions, API tokens).
import { h, icon, mount, btn, toast, busy, field, confirmDialog, promptDialog, empty, timeAgo, badge, modal, copyField, fmtDate, debounce, loading } from '../ui.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { page, desktopNotificationsEnabled, setDesktopNotifications } from '../shell.js';

const ROLE_DESC = {
  owner: 'Everything, including managing other owners.',
  admin: 'All services, users, settings, commands and audit log.',
  developer: 'Only the services assigned to them: edit, deploy, start/stop.',
  viewer: 'Read-only access to every service (no secrets).'
};
const ROLE_BADGE = { owner: 'danger', admin: 'warning', developer: 'accent', viewer: '' };

function servicePicker(selected = []) {
  const boxes = Object.values(store.services).map(s => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: s.id, checked: selected.includes(s.id) }), h('span', null, s.name)));
  const el = h('div', { class: 'grid cols-2', style: { gap: 0 } }, boxes.length ? boxes : h('p', { class: 'small muted' }, 'No services yet.'));
  el.getValue = () => boxes.map(b => b.querySelector('input')).filter(i => i.checked).map(i => i.value);
  return el;
}

function roleSelect(value = 'developer') {
  const roles = store.can('owner') ? ['owner', 'admin', 'developer', 'viewer'] : ['admin', 'developer', 'viewer'];
  const desc = h('div', { class: 'hint' }, ROLE_DESC[value]);
  const sel = h('select', { class: 'select', onChange: () => { desc.textContent = ROLE_DESC[sel.value]; } }, roles.map(r => h('option', { value: r, selected: r === value }, r)));
  return { sel, wrap: h('div', { class: 'field' }, h('label', null, 'Role'), sel, desc) };
}

// ---------------- Users ----------------
export async function usersPage() {
  const el = page('Users & invites');
  if (!store.can('admin')) return mount(el, empty('lock', 'Admins only', ''));
  const usersBox = h('div');
  const invitesBox = h('div');

  function editUser(u) {
    const role = roleSelect(u.role);
    const picker = servicePicker(u.services);
    const save = btn('Save', { variant: 'primary' });
    const m = modal({
      title: `Edit ${u.username}`,
      body: h('div', null, role.wrap, h('div', { class: 'field' }, h('label', null, 'Services (for developers)'), picker),
        h('hr'),
        h('div', { class: 'btn-group' },
          btn('Reset password', { size: 'sm', icon: 'key', onClick: async () => { const pw = await promptDialog({ title: 'New password', label: `New password for ${u.username}`, type: 'password', validate: v => (v.length >= 10 ? null : 'At least 10 characters') }); if (pw) { await api.patch(`/api/users/${u.id}`, { password: pw }); toast('Password reset; their sessions were signed out', 'success'); } } }),
          u.twoFactor ? btn('Reset 2FA', { size: 'sm', icon: 'shield', onClick: async () => { if (await confirmDialog(`Turn off two-factor login for ${u.username}?`)) { await api.patch(`/api/users/${u.id}`, { resetTwoFactor: true }); toast('2FA reset', 'success'); } } }) : null)),
      footer: [btn('Cancel', { onClick: () => m.close() }), save]
    });
    save.addEventListener('click', busy(save, async () => {
      await api.patch(`/api/users/${u.id}`, { role: role.sel.value, services: picker.getValue() });
      m.close();
      toast('User updated', 'success');
      load();
    }));
  }

  function addUser() {
    const name = h('input', { class: 'input', autocomplete: 'off' });
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const role = roleSelect('developer');
    const picker = servicePicker();
    const save = btn('Create user', { variant: 'primary' });
    const m = modal({
      title: 'Add user',
      body: h('div', null, field('Username', name), field('Password', pw, 'At least 10 characters. They can change it later.'), role.wrap, h('div', { class: 'field' }, h('label', null, 'Services (for developers)'), picker)),
      footer: [btn('Cancel', { onClick: () => m.close() }), save]
    });
    save.addEventListener('click', busy(save, async () => {
      await api.post('/api/users', { username: name.value.trim(), password: pw.value, role: role.sel.value, services: picker.getValue() });
      m.close();
      toast('User created', 'success');
      load();
    }));
  }

  function invite() {
    const role = roleSelect('developer');
    const picker = servicePicker();
    const days = h('input', { class: 'input', type: 'number', value: 7, min: 1, max: 30 });
    const create = btn('Create invite link', { variant: 'primary' });
    const body = h('div', null, role.wrap, h('div', { class: 'field' }, h('label', null, 'Services (for developers)'), picker), field('Expires after (days)', days));
    const m = modal({ title: 'Invite someone', body, footer: [btn('Close', { onClick: () => m.close() }), create] });
    create.addEventListener('click', busy(create, async () => {
      const r = await api.post('/api/users/invites', { role: role.sel.value, services: picker.getValue(), days: days.value });
      const link = `${location.origin}/#/invite/${r.code}`;
      mount(body, h('div', { class: 'callout success' }, icon('check', 18), h('div', { class: 'callout-body' }, h('strong', null, 'Invite created'), h('p', null, 'Send this link privately. It works once and is shown only now.'))), copyField(link));
      create.remove();
      loadInvites();
    }));
  }

  async function load() {
    const users = await api.get('/api/users');
    mount(usersBox, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'User'), h('th', null, 'Role'), h('th', null, 'Services'), h('th', null, '2FA'), h('th', null, 'Last sign-in'), h('th', null, ''))),
      h('tbody', null, users.map(u => h('tr', null,
        h('td', null, h('strong', null, u.username), u.id === store.user.id ? h('span', { class: 'tiny muted' }, ' (you)') : null),
        h('td', null, badge(u.role, ROLE_BADGE[u.role])),
        h('td', { class: 'small' }, u.role === 'developer' ? (u.services.length ? u.services.map(s => (store.services[s] || { name: s }).name).join(', ') : h('span', { class: 'muted' }, 'none')) : h('span', { class: 'muted' }, 'all')),
        h('td', null, u.twoFactor ? badge('on', 'success') : badge('off')),
        h('td', { class: 'small muted' }, timeAgo(u.lastLoginAt)),
        h('td', { class: 'actions' }, u.id !== store.user.id ? [
          btn('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Edit', onClick: () => editUser(u) }),
          btn('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Delete', onClick: async () => { if (await confirmDialog(`Delete user ${u.username}?`, { danger: true, okLabel: 'Delete' })) { await api.del(`/api/users/${u.id}`); load(); } } })
        ] : null)))))));
  }

  async function loadInvites() {
    const invites = await api.get('/api/users/invites');
    mount(invitesBox, invites.length ? h('div', { class: 'list' }, invites.map(i => h('div', { class: 'list-item' },
      badge(i.role, ROLE_BADGE[i.role]), h('span', { class: 'grow small' }, `by ${i.createdBy} · expires ${timeAgo(i.expiresAt)}`),
      btn('Revoke', { size: 'sm', variant: 'danger', onClick: async () => { await api.del(`/api/users/invites/${i.id}`); loadInvites(); } })))) : h('p', { class: 'small muted' }, 'No pending invites.'));
  }

  mount(el,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Users & invites'), h('p', null, 'Give teammates exactly the access they need.')),
      h('div', { class: 'btn-group' }, btn('Add user', { icon: 'plus', onClick: addUser }), btn('Invite link', { variant: 'primary', icon: 'link', onClick: invite }))),
    h('div', { class: 'card' }, usersBox),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('link', 18), 'Pending invites')), invitesBox),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('shield', 18), 'Roles')),
      h('dl', { class: 'kv' }, Object.entries(ROLE_DESC).flatMap(([r, d]) => [h('dt', null, badge(r, ROLE_BADGE[r])), h('dd', { class: 'small' }, d)]))));
  load();
  loadInvites();
}

// ---------------- Audit log ----------------
export async function auditPage() {
  const el = page('Audit log');
  if (!store.can('admin')) return mount(el, empty('lock', 'Admins only', ''));
  const box = h('div');
  const qIn = h('input', { class: 'input', placeholder: 'Search user, action, service, details…', style: { maxWidth: '360px' } });
  async function load() {
    const list = await api.get(`/api/system/audit?limit=500&q=${encodeURIComponent(qIn.value.trim())}`);
    mount(box, list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'User'), h('th', null, 'Action'), h('th', null, 'Target'), h('th', null, 'Details'), h('th', null, 'IP'))),
      h('tbody', null, list.map(e => h('tr', null,
        h('td', { class: 'nowrap small', title: fmtDate(e.at) }, timeAgo(e.at)),
        h('td', { class: 'small' }, e.user),
        h('td', null, badge(e.action, e.action.includes('failed') || e.action.includes('deleted') ? 'danger' : e.action.startsWith('auth') ? 'info' : 'accent')),
        h('td', { class: 'mono small' }, e.target),
        h('td', { class: 'small muted', style: { maxWidth: '360px', overflowWrap: 'anywhere' } }, e.details),
        h('td', { class: 'mono tiny faint' }, e.ip)))))) : empty('list', 'Nothing found', ''));
  }
  qIn.addEventListener('input', debounce(load, 300));
  mount(el,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Audit log'), h('p', null, 'Every sign-in, deploy, file change, setting and secret access.')), qIn),
    h('div', { class: 'card' }, box));
  load();
}

// ---------------- My account ----------------
export async function accountPage() {
  const el = page('My account');
  mount(el, loading());
  const me = await api.get('/api/account');
  const sessionsBox = h('div');
  const tokensBox = h('div');
  const tfaBox = h('div');

  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const changePw = btn('Change password', { variant: 'primary' });
  changePw.addEventListener('click', busy(changePw, async () => {
    await api.post('/api/account/password', { currentPassword: cur.value, newPassword: next.value });
    cur.value = next.value = '';
    toast('Password changed. Other devices were signed out.', 'success');
    loadSessions();
  }));

  function renderTfa(enabled) {
    if (enabled) {
      const off = btn('Turn off', { variant: 'danger' });
      off.addEventListener('click', busy(off, async () => {
        const pw = await promptDialog({ title: 'Turn off two-factor login', label: 'Confirm your password', type: 'password' });
        if (!pw) return;
        await api.post('/api/account/2fa/disable', { password: pw });
        toast('Two-factor login turned off', 'success');
        renderTfa(false);
      }));
      return mount(tfaBox, h('div', { class: 'callout success' }, icon('shield', 18), h('div', { class: 'callout-body' }, h('strong', null, 'Two-factor login is on'), h('p', null, `${me.recoveryCodesLeft} recovery code(s) left.`)), off));
    }
    const start = btn('Set up two-factor login', { variant: 'primary', icon: 'shield' });
    start.addEventListener('click', busy(start, async () => {
      const r = await api.post('/api/account/2fa/setup');
      const qr = h('div', { style: { background: '#fff', padding: '8px', borderRadius: '8px', width: '216px' } });
      // The QR SVG is generated by our own server from the otpauth URL (no user content).
      qr.appendChild(new DOMParser().parseFromString(r.qrSvg, 'image/svg+xml').documentElement);
      const code = h('input', { class: 'input mono', inputmode: 'numeric', maxlength: 6, placeholder: '123456' });
      const verify = btn('Verify & enable', { variant: 'primary' });
      verify.addEventListener('click', busy(verify, async () => {
        const res = await api.post('/api/account/2fa/enable', { code: code.value });
        me.recoveryCodesLeft = res.recoveryCodes.length;
        mount(tfaBox, h('div', { class: 'callout success' }, icon('check', 18), h('div', { class: 'callout-body' },
          h('strong', null, 'Enabled. Save these recovery codes somewhere safe'), h('p', null, 'Each works once if you lose your phone. They are not shown again.'),
          h('pre', { class: 'mono mt-sm' }, res.recoveryCodes.join('\n')))),
          btn('Done', { onClick: () => renderTfa(true) }));
      }));
      mount(tfaBox, h('div', { class: 'row gap-lg wrap', style: { alignItems: 'flex-start' } }, qr,
        h('div', { class: 'grow' },
          h('p', { class: 'small' }, 'Scan with Google Authenticator, 1Password, Authy or similar. Or enter this key manually:'),
          copyField(r.secret),
          field('Code from the app', code), verify)));
    }));
    mount(tfaBox, h('p', { class: 'small muted' }, 'Protect your account with a code from an authenticator app in addition to your password.'), start);
  }

  async function loadSessions() {
    const list = await api.get('/api/account/sessions');
    mount(sessionsBox, h('div', { class: 'list' }, list.map(s => h('div', { class: 'list-item' },
      icon('monitor', 16),
      h('div', { class: 'grow' }, h('div', { class: 'small ellipsis' }, s.userAgent || 'Unknown device'), h('div', { class: 'tiny faint' }, `${s.ip || ''} · signed in ${timeAgo(s.createdAt)} · active ${timeAgo(s.lastSeenAt)}`)),
      s.current ? badge('this device', 'success') : btn('Sign out', { size: 'sm', onClick: async () => { await api.del(`/api/account/sessions/${s.id}`); loadSessions(); } })))),
    list.length > 1 ? h('div', { class: 'form-actions' }, btn('Sign out all other devices', { size: 'sm', variant: 'danger', onClick: async () => { await api.post('/api/account/sessions/revoke-others'); loadSessions(); } })) : null);
  }

  async function loadTokens() {
    const list = await api.get('/api/account/tokens');
    mount(tokensBox, list.length ? h('div', { class: 'list' }, list.map(t => h('div', { class: 'list-item' },
      icon('key', 16), h('div', { class: 'grow' }, h('div', { class: 'small' }, t.name), h('div', { class: 'tiny faint mono' }, `${t.prefix}… · created ${timeAgo(t.createdAt)} · used ${timeAgo(t.lastUsedAt)}`)),
      btn('Revoke', { size: 'sm', variant: 'danger', onClick: async () => { if (await confirmDialog(`Revoke token "${t.name}"? Scripts using it stop working.`, { danger: true, okLabel: 'Revoke' })) { await api.del(`/api/account/tokens/${t.id}`); loadTokens(); } } })))) : h('p', { class: 'small muted' }, 'No API tokens.'));
  }

  const newToken = btn('New token', { icon: 'plus' });
  newToken.addEventListener('click', busy(newToken, async () => {
    const name = await promptDialog({ title: 'New API token', label: 'Name', placeholder: 'e.g. GitHub Actions', okLabel: 'Create' });
    if (!name) return;
    const r = await api.post('/api/account/tokens', { name });
    modal({ title: 'Token created', body: h('div', null, h('p', { class: 'small' }, 'Copy it now — it will not be shown again. It has the same permissions as your account.'), copyField(r.token)) });
    loadTokens();
  }));

  mount(el,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, me.user.username), h('p', null, h('span', null, badge(me.user.role, ROLE_BADGE[me.user.role])), ' ', ROLE_DESC[me.user.role]))),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('key', 18), 'Password')),
        field('Current password', cur), field('New password', next, 'At least 10 characters.'), h('div', { class: 'form-actions' }, changePw)),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('shield', 18), 'Two-factor login')), tfaBox)),
    h('div', { class: 'card mb' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('bell', 18), 'Desktop notifications'), h('p', null, 'Pop up crashes, recoveries and monitor alerts when this tab is in the background (this browser only).'))),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: desktopNotificationsEnabled(), onChange: async e => {
          try { await setDesktopNotifications(e.target.checked); toast(e.target.checked ? 'Desktop notifications on' : 'Desktop notifications off', 'success'); } catch (err) { e.target.checked = false; toast(err.message, 'error'); }
        } }),
        h('span', null, 'Show desktop notifications'))),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('monitor', 18), 'Signed-in devices')), sessionsBox),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('terminal', 18), 'API tokens'), h('p', null, h('a', { href: '#/docs' }, 'API reference'))), newToken), tokensBox)));
  renderTfa(me.user.twoFactor);
  loadSessions();
  loadTokens();
}

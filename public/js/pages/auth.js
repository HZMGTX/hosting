// Sign-in, first-run setup, two-factor step and invite acceptance.
import { h, icon, mount, field, toast } from '../ui.js';
import { api } from '../api.js';

function card(root, ...children) {
  mount(root, h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('rocket', 17)), 'OmniHost'),
    ...children)));
}

function form(onSubmit, ...children) {
  const errBox = h('div', { class: 'callout error hidden', role: 'alert' }, h('div', { class: 'callout-body' }));
  const f = h('form', {
    onSubmit: async e => {
      e.preventDefault();
      const button = f.querySelector('button[type=submit]');
      button.classList.add('loading');
      errBox.classList.add('hidden');
      try { await onSubmit(new FormData(f)); } catch (err) {
        errBox.firstChild.textContent = err.message;
        errBox.classList.remove('hidden');
      } finally { button.classList.remove('loading'); }
    }
  }, errBox, ...children);
  return f;
}

function input(name, label, opts = {}) {
  return field(label, h('input', { class: 'input', name, required: true, ...opts }), opts.hint);
}

export function showSetup(root, done) {
  card(root,
    h('h1', null, 'Create your owner account'),
    h('p', { class: 'lead' }, 'This is a fresh OmniHost install. The first account owns the panel and can invite others later.'),
    form(async fd => {
      if (fd.get('password') !== fd.get('confirm')) throw new Error('Passwords do not match');
      await api.post('/api/auth/setup', { username: fd.get('username'), password: fd.get('password') });
      toast('Welcome to OmniHost!', 'success');
      done();
    },
    input('username', 'Username', { autocomplete: 'username', value: 'LiamH', minlength: 3, maxlength: 32 }),
    input('password', 'Password', { type: 'password', autocomplete: 'new-password', minlength: 10, hint: 'At least 10 characters. Use a password manager.' }),
    input('confirm', 'Confirm password', { type: 'password', autocomplete: 'new-password', minlength: 10 }),
    h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, 'Create account')));
}

export function showLogin(root, done) {
  card(root,
    h('h1', null, 'Sign in'),
    h('p', { class: 'lead' }, 'Manage your bots, apps and sites.'),
    form(async fd => {
      const res = await api.post('/api/auth/login', { username: fd.get('username'), password: fd.get('password') });
      if (res.mfaRequired) return showMfa(root, res.mfaToken, done);
      done();
    },
    input('username', 'Username', { autocomplete: 'username', autofocus: true }),
    input('password', 'Password', { type: 'password', autocomplete: 'current-password' }),
    h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, 'Sign in')));
}

function showMfa(root, mfaToken, done) {
  card(root,
    h('h1', null, 'Two-factor code'),
    h('p', { class: 'lead' }, 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.'),
    form(async fd => {
      await api.post('/api/auth/login/mfa', { mfaToken, code: fd.get('code') });
      done();
    },
    input('code', 'Code', { autocomplete: 'one-time-code', inputmode: 'numeric', autofocus: true, class: 'input mono', maxlength: 9 }),
    h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, 'Verify'),
    h('p', { class: 'small muted mt' }, h('a', { href: '#/', onClick: e => { e.preventDefault(); showLogin(root, done); } }, '← Back to sign in'))));
}

export async function showInvite(root, code, done) {
  let info;
  try { info = await api.get(`/api/auth/invite/${encodeURIComponent(code)}`); } catch (e) {
    return card(root, h('h1', null, 'Invite not valid'), h('p', { class: 'lead' }, e.message), h('a', { class: 'btn', href: '#/' }, 'Go to sign in'));
  }
  card(root,
    h('h1', null, 'Join OmniHost'),
    h('p', { class: 'lead' }, `${info.invitedBy} invited you as ${info.role}. Pick a username and password.`),
    form(async fd => {
      if (fd.get('password') !== fd.get('confirm')) throw new Error('Passwords do not match');
      await api.post(`/api/auth/invite/${encodeURIComponent(code)}`, { username: fd.get('username'), password: fd.get('password') });
      location.hash = '#/';
      done();
    },
    input('username', 'Username', { autocomplete: 'username', minlength: 3, maxlength: 32, autofocus: true }),
    input('password', 'Password', { type: 'password', autocomplete: 'new-password', minlength: 10, hint: 'At least 10 characters.' }),
    input('confirm', 'Confirm password', { type: 'password', autocomplete: 'new-password', minlength: 10 }),
    h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, 'Create account')));
}

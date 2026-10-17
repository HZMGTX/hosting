// DOM helpers, toasts, modals, popovers and formatters. Text is always set via textContent (no XSS).
import { icon } from './icons.js';

// h('div', { class: 'x', onClick: fn }, 'text', child, [more])
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly' || k === 'multiple' || k === 'autofocus') el[k] = !!v;
      else if (k === 'ref' && typeof v === 'function') v(el);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export { icon };

export function btn(label, opts = {}) {
  const { variant = '', icon: ic, onClick, title, size, type = 'button', disabled } = opts;
  return h('button', {
    type, class: ['btn', variant, size, !label && ic ? 'icon' : ''], onClick, title: title || (typeof label === 'string' ? undefined : title),
    'aria-label': !label ? title : undefined, disabled
  }, ic ? icon(ic, 15) : null, label || null);
}

// Wrap an async click handler with a loading state and error toast.
export function busy(button, fn) {
  return async (...args) => {
    if (button.classList.contains('loading')) return;
    button.classList.add('loading');
    try { return await fn(...args); } catch (e) { toast(e.message, 'error'); } finally { button.classList.remove('loading'); }
  };
}

export function badge(text, variant = '') {
  return h('span', { class: ['badge', variant] }, text);
}

export const STATUS_VARIANT = { ONLINE: 'success', CRASHED: 'danger', OFFLINE: '', STARTING: 'warning', RESTARTING: 'warning', INSTALLING: 'warning', BUILDING: 'warning', STOPPING: 'warning' };
export const STATUS_LABEL = { ONLINE: 'Online', CRASHED: 'Crashed', OFFLINE: 'Stopped', STARTING: 'Starting', RESTARTING: 'Restarting', INSTALLING: 'Installing', BUILDING: 'Building', STOPPING: 'Stopping' };

export function statusBadge(status) {
  return h('span', { class: ['badge', STATUS_VARIANT[status] || ''] }, h('span', { class: ['status-dot', status] }), STATUS_LABEL[status] || status);
}

// ---------- toasts ----------
let toastHost = null;
export function toast(message, type = 'info', ms = 4500) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const iconName = { success: 'check', error: 'alert', warning: 'alert', info: 'info' }[type] || 'info';
  const el = h('div', { class: ['toast', type] },
    h('span', { class: `lvl-${type}` }, icon(iconName, 16)),
    h('div', { class: 'toast-msg' }, message),
    h('button', { 'aria-label': 'Dismiss', onClick: () => el.remove() }, icon('x', 14)));
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? ms * 2 : ms);
}

// ---------- modals ----------
const modalStack = [];
export function modal({ title, body, footer, size = '', onClose, className = '' }) {
  const prevFocus = document.activeElement;
  const close = () => {
    layer.remove();
    const i = modalStack.indexOf(close);
    if (i >= 0) modalStack.splice(i, 1);
    if (onClose) onClose();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  const box = h('div', { class: ['modal', size, className], role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    title ? h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: close }, icon('x', 16))) : null,
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  const layer = h('div', { class: 'modal-layer', onMousedown: e => { if (e.target === layer) close(); } }, box);
  document.body.appendChild(layer);
  modalStack.push(close);
  setTimeout(() => {
    const f = box.querySelector('[autofocus], input:not([type=hidden]), select, textarea, button.primary');
    if (f) f.focus();
  }, 30);
  return { close, box, layer };
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && modalStack.length) { e.preventDefault(); modalStack[modalStack.length - 1](); }
});

export function confirmDialog(message, { title = 'Are you sure?', okLabel = 'Confirm', danger = false, detail } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; m.close(); resolve(v); } };
    const ok = btn(okLabel, { variant: danger ? 'danger solid' : 'primary', onClick: () => finish(true) });
    const m = modal({
      title,
      body: h('div', null, h('p', null, message), detail ? h('p', { class: 'muted small' }, detail) : null),
      footer: [btn('Cancel', { onClick: () => finish(false) }), ok],
      onClose: () => { if (!done) { done = true; resolve(false); } }
    });
    setTimeout(() => ok.focus(), 40);
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', okLabel = 'OK', hint, mono = false, type = 'text', validate }) {
  return new Promise(resolve => {
    let done = false;
    const input = h('input', { class: ['input', mono ? 'mono' : ''], value, placeholder, type, autofocus: true });
    const err = h('div', { class: 'hint lvl-error hidden' });
    const submit = () => {
      const v = input.value.trim();
      const problem = validate ? validate(v) : (!v ? 'Required' : null);
      if (problem) { err.textContent = problem; err.classList.remove('hidden'); return; }
      done = true; m.close(); resolve(v);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    const m = modal({
      title,
      body: h('div', { class: 'field' }, label ? h('label', null, label) : null, input, hint ? h('div', { class: 'hint' }, hint) : null, err),
      footer: [btn('Cancel', { onClick: () => m.close() }), btn(okLabel, { variant: 'primary', onClick: submit })],
      onClose: () => { if (!done) resolve(null); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}

// ---------- popover menus ----------
let openPopover = null;
export function popover(anchor, content, { align = 'end', width } = {}) {
  closePopover();
  const el = h('div', { class: 'popover', role: 'menu' }, content);
  if (width) el.style.width = width + 'px';
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  let left = align === 'end' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - el.offsetHeight - 6);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  const onDoc = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = e => { if (e.key === 'Escape') closePopover(); };
  setTimeout(() => { document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey); }, 0);
  openPopover = { el, cleanup: () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); } };
  return el;
}

export function closePopover() {
  if (openPopover) { openPopover.cleanup(); openPopover.el.remove(); openPopover = null; }
}

export function menu(anchor, items) {
  popover(anchor, items.map(it => {
    if (it === '-') return h('div', { class: 'menu-sep' });
    return h('button', {
      class: ['menu-item', it.danger ? 'danger' : ''], role: 'menuitem', disabled: it.disabled,
      onClick: () => { closePopover(); it.onClick(); }
    }, it.icon ? icon(it.icon, 15) : null, it.label);
  }));
}

// ---------- formatting ----------
export function fmtBytes(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function timeAgo(when) {
  if (!when) return 'never';
  const t = typeof when === 'number' ? when : Date.parse(when);
  const diff = (Date.now() - t) / 1000;
  if (diff < 0) {
    const f = -diff;
    if (f < 60) return `in ${Math.round(f)}s`;
    if (f < 3600) return `in ${Math.round(f / 60)}m`;
    if (f < 86400) return `in ${Math.round(f / 3600)}h`;
    return `in ${Math.round(f / 86400)}d`;
  }
  if (diff < 10) return 'just now';
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.round(diff / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function fmtDate(when) {
  if (!when) return '—';
  return new Date(typeof when === 'number' ? when : Date.parse(when)).toLocaleString();
}

export function pct(v) {
  return v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10}%`;
}

export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'success', 1800);
  } catch {
    toast('Copy failed — select and copy manually', 'warning');
  }
}

export function copyField(text, { secret = false } = {}) {
  const span = h('span', null, secret ? '•'.repeat(Math.min(32, text.length)) : text);
  let shown = !secret;
  return h('div', { class: 'copy-field' }, span,
    secret ? h('button', { class: 'btn ghost sm icon', title: 'Show', 'aria-label': 'Show', onClick: () => { shown = !shown; span.textContent = shown ? text : '•'.repeat(Math.min(32, text.length)); } }, icon('eye', 14)) : null,
    h('button', { class: 'btn ghost sm icon', title: 'Copy', 'aria-label': 'Copy', onClick: () => copyText(text) }, icon('copy', 14)));
}

let fieldSeq = 0;
export function field(label, control, hint) {
  // Link the label to its control so screen readers announce it and clicking the label focuses it.
  let forId = null;
  if (control instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)) {
    if (!control.id) control.id = `f${++fieldSeq}`;
    forId = control.id;
  }
  return h('div', { class: 'field' }, h('label', { for: forId }, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

export function toggle(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', checked, 'aria-label': label, onChange: e => onChange(e.target.checked) });
  return h('label', { class: 'switch' }, input, h('span'));
}

export function empty(iconName, title, text, action) {
  return h('div', { class: 'empty' }, icon(iconName, 36), h('h3', null, title), text ? h('p', null, text) : null, action || null);
}

export function loading() {
  return h('div', { class: 'loading-page' }, h('div', { class: 'spinner' }));
}

export function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

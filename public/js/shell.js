// App chrome: sidebar navigation, topbar (search, notifications, theme, account) and page container.
import { h, icon, mount, popover, closePopover, timeAgo, menu, toast } from './ui.js';
import { store } from './store.js';
import { api } from './api.js';
import { navigate, currentPath } from './router.js';
import { openPalette } from './palette.js';
import { TYPE_ICON } from './icons.js';

let content, titleEl, navEl, bellDot, shellEl, connBadge;

export function getTheme() {
  try { return localStorage.getItem('omni-theme') || 'system'; } catch { return 'system'; }
}

export function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('omni-theme', t); } catch {}
}

function navLink(path, label, iconName, extra) {
  const a = h('a', { href: '#' + path, dataset: { path } }, icon(iconName, 17), h('span', { class: 'ellipsis' }, label), extra || null);
  return a;
}

function renderNav() {
  const svcList = Object.values(store.services).sort((a, b) => a.name.localeCompare(b.name));
  const svcLinks = svcList.slice(0, 30).map(s => {
    const a = h('a', { href: `#/services/${encodeURIComponent(s.id)}`, dataset: { path: `/services/${s.id}`, prefix: '1' } },
      h('span', { class: ['status-dot', (s.state && s.state.status) || 'OFFLINE'] }),
      h('span', { class: 'ellipsis' }, s.name));
    return a;
  });
  const admin = store.can('admin');
  mount(navEl,
    navLink('/', 'Overview', 'dashboard'),
    navLink('/services', 'Services', 'server', h('span', { class: 'count' }, String(svcList.length))),
    svcLinks.length ? h('div', { class: 'nav-services' }, svcLinks) : null,
    h('div', { class: 'nav-section' }, 'Platform'),
    navLink('/domains', 'Domains', 'globe'),
    navLink('/env-groups', 'Shared variables', 'key'),
    navLink('/monitoring', 'Monitoring & alerts', 'activity'),
    admin ? navLink('/data', 'Data store', 'database') : null,
    h('div', { class: 'nav-section' }, 'Account'),
    admin ? navLink('/users', 'Users & invites', 'users') : null,
    admin ? navLink('/audit', 'Audit log', 'list') : null,
    admin ? navLink('/settings', 'Panel settings', 'settings') : null,
    navLink('/account', 'My account', 'user'),
    navLink('/docs', 'API reference', 'book'));
  highlightNav();
}

function highlightNav() {
  if (!navEl) return;
  const path = currentPath();
  let best = null;
  for (const a of navEl.querySelectorAll('a')) {
    a.classList.remove('active');
    const p = a.dataset.path;
    const match = p === path || (p !== '/' && path.startsWith(p + '/')) || (p !== '/' && path === p);
    if (match && (!best || p.length > best.dataset.path.length)) best = a;
  }
  if (best) best.classList.add('active');
}

function notifIcon(level) {
  return h('span', { class: `notif-icon lvl-${level}` }, icon({ error: 'alert', warning: 'alert', success: 'check' }[level] || 'info', 15));
}

async function openNotifications(anchor) {
  const list = h('div', null, h('div', { class: 'menu-head' }, 'Loading…'));
  const pop = popover(anchor, list, { width: 360 });
  try {
    const items = await api.get('/api/system/notifications');
    store.notifications = items;
    mount(list,
      h('div', { class: 'row between menu-head' }, h('strong', null, 'Notifications'),
        h('button', { class: 'btn ghost sm', onClick: async () => { await api.post('/api/system/notifications/read', {}); store.unread = 0; updateBell(); closePopover(); } }, 'Mark all read')),
      items.length ? items.slice(0, 40).map(n => h('div', {
        class: ['notif', n.read ? '' : 'unread'], style: { cursor: n.serviceId ? 'pointer' : 'default' },
        onClick: () => { if (n.serviceId && store.services[n.serviceId]) { closePopover(); navigate(`/services/${n.serviceId}/console`); } }
      },
      notifIcon(n.level),
      h('div', { class: 'grow' },
        h('div', { class: 'notif-title' }, (n.serviceId && store.services[n.serviceId] ? store.services[n.serviceId].name + ' · ' : '') + n.title),
        n.message ? h('div', { class: 'notif-msg' }, n.message) : null,
        h('div', { class: 'notif-time' }, timeAgo(n.at))))) : h('div', { class: 'menu-head' }, 'Nothing yet. Crashes, deploys and alerts show up here.'),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', onClick: () => { closePopover(); navigate('/monitoring'); } }, icon('settings', 15), 'Alert settings'));
  } catch (e) {
    mount(list, h('div', { class: 'menu-head' }, e.message));
  }
  return pop;
}

function updateBell() {
  if (!bellDot) return;
  bellDot.textContent = store.unread > 99 ? '99+' : String(store.unread);
  bellDot.classList.toggle('hidden', store.unread <= 0);
}

function userMenu(anchor) {
  const t = getTheme();
  menu(anchor, [
    { label: `${store.user.username} (${store.user.role})`, icon: 'user', onClick: () => navigate('/account') },
    '-',
    { label: `Theme: system${t === 'system' ? ' ✓' : ''}`, icon: 'monitor', onClick: () => setTheme('system') },
    { label: `Theme: dark${t === 'dark' ? ' ✓' : ''}`, icon: 'moon', onClick: () => setTheme('dark') },
    { label: `Theme: light${t === 'light' ? ' ✓' : ''}`, icon: 'sun', onClick: () => setTheme('light') },
    '-',
    { label: 'Keyboard shortcuts', icon: 'zap', onClick: () => window.dispatchEvent(new Event('show-shortcuts')) },
    { label: 'Sign out', icon: 'logout', danger: true, onClick: async () => { await api.post('/api/auth/logout'); location.hash = '#/'; location.reload(); } }
  ]);
}

export function renderShell(root) {
  content = h('main', { class: 'content', id: 'content', tabindex: '-1' });
  titleEl = h('div', { class: 'title crumbs' });
  navEl = h('nav', { class: 'nav', 'aria-label': 'Main' });
  bellDot = h('span', { class: 'dot hidden' });
  connBadge = h('span', { class: 'badge warning hidden', title: 'Live connection lost — reconnecting' }, 'Reconnecting…');
  const bell = h('button', { class: 'icon-btn', 'aria-label': 'Notifications', onClick: e => openNotifications(e.currentTarget) }, icon('bell', 18), bellDot);
  const userBtn = h('button', { class: 'icon-btn', 'aria-label': 'Account menu', onClick: e => userMenu(e.currentTarget) }, icon('user', 18));
  shellEl = h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, icon('rocket', 17)), 'OmniHost'),
      navEl,
      h('div', { class: 'sidebar-footer' }, store.info ? `v${store.info.version}` : '', store.info && store.info.production ? ' · production' : ' · local')),
    h('div', { class: 'backdrop', onClick: () => shellEl.classList.remove('nav-open') }),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'Open menu', onClick: () => shellEl.classList.toggle('nav-open') }, icon('menu', 18)),
        titleEl,
        h('div', { class: 'spacer' }),
        connBadge,
        h('button', { class: 'search-btn', onClick: openPalette, 'aria-label': 'Search' }, icon('search', 15), h('span', { class: 'label' }, 'Search or jump to…'), h('kbd', null, 'Ctrl K')),
        bell, userBtn),
      content));
  mount(root, shellEl);
  renderNav();
  updateBell();
  store.on('services', renderNav);
  store.on('state', ({ id, state }) => {
    const dot = navEl.querySelector(`a[data-path="/services/${CSS.escape(id)}"] .status-dot`);
    if (dot) dot.className = `status-dot ${state.status}`;
  });
  store.on('notification', n => {
    updateBell();
    const svc = n.serviceId && store.services[n.serviceId];
    const text = `${svc ? svc.name + ': ' : ''}${n.title}`;
    if (n.level === 'error' || n.level === 'warning') toast(text, n.level);
    // Optional desktop notifications while the dashboard tab is in the background.
    if (document.hidden && desktopNotificationsEnabled() && n.level !== 'info') {
      try {
        const note = new Notification(text, { body: n.message ? n.message.slice(0, 180) : '', icon: '/icons/icon.svg', tag: n.id });
        note.onclick = () => { window.focus(); if (svc) navigate(`/services/${svc.id}/console`); note.close(); };
      } catch {}
    }
  });
  store.on('connection', ok => connBadge.classList.toggle('hidden', ok));
  window.addEventListener('routechange', () => { highlightNav(); shellEl.classList.remove('nav-open'); });
}

// Pages call this to set the header and get a fresh content element.
export function page(crumbs) {
  closePopover();
  const parts = (Array.isArray(crumbs) ? crumbs : [crumbs]).filter(Boolean);
  mount(titleEl, ...parts.flatMap((c, i) => {
    const el = typeof c === 'string' ? h('span', { class: 'ellipsis' }, c) : h('a', { href: '#' + c.href, class: 'ellipsis' }, c.label);
    return i < parts.length - 1 ? [el, h('span', { class: 'faint' }, '/')] : [el];
  }));
  document.title = `${parts.map(c => (typeof c === 'string' ? c : c.label)).pop() || 'OmniHost'} · OmniHost`;
  mount(content);
  content.scrollTop = 0;
  window.scrollTo(0, 0);
  return content;
}

export function serviceIcon(type, size = 18) {
  return h('div', { class: ['svc-icon', type] }, icon(TYPE_ICON[type] || 'server', size));
}

export function desktopNotificationsEnabled() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try { return localStorage.getItem('omni-desktop-notify') === '1'; } catch { return false; }
}

export async function setDesktopNotifications(on) {
  if (on) {
    if (!('Notification' in window)) throw new Error('This browser does not support desktop notifications');
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked for this site in your browser settings');
  }
  try { localStorage.setItem('omni-desktop-notify', on ? '1' : '0'); } catch {}
}

export function setUnread(n) {
  store.unread = n;
  updateBell();
}

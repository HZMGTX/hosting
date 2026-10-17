// OmniHost dashboard entry point: auth gate, data bootstrap, routes, realtime connection.
import { h, mount, modal, loading } from './ui.js';
import { api, setUnauthorizedHandler } from './api.js';
import { store } from './store.js';
import { route, startRouter, currentPath } from './router.js';
import * as ws from './ws.js';
import { renderShell, getTheme, setTheme, setUnread } from './shell.js';
import { showSetup, showLogin, showInvite } from './pages/auth.js';
import { overviewPage } from './pages/overview.js';
import { servicesPage, newServicePage } from './pages/services.js';
import { servicePage } from './pages/service.js';
import { domainsPage, envGroupsPage, monitoringPage, dataPage, panelSettingsPage, docsPage } from './pages/platform.js';
import { usersPage, auditPage, accountPage } from './pages/people.js';

const root = document.getElementById('app');
setTheme(getTheme());

let booted = false;
setUnauthorizedHandler(() => {
  if (!booted) return;
  booted = false;
  ws.disconnect();
  store.user = null;
  gate();
});

async function bootstrap() {
  mount(root, loading());
  const [info, services, notifications] = await Promise.all([
    api.get('/api/system/info'),
    api.get('/api/services'),
    api.get('/api/system/notifications')
  ]);
  store.info = info;
  store.setServices(services);
  store.notifications = notifications;
  renderShell(root);
  setUnread(notifications.filter(n => !n.read).length);
  ws.connect();
  if (!booted) {
    booted = true;
    if (!routesRegistered) registerRoutes();
    startRouter();
  }
}

let routesRegistered = false;
function registerRoutes() {
  routesRegistered = true;
  route('/', overviewPage);
  route('/services', servicesPage);
  route('/services/new', newServicePage);
  route('/services/:id', p => servicePage({ id: p.id }));
  route('/services/:id/:tab', p => servicePage(p));
  route('/domains', domainsPage);
  route('/env-groups', envGroupsPage);
  route('/monitoring', monitoringPage);
  route('/data', dataPage);
  route('/users', usersPage);
  route('/audit', auditPage);
  route('/account', accountPage);
  route('/settings', panelSettingsPage);
  route('/docs', docsPage);
  route('/invite/:code', () => { location.hash = '#/'; });
}

async function gate() {
  const invite = currentPath().match(/^\/invite\/([^/]+)$/);
  let status;
  try { status = await api.get('/api/auth/status'); } catch (e) {
    return mount(root, h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' }, h('h1', null, 'Cannot reach OmniHost'), h('p', { class: 'lead' }, e.message), h('button', { class: 'btn primary', onClick: gate }, 'Retry'))));
  }
  const onAuthed = async () => {
    const s = await api.get('/api/auth/status');
    store.user = s.user;
    if (location.hash.startsWith('#/invite/')) location.hash = '#/';
    if (booted) location.reload();
    else bootstrap();
  };
  if (status.setupRequired) return showSetup(root, onAuthed);
  if (!status.user) {
    if (invite) return showInvite(root, decodeURIComponent(invite[1]), onAuthed);
    return showLogin(root, onAuthed);
  }
  store.user = status.user;
  bootstrap();
}

// Keyboard shortcuts help.
function showShortcuts() {
  const rows = [['Ctrl/⌘ K', 'Search & jump anywhere'], ['?', 'This help'], ['Ctrl/⌘ S', 'Save file (editor)'], ['Ctrl/⌘ F', 'Find in file'], ['Ctrl/⌘ H', 'Find & replace'], ['Ctrl/⌘ G', 'Go to line'], ['Ctrl/⌘ /', 'Toggle comment'], ['Tab / Shift+Tab', 'Indent / outdent'], ['↑ / ↓ in console', 'Command history'], ['Esc', 'Close dialogs']];
  modal({ title: 'Keyboard shortcuts', body: h('dl', { class: 'kv' }, rows.flatMap(([k, d]) => [h('dt', null, h('kbd', null, k)), h('dd', null, d)])) });
}
window.addEventListener('show-shortcuts', showShortcuts);
document.addEventListener('keydown', e => {
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (!typing && e.key === '?' && store.user) { e.preventDefault(); showShortcuts(); }
});

store.on('notification-read', () => setUnread(0));

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

gate();

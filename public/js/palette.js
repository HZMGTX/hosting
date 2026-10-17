// Command palette (Ctrl/⌘+K): jump to services, pages and actions.
import { h, icon, modal, mount } from './ui.js';
import { store } from './store.js';
import { navigate } from './router.js';
import { TYPE_ICON } from './icons.js';

const PAGES = [
  ['Overview', '/', 'dashboard'], ['Services', '/services', 'server'], ['New service', '/services/new', 'plus'],
  ['Domains', '/domains', 'globe'], ['Shared variables', '/env-groups', 'key'], ['Monitoring & alerts', '/monitoring', 'activity'],
  ['Data store', '/data', 'database', 'admin'], ['Users & invites', '/users', 'users', 'admin'], ['Audit log', '/audit', 'list', 'admin'],
  ['Panel settings', '/settings', 'settings', 'admin'], ['My account', '/account', 'user'], ['API reference', '/docs', 'book']
];
const TABS = [['console', 'Console'], ['files', 'Files'], ['env', 'Environment'], ['deploy', 'Deploy'], ['packages', 'Packages'], ['metrics', 'Metrics'], ['backups', 'Backups'], ['schedules', 'Schedules'], ['database', 'Database'], ['settings', 'Settings']];

function items() {
  const out = [];
  for (const [label, path, ic, perm] of PAGES) if (!perm || store.can(perm)) out.push({ label, hint: 'Page', icon: ic, run: () => navigate(path) });
  for (const s of Object.values(store.services)) {
    out.push({ label: s.name, hint: `${s.type} · ${(s.state && s.state.status) || ''}`, icon: TYPE_ICON[s.type] || 'server', run: () => navigate(`/services/${s.id}`) });
    for (const [tab, label] of TABS) out.push({ label: `${s.name} → ${label}`, hint: 'Service tab', icon: 'chevron', run: () => navigate(`/services/${s.id}/${tab}`), secondary: true });
  }
  return out;
}

function score(item, q) {
  const label = item.label.toLowerCase();
  if (!q) return item.secondary ? -1 : 1;
  if (label.startsWith(q)) return 3;
  if (label.includes(q)) return 2;
  // fuzzy: all characters in order
  let i = 0;
  for (const ch of label) if (ch === q[i]) i++;
  return i === q.length ? 1 : -1;
}

export function openPalette() {
  if (document.querySelector('.palette')) return;
  const all = items();
  const input = h('input', { class: 'input', placeholder: 'Jump to a service, page or tab…', 'aria-label': 'Search' });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  let results = [];
  let active = 0;
  const m = modal({ body: h('div', null, input, list), className: 'palette' });
  m.box.querySelector('.modal-body').style.padding = '0';

  function render() {
    const q = input.value.trim().toLowerCase();
    results = all.map(it => ({ it, s: score(it, q) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 40).map(x => x.it);
    active = Math.min(active, Math.max(0, results.length - 1));
    mount(list, results.length ? results.map((it, i) => h('div', {
      class: ['palette-item', i === active ? 'active' : ''], role: 'option',
      onMousemove: () => { if (active !== i) { active = i; render(); } },
      onClick: () => { m.close(); it.run(); }
    }, icon(it.icon, 16), h('span', { class: 'ellipsis' }, it.label), h('span', { class: 'hint' }, it.hint))) : h('div', { class: 'empty small' }, 'No matches'));
    const el = list.children[active];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(results.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); m.close(); results[active].run(); }
  });
  render();
  setTimeout(() => input.focus(), 20);
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && store.user) { e.preventDefault(); openPalette(); }
});

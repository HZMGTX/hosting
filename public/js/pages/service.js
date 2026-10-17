// Service detail: header with lifecycle controls, diagnostics banner and tabbed sub-pages.
import { h, icon, mount, statusBadge, fmtBytes, fmtDuration, pct, btn, toast, busy, copyField, menu, confirmDialog, empty, loading } from '../ui.js';
import { api, svcUrl } from '../api.js';
import { store } from '../store.js';
import { page, serviceIcon } from '../shell.js';
import { navigate, query } from '../router.js';
import * as ws from '../ws.js';
import { consoleTab } from './tabs/console.js';
import { filesTab } from './tabs/files.js';
import { envTab } from './tabs/env.js';
import { deployTab } from './tabs/deploy.js';
import { packagesTab } from './tabs/packages.js';
import { metricsTab } from './tabs/metrics.js';
import { backupsTab } from './tabs/backups.js';
import { schedulesTab } from './tabs/schedules.js';
import { discordTab } from './tabs/discord.js';
import { databaseTab } from './tabs/database.js';
import { settingsTab } from './tabs/settings.js';
import { openAiAssistant } from './tabs/ai.js';

const TABS = [
  ['console', 'Console', 'terminal', consoleTab],
  ['files', 'Files', 'folder', filesTab],
  ['env', 'Environment', 'key', envTab],
  ['deploy', 'Deploy', 'git', deployTab],
  ['packages', 'Packages', 'package', packagesTab],
  ['discord', 'Discord', 'discord', discordTab, s => s.type === 'discord'],
  ['metrics', 'Metrics', 'chart', metricsTab],
  ['backups', 'Backups', 'archive', backupsTab],
  ['schedules', 'Schedules', 'clock', schedulesTab],
  ['database', 'Database', 'database', databaseTab],
  ['settings', 'Settings', 'settings', settingsTab]
];

export function publicUrl(s) {
  if (s.type !== 'web' && s.type !== 'static') return null;
  return `${location.origin}/apps/${encodeURIComponent(s.id)}/`;
}

function diagnosticsBanner(svc, holder) {
  const list = (store.services[svc.id] && store.services[svc.id].diagnostics) || [];
  if (!list.length) return mount(holder);
  const latest = list.slice(-3).reverse();
  mount(holder, latest.map(d => h('div', { class: ['callout', d.level === 'warning' ? 'warning' : 'error'] },
    h('span', { class: d.level === 'warning' ? 'lvl-warning' : 'lvl-error' }, icon('wrench', 18)),
    h('div', { class: 'callout-body' }, h('strong', null, d.title), h('p', null, d.explain)),
    h('div', { class: 'btn-group' },
      d.action && store.can('edit', svc.id) ? actionButton(svc, d) : null,
      svc.aiEnabled && store.can('edit', svc.id) ? btn('Ask AI', { size: 'sm', icon: 'sparkles', onClick: () => openAiAssistant(svc) }) : null,
      btn('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Dismiss', onClick: async () => {
        await api.del(svcUrl(svc.id, `/diagnostics/${encodeURIComponent(d.id)}`));
        const s = store.services[svc.id];
        s.diagnostics = s.diagnostics.filter(x => x.id !== d.id);
        diagnosticsBanner(svc, holder);
      } })))));
}

function actionButton(svc, d) {
  const a = d.action;
  const b = btn(a.label, { size: 'sm', variant: 'primary' });
  b.addEventListener('click', busy(b, async () => {
    switch (a.type) {
      case 'open-env': navigate(`/services/${svc.id}/env?focus=${encodeURIComponent(a.key || '')}`); break;
      case 'open-tab': navigate(`/services/${svc.id}/${a.tab}`); break;
      case 'open-url': window.open(a.url, '_blank', 'noopener'); break;
      case 'open-file': navigate(`/services/${svc.id}/files?path=${encodeURIComponent(a.path)}&line=${a.line || 1}`); break;
      case 'install-package': {
        toast(`Installing ${a.name}… watch the console`, 'info');
        const r = await api.post(svcUrl(svc.id, '/packages'), { name: a.name });
        if (r.ok) {
          toast(`${a.name} installed`, 'success');
          await api.del(svcUrl(svc.id, `/diagnostics/${encodeURIComponent(d.id)}`));
          if (['CRASHED', 'RESTARTING', 'OFFLINE'].includes((store.services[svc.id].state || {}).status)) await api.post(svcUrl(svc.id, '/start'));
        } else toast(`Install failed (code ${r.code}) — see the console`, 'error');
        break;
      }
    }
  }));
  return b;
}

export async function servicePage({ id, tab = 'console' }) {
  const base = store.services[id];
  const el = page([{ label: 'Services', href: '/services' }, base ? base.name : id]);
  mount(el, loading());
  let svc;
  try { svc = await api.get(svcUrl(id)); } catch (e) {
    return mount(el, empty('alert', 'Service not available', e.message, btn('Back to services', { onClick: () => navigate('/services') })));
  }
  store.upsertService(svc);
  const tabs = TABS.filter(t => !t[4] || t[4](svc));
  if (!tabs.find(t => t[0] === tab)) return navigate(`/services/${id}`, { replace: true });

  const unsub = ws.subscribe(id);
  const cleanups = [unsub];

  const statusHolder = h('span');
  const metaHolder = h('div', { class: 'svc-meta' });
  const controls = h('div', { class: 'btn-group' });
  const diagHolder = h('div');
  const subtitle = h('div', { class: 'small muted' });
  const renderSubtitle = () => {
    const s = store.services[id];
    subtitle.textContent = `${s.id} · ${s.type} · ${s.runtime === 'custom' ? s.command || 'custom command' : s.entry}`;
  };
  renderSubtitle();
  const tabBody = h('div');

  function renderMeta() {
    const s = store.services[id];
    const st = s.state || {};
    mount(metaHolder,
      h('span', { title: 'CPU' }, icon('cpu', 13), ' ', st.status === 'ONLINE' ? pct(st.cpu) : '—'),
      h('span', { title: 'Memory' }, icon('hardDrive', 13), ' ', st.status === 'ONLINE' ? fmtBytes(st.memory) + (s.memoryLimitMb ? ` / ${s.memoryLimitMb} MB` : '') : '—'),
      h('span', { title: 'Uptime' }, icon('clock', 13), ' ', st.status === 'ONLINE' ? fmtDuration(st.uptimeMs || (st.startedAt ? Date.now() - st.startedAt : 0)) : '—'),
      h('span', { title: 'Restarts' }, icon('restart', 13), ' ', String(st.restarts || 0)),
      st.nextRestartAt ? h('span', { class: 'lvl-warning' }, `restarting in ${Math.max(0, Math.round((st.nextRestartAt - Date.now()) / 1000))}s`) : null);
  }

  function renderHeader() {
    const s = store.services[id];
    const st = s.state || {};
    mount(statusHolder, statusBadge(st.status || 'OFFLINE'));
    renderMeta();
    const running = ['ONLINE', 'STARTING', 'RESTARTING', 'INSTALLING', 'BUILDING'].includes(st.status);
    const canOp = store.can('operate', id);
    const start = btn('Start', { variant: 'success', icon: 'play', disabled: !canOp || running });
    start.addEventListener('click', busy(start, () => api.post(svcUrl(id, '/start'))));
    const restart = btn('Restart', { icon: 'restart', disabled: !canOp || st.status === 'STOPPING' });
    restart.addEventListener('click', busy(restart, () => api.post(svcUrl(id, '/restart'))));
    const stop = btn('Stop', { variant: 'danger', icon: 'stop', disabled: !canOp || (!running && st.status !== 'STOPPING') });
    stop.addEventListener('click', busy(stop, () => api.post(svcUrl(id, '/stop'))));
    const more = btn('', { icon: 'more', variant: 'ghost', title: 'More actions' });
    more.addEventListener('click', () => menu(more, [
      { label: 'Install dependencies', icon: 'package', disabled: !store.can('edit', id), onClick: async () => { toast('Installing… watch the console', 'info'); const r = await api.post(svcUrl(id, '/install')); toast(r.ok ? 'Dependencies installed' : 'Install failed — see console', r.ok ? 'success' : 'error'); } },
      { label: 'Create backup', icon: 'archive', disabled: !store.can('edit', id), onClick: async () => { await api.post(svcUrl(id, '/backups'), {}); toast('Backup created', 'success'); } },
      { label: 'Download all files', icon: 'download', onClick: () => { location.href = svcUrl(id, '/files/download?path='); } },
      { label: 'Export (code + settings)', icon: 'archive', disabled: !store.can('edit', id), onClick: () => { location.href = svcUrl(id, '/export'); } },
      { label: 'Duplicate…', icon: 'copy', disabled: !store.can('create'), onClick: () => navigate(`/services/${id}/settings`) },
      svc.buildCommand ? { label: 'Run build', icon: 'wrench', disabled: !store.can('edit', id), onClick: async () => { toast('Building… watch the console', 'info'); const r = await api.post(svcUrl(id, '/build')); toast(r.ok ? 'Build finished' : 'Build failed — see console', r.ok ? 'success' : 'error'); } } : null,
      svc.aiEnabled ? { label: 'Ask AI about errors', icon: 'sparkles', disabled: !store.can('edit', id), onClick: () => openAiAssistant(svc) } : null,
      '-',
      { label: 'Delete service…', icon: 'trash', danger: true, disabled: !store.can('delete', id), onClick: () => navigate(`/services/${id}/settings?delete=1`) }
    ].filter(Boolean)));
    mount(controls, start, restart, stop, more);
  }

  const url = publicUrl(svc);
  mount(el,
    h('div', { class: 'card mb' },
      h('div', { class: 'row between wrap gap-lg' },
        h('div', { class: 'row', style: { minWidth: 0, gap: '0.85rem' } }, serviceIcon(svc.type, 20),
          h('div', { style: { minWidth: 0 } },
            h('div', { class: 'row wrap' }, h('h1', { class: 'ellipsis' }, svc.name), statusHolder),
            subtitle)),
        controls),
      h('div', { class: 'row between wrap mt-sm' }, metaHolder,
        url ? h('div', { class: 'row small', style: { minWidth: 0, maxWidth: '100%' } }, icon('globe', 14),
          h('a', { href: url, target: '_blank', rel: 'noopener', class: 'ellipsis' }, url.replace(/^https?:\/\//, '')),
          ...(svc.domains || []).map(d => h('a', { href: `https://${d.name}`, target: '_blank', rel: 'noopener', class: 'badge info' }, d.name))) : null)),
    diagHolder,
    h('nav', { class: 'tabs', 'aria-label': 'Service sections' }, tabs.map(([key, label, ic]) =>
      h('a', { href: `#/services/${encodeURIComponent(id)}/${key}`, class: key === tab ? 'active' : '' }, icon(ic, 15), label))),
    tabBody);

  renderHeader();
  diagnosticsBanner(svc, diagHolder);
  // Stats arrive every 2s and only touch the meta line; controls re-render on status changes only.
  let lastStatus = (store.services[id].state || {}).status;
  cleanups.push(store.on(`state:${id}`, st => {
    if (st.status !== lastStatus) { lastStatus = st.status; renderHeader(); } else renderMeta();
  }));
  cleanups.push(store.on(`diagnostics:${id}`, () => diagnosticsBanner(store.services[id], diagHolder)));
  cleanups.push(store.on(`service:${id}`, renderSubtitle));
  const ticker = setInterval(renderMeta, 1000);
  cleanups.push(() => clearInterval(ticker));

  const def = tabs.find(t => t[0] === tab);
  const tabCleanup = await def[3](tabBody, svc, query());
  if (typeof tabCleanup === 'function') cleanups.push(tabCleanup);
  return () => cleanups.forEach(fn => { try { fn(); } catch {} });
}

export { confirmDialog };

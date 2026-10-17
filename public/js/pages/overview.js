// Overview dashboard: host resources, service health, recent events.
import { h, icon, mount, statusBadge, fmtBytes, fmtDuration, timeAgo, pct, empty, btn } from '../ui.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { page, serviceIcon } from '../shell.js';
import { navigate } from '../router.js';

function meter(value, max) {
  const p = max ? Math.min(100, (value / max) * 100) : 0;
  return h('div', { class: ['meter', p > 90 ? 'bad' : p > 75 ? 'warn' : ''] }, h('span', { style: { width: p + '%' } }));
}

function stat(label, value, sub, extra) {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null, extra || null);
}

// Getting-started checklist; hidden once everything is done or the user dismisses it.
function checklist() {
  let dismissed = false;
  try { dismissed = localStorage.getItem('omni-checklist-dismissed') === '1'; } catch {}
  const box = h('div');
  if (dismissed) return box;
  (async () => {
    const steps = [
      { done: Object.keys(store.services).length > 0, label: 'Create your first service', href: '#/services/new' },
      { done: !!store.user.twoFactor, label: 'Turn on two-factor login', href: '#/account' }
    ];
    if (store.can('admin')) {
      const [settings, monitors] = await Promise.all([api.get('/api/system/settings').catch(() => null), api.get('/api/monitors').catch(() => [])]);
      if (settings) steps.push({ done: !!(settings.alerts.discordWebhook || settings.alerts.httpWebhook), label: 'Send crash alerts to Discord', href: '#/monitoring' });
      steps.push({ done: monitors.length > 0, label: 'Add an uptime monitor for a website or server', href: '#/monitoring' });
    }
    steps.push({ done: !!(store.info && store.info.production), label: 'Put OmniHost online (Railway) so bots run while your PC is off', href: '#/settings' });
    const left = steps.filter(s => !s.done).length;
    if (!left) return;
    mount(box, h('div', { class: 'card mb' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', null, icon('rocket', 18), 'Getting started'), h('p', null, `${steps.length - left} of ${steps.length} done`)),
        btn('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Hide', onClick: () => { try { localStorage.setItem('omni-checklist-dismissed', '1'); } catch {} mount(box); } })),
      h('div', { class: 'meter mb' }, h('span', { style: { width: `${((steps.length - left) / steps.length) * 100}%` } })),
      h('div', { class: 'list' }, steps.map(s => h('a', { class: 'list-item', href: s.href, style: { color: 'inherit', textDecoration: 'none' } },
        h('span', { class: s.done ? 'lvl-success' : 'faint' }, icon(s.done ? 'check' : 'chevron', 16)),
        h('span', { class: 'grow', style: { textDecoration: s.done ? 'line-through' : 'none', opacity: s.done ? 0.6 : 1 } }, s.label))))));
  })();
  return box;
}

export async function overviewPage() {
  const el = page('Overview');
  const checklistEl = checklist();
  let timer;
  async function load() {
    let d;
    try { d = await api.get('/api/system/overview'); } catch (e) { return mount(el, h('div', { class: 'callout error' }, h('div', { class: 'callout-body' }, e.message))); }
    const hst = d.host;
    const memUsed = hst.memTotal - hst.memFree;
    const diskUsed = hst.disk ? hst.disk.total - hst.disk.free : null;
    mount(el,
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, `Welcome back, ${store.user.username}`), h('p', null, `${d.counts.online} of ${d.counts.total} services online${d.counts.crashed ? ` · ${d.counts.crashed} crashed` : ''}`)),
        store.can('create') ? btn('New service', { variant: 'primary', icon: 'plus', onClick: () => navigate('/services/new') }) : null),
      checklistEl,
      h('div', { class: 'grid cols-4 mb' },
        stat('Services online', `${d.counts.online}/${d.counts.total}`, Object.entries(d.counts.byType).map(([t, n]) => `${n} ${t}`).join(' · ') || 'none yet'),
        stat('Host CPU', pct(hst.cpuPercent), `${hst.cpus} cores · load ${hst.load.map(l => l.toFixed(2)).join(' ')}`, meter(hst.cpuPercent, 100)),
        stat('Host memory', fmtBytes(memUsed), `of ${fmtBytes(hst.memTotal)}`, meter(memUsed, hst.memTotal)),
        stat('Disk', diskUsed !== null ? fmtBytes(diskUsed) : '—', hst.disk ? `${fmtBytes(hst.disk.free)} free` : 'unavailable', hst.disk ? meter(diskUsed, hst.disk.total) : null)),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card flush' },
          h('div', { class: 'card-head' }, h('h2', null, icon('server', 18), 'Services'), h('a', { href: '#/services', class: 'small' }, 'View all')),
          d.services.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Status'), h('th', null, 'CPU'), h('th', null, 'Memory'), h('th', null, 'Uptime 24h'))),
            h('tbody', null, d.services.map(s => h('tr', { class: 'clickable', onClick: () => navigate(`/services/${s.id}`) },
              h('td', null, h('div', { class: 'row' }, serviceIcon(s.type, 15), h('span', { class: 'ellipsis' }, s.name))),
              h('td', null, statusBadge(s.status)),
              h('td', { class: 'mono small' }, s.status === 'ONLINE' ? pct(s.cpu) : '—'),
              h('td', { class: 'mono small' }, s.status === 'ONLINE' ? fmtBytes(s.memory) : '—'),
              h('td', { class: 'mono small' }, pct(s.uptime24h)))))))
            : empty('rocket', 'No services yet', 'Deploy a Discord bot, website or worker in under a minute.',
              store.can('create') ? btn('Create your first service', { variant: 'primary', icon: 'plus', onClick: () => navigate('/services/new') }) : null)),
        h('div', { class: 'col gap-lg' },
          h('div', { class: 'card' },
            h('div', { class: 'card-head' }, h('h2', null, icon('bell', 18), 'Recent events')),
            d.notifications.length ? h('div', { class: 'list' }, d.notifications.map(n => h('div', { class: 'list-item' },
              h('span', { class: `lvl-${n.level}` }, icon(n.level === 'error' || n.level === 'warning' ? 'alert' : n.level === 'success' ? 'check' : 'info', 15)),
              h('div', { class: 'grow' },
                h('div', { class: 'small', style: { fontWeight: 600 } }, (n.serviceId && store.services[n.serviceId] ? store.services[n.serviceId].name + ' · ' : '') + n.title),
                h('div', { class: 'tiny faint' }, timeAgo(n.at))))))
              : h('p', { class: 'muted small' }, 'No events yet. Crashes, recoveries and deploys appear here.')),
          h('div', { class: 'card' },
            h('div', { class: 'card-head' }, h('h2', null, icon('monitor', 18), 'Host')),
            h('dl', { class: 'kv' },
              h('dt', null, 'System'), h('dd', null, `${hst.platform} (${hst.arch})`),
              h('dt', null, 'Node.js'), h('dd', null, hst.node),
              h('dt', null, 'Host uptime'), h('dd', null, fmtDuration(hst.uptime * 1000)),
              h('dt', null, 'Panel uptime'), h('dd', null, fmtDuration(hst.panelUptime * 1000)),
              h('dt', null, 'Panel memory'), h('dd', null, fmtBytes(hst.panelMemory)),
              h('dt', null, 'AI assistant'), h('dd', null, d.features.ai ? 'Enabled' : 'Off (set ANTHROPIC_API_KEY)'),
              h('dt', null, 'Status page'), h('dd', null, d.features.statusPage ? h('a', { href: '/status', target: '_blank', rel: 'noopener' }, '/status') : 'Off'))))));
  }
  await load();
  timer = setInterval(load, 10000);
  return () => clearInterval(timer);
}

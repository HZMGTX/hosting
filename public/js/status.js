// Public status page renderer (no login). Refreshes every 30 seconds.
import { h, mount, icon, pct, timeAgo } from './ui.js';

const root = document.getElementById('status');
const LABEL = { operational: ['Operational', 'success'], degraded: ['Restarting', 'warning'], down: ['Down', 'danger'] };

async function load() {
  let data;
  try {
    const res = await fetch('/api/public/status', { headers: { Accept: 'application/json' } });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Status unavailable');
  } catch (e) {
    return mount(root, h('div', { class: 'empty' }, icon('activity', 36), h('h3', null, 'Status page unavailable'), h('p', null, e.message)));
  }
  document.title = data.title;
  const down = data.services.filter(s => s.status === 'down').length;
  const degraded = data.services.filter(s => s.status === 'degraded').length;
  const summary = !data.services.length ? ['No services are listed yet', 'partial']
    : down ? [`${down} service(s) down`, 'down'] : degraded ? ['Some services are restarting', 'partial'] : ['All systems operational', 'ok'];
  mount(root,
    h('div', { class: 'status-head' }, h('h1', null, data.title),
      h('div', { class: ['status-summary', summary[1]] }, icon(summary[1] === 'ok' ? 'check' : 'alert', 18), summary[0])),
    h('div', { class: 'card' }, data.services.map(s => h('div', { class: 'status-row' },
      h('div', { class: 'top' },
        h('strong', null, s.name),
        h('span', { class: ['badge', LABEL[s.status][1]] }, LABEL[s.status][0])),
      h('div', { class: 'bars', 'aria-label': 'Uptime over the last 7 days' }, s.bars.map(v => h('span', {
        class: v === null ? '' : v >= 99.5 ? 'up' : v >= 90 ? 'partial' : 'down',
        title: v === null ? 'No data' : `${v}% up`
      }))),
      h('div', { class: 'row between tiny muted mt-sm' }, h('span', null, '7 days ago'), h('span', null, `24h: ${pct(s.uptime24h)} · 30d: ${pct(s.uptime30d)}`), h('span', null, 'now'))))),
    h('div', { class: 'status-foot' }, `Updated ${timeAgo(data.updatedAt)} · Powered by OmniHost`));
}

const theme = (() => { try { return localStorage.getItem('omni-theme'); } catch { return null; } })();
if (theme) document.documentElement.setAttribute('data-theme', theme);
load();
setInterval(load, 30000);

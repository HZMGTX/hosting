// Metrics: CPU / memory history, uptime percentages and restart stats.
import { h, icon, mount, pct, fmtDuration, fmtDate } from '../../ui.js';
import { api, svcUrl } from '../../api.js';
import { lineChart } from '../../components/chart.js';

export function metricsTab(root, svc) {
  let range = '1h';
  const cpuCanvas = h('canvas', { class: 'chart', 'aria-label': 'CPU usage chart', role: 'img' });
  const memCanvas = h('canvas', { class: 'chart', 'aria-label': 'Memory usage chart', role: 'img' });
  const upCanvas = h('canvas', { class: 'chart', style: { height: '120px' }, 'aria-label': 'Uptime chart', role: 'img' });
  const stats = h('div', { class: 'grid cols-4 mb' });
  const seg = h('div', { class: 'seg' });
  let data = null;

  function draw() {
    if (!data) return;
    const long = range === '7d' || range === '30d';
    const xf = long ? t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : undefined;
    lineChart(cpuCanvas, { points: data.points, series: [{ key: 'cpu', label: 'CPU', color: '--accent', fill: true }], yFormat: v => `${v.toFixed(v < 10 ? 1 : 0)}%`, xFormat: xf });
    lineChart(memCanvas, { points: data.points, series: [{ key: 'mem', label: 'Memory', color: '--info', fill: true }], yMax: svc.memoryLimitMb ? Math.max(svc.memoryLimitMb, ...data.points.map(p => p.mem)) * 1.05 : undefined, yFormat: v => `${Math.round(v)} MB`, xFormat: xf });
    lineChart(upCanvas, { points: data.points, series: [{ key: 'up', label: 'Up', color: '--success', fill: true }], yMax: 100, yFormat: v => `${Math.round(v)}%`, xFormat: xf });
  }

  async function load() {
    data = await api.get(svcUrl(svc.id, `/metrics?range=${range}`));
    const st = data.state;
    const box = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
    mount(stats,
      box('Uptime 24h', pct(data.uptime['24h']), 'share of samples online'),
      box('Uptime 7d / 30d', `${pct(data.uptime['7d'])} / ${pct(data.uptime['30d'])}`),
      box('Current run', st.status === 'ONLINE' ? fmtDuration(st.uptimeMs) : st.status, st.startedAt ? `since ${fmtDate(st.startedAt)}` : null),
      box('Restarts', String(st.restarts || 0), st.lastExit ? `last exit: ${st.lastExit.signal || 'code ' + st.lastExit.code}` : 'no exits recorded'));
    mount(seg, ['1h', '6h', '24h', '7d', '30d'].map(r => h('button', { class: r === range ? 'active' : '', onClick: () => { range = r; load(); } }, r)));
    draw();
  }

  mount(root,
    stats,
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, icon('cpu', 18), 'CPU'), seg),
      cpuCanvas),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('hardDrive', 18), 'Memory'), svc.memoryLimitMb ? h('span', { class: 'badge' }, `limit ${svc.memoryLimitMb} MB`) : null), memCanvas),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('activity', 18), 'Availability')), upCanvas));

  load().catch(e => mount(stats, h('p', { class: 'lvl-error' }, e.message)));
  const timer = setInterval(() => { if (range === '1h') load().catch(() => {}); }, 10000);
  const ro = new ResizeObserver(() => draw());
  ro.observe(root);
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  mq.addEventListener('change', draw);
  return () => { clearInterval(timer); ro.disconnect(); mq.removeEventListener('change', draw); };
}

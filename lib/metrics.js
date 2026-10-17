// Metric & uptime history per service: 24h at 10s resolution in memory (persisted), 30d hourly rollups.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('../db');
const bus = require('./bus');

const FINE_MS = 10 * 1000;
const FINE_KEEP_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const COARSE_KEEP_MS = 30 * 24 * 3600 * 1000;

const latest = new Map();   // id -> { cpu, memory } from the 2s sampler
const series = new Map();   // id -> { fine: [[t, cpu, memMB, up]], hourly: [[t, cpuAvg, memAvg, upPct, n]] }
let pm = null;              // injected to avoid a require cycle

function file(id) {
  return path.join(config.METRICS_DIR, `${id}.json`);
}

function load(id) {
  let s = series.get(id);
  if (s) return s;
  s = { fine: [], hourly: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    s.fine = Array.isArray(raw.fine) ? raw.fine : [];
    s.hourly = Array.isArray(raw.hourly) ? raw.hourly : [];
  } catch {}
  series.set(id, s);
  return s;
}

function persist() {
  for (const [id, s] of series) {
    if (!db.data.services[id]) continue;
    try { fs.writeFileSync(file(id), JSON.stringify(s)); } catch {}
  }
}

bus.on('stats', stats => {
  for (const [id, v] of Object.entries(stats)) latest.set(id, v);
});

function tick() {
  if (!pm) return;
  const now = Date.now();
  for (const id of Object.keys(db.data.services)) {
    const st = pm.state(id);
    const up = st.status === 'ONLINE' ? 1 : 0;
    const l = up ? (latest.get(id) || { cpu: 0, memory: 0 }) : { cpu: 0, memory: 0 };
    const s = load(id);
    s.fine.push([now, l.cpu || 0, Math.round((l.memory || 0) / 1048576 * 10) / 10, up]);
    while (s.fine.length && s.fine[0][0] < now - FINE_KEEP_MS) s.fine.shift();

    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    let last = s.hourly[s.hourly.length - 1];
    if (!last || last[0] !== hourStart) { last = [hourStart, 0, 0, 0, 0]; s.hourly.push(last); }
    const n = last[4];
    last[1] = (last[1] * n + (l.cpu || 0)) / (n + 1);
    last[2] = (last[2] * n + (l.memory || 0) / 1048576) / (n + 1);
    last[3] = (last[3] * n + up * 100) / (n + 1);
    last[4] = n + 1;
    while (s.hourly.length && s.hourly[0][0] < now - COARSE_KEEP_MS) s.hourly.shift();
  }
}

function init(processManager) {
  pm = processManager;
  setInterval(tick, FINE_MS).unref();
  setInterval(persist, 5 * 60 * 1000).unref();
}

function range(id, which = '1h') {
  const s = load(id);
  const now = Date.now();
  if (which === '30d' || which === '7d') {
    const span = which === '7d' ? 7 * 24 * HOUR_MS : COARSE_KEEP_MS;
    return s.hourly.filter(p => p[0] >= now - span).map(p => ({ t: p[0], cpu: round(p[1]), mem: round(p[2]), up: round(p[3]) }));
  }
  const span = which === '24h' ? FINE_KEEP_MS : which === '6h' ? 6 * HOUR_MS : HOUR_MS;
  let pts = s.fine.filter(p => p[0] >= now - span);
  // Downsample long ranges to ~360 points for the browser.
  const step = Math.max(1, Math.floor(pts.length / 360));
  if (step > 1) pts = pts.filter((_, i) => i % step === 0);
  return pts.map(p => ({ t: p[0], cpu: p[1], mem: p[2], up: p[3] * 100 }));
}

function round(v) {
  return Math.round(v * 10) / 10;
}

// Uptime percentage over a window, from the samples we actually recorded.
function uptime(id, which = '24h') {
  const s = load(id);
  const now = Date.now();
  if (which === '24h') {
    const pts = s.fine.filter(p => p[0] >= now - FINE_KEEP_MS);
    if (!pts.length) return null;
    return round(pts.reduce((a, p) => a + p[3], 0) / pts.length * 100);
  }
  const span = which === '7d' ? 7 * 24 * HOUR_MS : COARSE_KEEP_MS;
  const pts = s.hourly.filter(p => p[0] >= now - span);
  const total = pts.reduce((a, p) => a + p[4], 0);
  if (!total) return null;
  return round(pts.reduce((a, p) => a + p[3] * p[4], 0) / total);
}

// Hourly up/down bars for status pages (last 90 hours/days compressed to 45 buckets).
function uptimeBars(id, buckets = 45) {
  const s = load(id);
  const now = Date.now();
  const span = 7 * 24 * HOUR_MS;
  const size = span / buckets;
  const out = [];
  for (let i = 0; i < buckets; i++) {
    const from = now - span + i * size;
    const pts = s.hourly.filter(p => p[0] >= from - HOUR_MS && p[0] < from + size);
    const total = pts.reduce((a, p) => a + p[4], 0);
    out.push(total ? round(pts.reduce((a, p) => a + p[3] * p[4], 0) / total) : null);
  }
  return out;
}

function remove(id) {
  series.delete(id);
  latest.delete(id);
  fs.rmSync(file(id), { force: true });
}

module.exports = { init, range, uptime, uptimeBars, persist, remove };

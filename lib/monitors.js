// External uptime monitors: HTTP status, keyword-on-page and TCP port checks with alerts and history.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const config = require('./config');
const db = require('../db');
const bus = require('./bus');
const { notify } = require('./notify');
const { httpError } = require('./errors');

const TYPES = ['http', 'keyword', 'tcp'];
const HISTORY_MS = 30 * 24 * 3600 * 1000;
const RECENT = 60;

const state = new Map(); // id -> { status, lastCheckAt, latencyMs, error, failures, recent: [{t, ok, ms}] }
const history = new Map(); // id -> [[hourStart, okCount, total, msSum]]
let timer = null;

function file(id) {
  return path.join(config.METRICS_DIR, `monitor-${id}.json`);
}

function hist(id) {
  if (!history.has(id)) {
    let h = [];
    try { h = JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch {}
    history.set(id, Array.isArray(h) ? h : []);
  }
  return history.get(id);
}

function persist() {
  for (const [id, h] of history) {
    if (db.data.monitors[id]) { try { fs.writeFileSync(file(id), JSON.stringify(h)); } catch {} }
  }
}

function st(id) {
  if (!state.has(id)) state.set(id, { status: 'pending', lastCheckAt: null, latencyMs: null, error: '', failures: 0, recent: [] });
  return state.get(id);
}

function normalize(input, existing = {}) {
  const m = { ...existing, ...input };
  if (!TYPES.includes(m.type)) throw httpError(400, 'Type must be http, keyword or tcp');
  const name = String(m.name || '').trim().slice(0, 80);
  if (!name) throw httpError(400, 'Give the monitor a name');
  const out = {
    id: existing.id || 'm_' + crypto.randomBytes(5).toString('hex'),
    name, type: m.type,
    url: '', host: '', port: null, keyword: '',
    method: m.method === 'HEAD' ? 'HEAD' : 'GET',
    expect: /^\d{3}(-\d{3})?$/.test(String(m.expect || '')) ? String(m.expect) : '200-399',
    intervalSec: Math.max(30, Math.min(3600, parseInt(m.intervalSec, 10) || 60)),
    timeoutSec: Math.max(2, Math.min(60, parseInt(m.timeoutSec, 10) || 10)),
    failuresBeforeAlert: Math.max(1, Math.min(10, parseInt(m.failuresBeforeAlert, 10) || 2)),
    enabled: m.enabled !== false,
    statusPage: !!m.statusPage,
    createdAt: existing.createdAt || new Date().toISOString(),
    createdBy: existing.createdBy || m.createdBy || null
  };
  if (m.type === 'tcp') {
    out.host = String(m.host || '').trim();
    out.port = parseInt(m.port, 10);
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(out.host)) throw httpError(400, 'Enter a host name or IP');
    if (!out.port || out.port < 1 || out.port > 65535) throw httpError(400, 'Port must be 1-65535');
  } else {
    try {
      const u = new URL(String(m.url || '').trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      out.url = u.toString();
    } catch { throw httpError(400, 'Enter a full http:// or https:// URL'); }
    if (m.type === 'keyword') {
      out.keyword = String(m.keyword || '').slice(0, 200);
      if (!out.keyword) throw httpError(400, 'Enter the text that must appear on the page');
    }
  }
  return out;
}

function inRange(code, expect) {
  const [lo, hi] = expect.split('-').map(Number);
  return code >= lo && code <= (hi || lo);
}

async function probe(m) {
  const started = Date.now();
  if (m.type === 'tcp') {
    return new Promise(resolve => {
      const sock = net.connect({ host: m.host, port: m.port, timeout: m.timeoutSec * 1000 });
      const done = (ok, error) => { sock.destroy(); resolve({ ok, ms: Date.now() - started, error }); };
      sock.on('connect', () => done(true, ''));
      sock.on('timeout', () => done(false, 'Timed out'));
      sock.on('error', e => done(false, e.code || e.message));
    });
  }
  try {
    const res = await fetch(m.url, {
      method: m.type === 'keyword' ? 'GET' : m.method, redirect: 'follow',
      headers: { 'User-Agent': 'OmniHost-Monitor/2.0' }, signal: AbortSignal.timeout(m.timeoutSec * 1000)
    });
    if (!inRange(res.status, m.expect)) { res.body && res.body.cancel(); return { ok: false, ms: Date.now() - started, error: `HTTP ${res.status}` }; }
    if (m.type === 'keyword') {
      const text = (await res.text()).slice(0, 2_000_000);
      if (!text.includes(m.keyword)) return { ok: false, ms: Date.now() - started, error: `"${m.keyword}" not found on the page` };
    } else if (res.body) res.body.cancel();
    return { ok: true, ms: Date.now() - started, error: '' };
  } catch (e) {
    const cause = e.cause && (e.cause.code || e.cause.message);
    return { ok: false, ms: Date.now() - started, error: e.name === 'TimeoutError' ? 'Timed out' : cause || e.message };
  }
}

async function check(id) {
  const m = db.data.monitors[id];
  if (!m) return null;
  const s = st(id);
  const r = await probe(m);
  const prev = s.status;
  s.lastCheckAt = new Date().toISOString();
  s.latencyMs = r.ms;
  s.error = r.error;
  s.recent.push({ t: Date.now(), ok: r.ok, ms: r.ms });
  if (s.recent.length > RECENT) s.recent.shift();
  s.failures = r.ok ? 0 : s.failures + 1;

  if (r.ok) s.status = 'up';
  else if (s.failures >= m.failuresBeforeAlert) s.status = 'down';
  else if (prev === 'pending') s.status = 'pending';

  if (prev !== 'down' && s.status === 'down') {
    notify({ level: 'error', event: 'monitor', title: `${m.name} is down`, message: `${m.type === 'tcp' ? `${m.host}:${m.port}` : m.url}\n${r.error}` });
  } else if (prev === 'down' && s.status === 'up') {
    notify({ level: 'success', event: 'monitor', title: `${m.name} is back up`, message: `Responded in ${r.ms} ms` });
  }

  const h = hist(id);
  const hour = Math.floor(Date.now() / 3600000) * 3600000;
  let last = h[h.length - 1];
  if (!last || last[0] !== hour) { last = [hour, 0, 0, 0]; h.push(last); }
  last[1] += r.ok ? 1 : 0;
  last[2] += 1;
  last[3] += r.ms;
  while (h.length && h[0][0] < Date.now() - HISTORY_MS) h.shift();

  bus.emit('monitor', { id, state: view(m) });
  return view(m);
}

function uptime(id, hours) {
  const since = Date.now() - hours * 3600000;
  const rows = hist(id).filter(r => r[0] >= since - 3600000);
  const total = rows.reduce((a, r) => a + r[2], 0);
  return total ? Math.round(rows.reduce((a, r) => a + r[1], 0) / total * 1000) / 10 : null;
}

function bars(id, buckets = 45) {
  const span = 7 * 24 * 3600000;
  const size = span / buckets;
  const now = Date.now();
  const h = hist(id);
  return Array.from({ length: buckets }, (_, i) => {
    const from = now - span + i * size;
    const rows = h.filter(r => r[0] >= from - 3600000 && r[0] < from + size);
    const total = rows.reduce((a, r) => a + r[2], 0);
    return total ? Math.round(rows.reduce((a, r) => a + r[1], 0) / total * 1000) / 10 : null;
  });
}

function view(m) {
  const s = st(m.id);
  return {
    ...m, status: m.enabled ? s.status : 'paused', lastCheckAt: s.lastCheckAt, latencyMs: s.latencyMs, error: s.error,
    recent: s.recent.slice(-30), uptime24h: uptime(m.id, 24), uptime30d: uptime(m.id, 24 * 30), bars: bars(m.id)
  };
}

function list() {
  return Object.values(db.data.monitors).map(view);
}

function create(input, by) {
  const m = normalize({ ...input, createdBy: by });
  db.data.monitors[m.id] = m;
  db.save();
  check(m.id).catch(() => {});
  return view(m);
}

function update(id, input) {
  const existing = db.data.monitors[id];
  if (!existing) throw httpError(404, 'Monitor not found');
  const m = normalize(input, existing);
  db.data.monitors[id] = m;
  db.save();
  return view(m);
}

function remove(id) {
  if (!db.data.monitors[id]) throw httpError(404, 'Monitor not found');
  delete db.data.monitors[id];
  state.delete(id);
  history.delete(id);
  fs.rmSync(file(id), { force: true });
  db.save();
}

function tick() {
  const now = Date.now();
  for (const m of Object.values(db.data.monitors)) {
    if (!m.enabled) continue;
    const s = st(m.id);
    if (s.running) continue;
    const last = s.lastCheckAt ? Date.parse(s.lastCheckAt) : 0;
    if (now - last >= m.intervalSec * 1000) {
      s.running = true;
      check(m.id).catch(() => {}).finally(() => { s.running = false; });
    }
  }
}

function init() {
  if (timer) return;
  timer = setInterval(tick, 5000);
  timer.unref();
  setInterval(persist, 5 * 60 * 1000).unref();
}

module.exports = { init, list, create, update, remove, check, view, persist, TYPES };

// Process lifecycle for hosted services: start/stop/restart, restart policy with backoff,
// crash-loop guard, stdin, real CPU/RAM sampling and health checks.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const pidusage = require('pidusage');
const db = require('../db');
const bus = require('./bus');
const services = require('./services');
const logStore = require('./logStore');
const diagnostics = require('./diagnostics');
const installer = require('./installer');
const exec = require('./exec');
const { notify } = require('./notify');
const { httpError } = require('./errors');

const CRASH_WINDOW_MS = 2 * 60 * 1000;
const CRASH_LOOP_LIMIT = 5;
const STABLE_AFTER_MS = 60 * 1000;
const STOP_GRACE_MS = 5000;

const runtime = new Map(); // id -> state

function rt(id) {
  let r = runtime.get(id);
  if (!r) {
    r = {
      status: 'OFFLINE', child: null, instance: 0, startedAt: null, restarts: 0, consecutiveCrashes: 0,
      crashTimes: [], backoffTimer: null, nextRestartAt: null, manualStop: false, lastExit: null,
      stats: { cpu: 0, memory: 0 }, healthFailures: 0, stopWaiters: []
    };
    runtime.set(id, r);
  }
  return r;
}

function state(id) {
  const r = rt(id);
  return {
    status: r.status,
    pid: r.child ? r.child.pid : null,
    startedAt: r.startedAt,
    uptimeMs: r.startedAt && r.status === 'ONLINE' ? Date.now() - r.startedAt : 0,
    restarts: r.restarts,
    nextRestartAt: r.nextRestartAt,
    lastExit: r.lastExit,
    cpu: r.stats.cpu,
    memory: r.stats.memory,
    installing: installer.isBusy(id)
  };
}

function setStatus(id, status) {
  const r = rt(id);
  if (r.status === status) return;
  r.status = status;
  bus.emit('status', { serviceId: id, state: state(id) });
}

function sys(id, text) {
  logStore.append(id, 'sys', text);
}

function persistRunning(id, running) {
  const svc = db.data.services[id];
  if (svc && svc.wasRunning !== running) { svc.wasRunning = running; db.save(); }
}

// Decide the executable + argv for a service.
function commandFor(svc) {
  const d = services.dir(svc.id);
  if (svc.runtime === 'custom' || svc.type === 'custom') {
    const argv = exec.splitArgs(svc.command);
    if (!argv.length) throw httpError(400, 'Set a start command in Settings first');
    return exec.resolveCommand(argv, d);
  }
  const entryPath = path.join(d, svc.entry);
  if (!path.resolve(entryPath).startsWith(path.resolve(d) + path.sep)) throw httpError(400, 'Entry file must be inside the service folder');
  if (!fs.existsSync(entryPath)) throw httpError(400, `Entry file "${svc.entry}" was not found. Fix it in Settings or create the file.`);
  if (svc.runtime === 'python') return { cmd: exec.pythonCommand(d), args: ['-u', svc.entry] };
  const flags = exec.splitArgs(svc.nodeArgs).filter(f => f.startsWith('-'));
  if (svc.memoryLimitMb > 0) flags.push(`--max-old-space-size=${svc.memoryLimitMb}`);
  return { cmd: process.execPath, args: [...flags, svc.entry] };
}

function attachLines(id, instance, stream, kind) {
  let partial = '';
  stream.on('data', chunk => {
    if (rt(id).instance !== instance) return;
    const text = partial + chunk.toString();
    const lines = text.split(/\r?\n/);
    partial = lines.pop();
    if (partial.length > 4000) { lines.push(partial); partial = ''; }
    for (const line of lines) {
      if (!line) continue;
      logStore.append(id, kind, line);
      diagnostics.scan(id, logStore.stripAnsi(line));
    }
  });
  stream.on('end', () => {
    if (partial && rt(id).instance === instance) {
      logStore.append(id, kind, partial);
      diagnostics.scan(id, logStore.stripAnsi(partial));
    }
  });
}

async function start(id, { by = 'system', reason = 'manual' } = {}) {
  const svc = services.get(id);
  const r = rt(id);
  if (r.child || ['STARTING', 'ONLINE', 'INSTALLING', 'BUILDING', 'STOPPING'].includes(r.status)) return state(id);
  clearTimeout(r.backoffTimer);
  r.backoffTimer = null;
  r.nextRestartAt = null;
  r.manualStop = false;
  if (reason === 'manual') { r.consecutiveCrashes = 0; r.crashTimes = []; diagnostics.clear(id); }

  // Static sites have no process: "online" simply means the panel serves them.
  const serveStatic = () => {
    r.startedAt = Date.now();
    setStatus(id, 'ONLINE');
    persistRunning(id, true);
    sys(id, `Static site is being served at /apps/${id}/${svc.staticRoot && svc.staticRoot !== '.' ? ` from ${svc.staticRoot}/` : ''}`);
    return state(id);
  };
  const willBuild = !!(svc.buildCommand && svc.buildOnStart);
  if (svc.type === 'static' && !willBuild) return serveStatic();

  setStatus(id, 'STARTING');
  try {
    if ((svc.type !== 'static' || willBuild) && installer.needsInstall(id) && !installer.isBusy(id)) {
      setStatus(id, 'INSTALLING');
      sys(id, 'Dependencies are missing — installing them before start…');
      const res = await installer.install(id);
      if (res.code !== 0) {
        sys(id, 'Dependency install failed. Fix the errors above, then start again.');
        setStatus(id, 'CRASHED');
        return state(id);
      }
    }
    if (svc.buildCommand && svc.buildOnStart && !installer.isBusy(id)) {
      setStatus(id, 'BUILDING');
      const res = await installer.build(id);
      if (res.code !== 0) {
        sys(id, 'Build failed. Fix the errors above, then start again.');
        setStatus(id, 'CRASHED');
        return state(id);
      }
    }
    if (r.manualStop) { setStatus(id, 'OFFLINE'); return state(id); }
    if (svc.type === 'static') return serveStatic();

    const spec = commandFor(svc);
    const env = services.buildEnv(svc);
    db.save(); // buildEnv may have allocated a port
    if (svc.type === 'discord' && !env.DISCORD_BOT_TOKEN) {
      sys(id, 'Warning: DISCORD_BOT_TOKEN is not set. Add it in the Environment tab.');
      diagnostics.scan(id, 'Cannot start: DISCORD_BOT_TOKEN is empty');
    }
    const instance = ++r.instance;
    sys(id, `Starting: ${path.basename(spec.cmd)} ${spec.args.join(' ')}${svc.type === 'web' ? `  (PORT=${env.PORT})` : ''}`);
    const child = spawn(spec.cmd, spec.args, {
      cwd: services.dir(id), env, shell: !!spec.needsShell, windowsHide: true, detached: !exec.isWin
    });
    r.child = child;
    r.startedAt = Date.now();
    r.healthFailures = 0;
    attachLines(id, instance, child.stdout, 'out');
    attachLines(id, instance, child.stderr, 'err');
    child.on('error', err => {
      if (rt(id).instance !== instance) return;
      sys(id, `Failed to start process: ${err.message}`);
      diagnostics.scan(id, `spawn ${path.basename(spec.cmd)} ${err.code || ''}`);
    });
    child.on('close', (code, signal) => onExit(id, instance, code, signal));
    setStatus(id, 'ONLINE');
    persistRunning(id, true);
    if (by !== 'system') require('./audit').record(by, 'service.start', id);
  } catch (e) {
    sys(id, `Cannot start: ${e.message}`);
    diagnostics.scan(id, e.message);
    setStatus(id, 'CRASHED');
    throw e;
  }
  return state(id);
}

function onExit(id, instance, code, signal) {
  const r = rt(id);
  if (r.instance !== instance) return; // an older process finishing after a restart
  const svc = db.data.services[id];
  const ranFor = r.startedAt ? Date.now() - r.startedAt : 0;
  r.child = null;
  r.stats = { cpu: 0, memory: 0 };
  r.lastExit = { code, signal, at: new Date().toISOString(), ranForMs: ranFor };
  for (const w of r.stopWaiters.splice(0)) w();

  if (r.manualStop || !svc) {
    sys(id, `Stopped${code !== null ? ` (exit code ${code})` : ''}.`);
    setStatus(id, 'OFFLINE');
    return;
  }

  const crashed = code !== 0 || !!signal;
  sys(id, crashed ? `Process crashed (${signal ? 'signal ' + signal : 'exit code ' + code}) after ${Math.round(ranFor / 1000)}s.` : 'Process exited cleanly (code 0).');
  const policy = svc.restartPolicy;
  const shouldRestart = policy === 'always' || (policy === 'on-failure' && crashed);

  if (crashed) {
    r.crashTimes = r.crashTimes.filter(t => Date.now() - t < CRASH_WINDOW_MS);
    r.crashTimes.push(Date.now());
    r.consecutiveCrashes = ranFor > STABLE_AFTER_MS ? 1 : r.consecutiveCrashes + 1;
    if (r.crashTimes.length >= CRASH_LOOP_LIMIT && shouldRestart) {
      sys(id, `Crash loop detected (${CRASH_LOOP_LIMIT} crashes in 2 minutes). Auto-restart paused — fix the error, then press Start.`);
      setStatus(id, 'CRASHED');
      notify({ level: 'error', event: 'crashLoop', serviceId: id, title: 'Crash loop — auto-restart paused', message: lastErrorLines(id) });
      return;
    }
    notify({ level: 'error', event: 'crash', serviceId: id, title: `Crashed (${signal || 'code ' + code})`, message: lastErrorLines(id), throttleKey: `crash:${id}`, throttleMs: 60000 });
  } else {
    r.consecutiveCrashes = 0;
  }

  if (!shouldRestart) {
    setStatus(id, crashed ? 'CRASHED' : 'OFFLINE');
    if (!crashed) persistRunning(id, false);
    return;
  }

  const delay = crashed ? Math.min(60000, 1000 * 2 ** Math.max(0, r.consecutiveCrashes - 1)) : 1000;
  r.nextRestartAt = Date.now() + delay;
  sys(id, `Restarting in ${Math.round(delay / 1000)}s (policy: ${policy}).`);
  setStatus(id, 'RESTARTING');
  r.backoffTimer = setTimeout(async () => {
    r.backoffTimer = null;
    r.nextRestartAt = null;
    r.restarts++;
    try {
      await start(id, { reason: 'auto' });
      if (crashed) {
        setTimeout(() => {
          if (rt(id).status === 'ONLINE' && rt(id).consecutiveCrashes > 0 && Date.now() - rt(id).startedAt >= STABLE_AFTER_MS - 1000) {
            notify({ level: 'success', event: 'recovered', serviceId: id, title: 'Recovered and running again', throttleKey: `rec:${id}`, throttleMs: 60000 });
          }
        }, STABLE_AFTER_MS);
      }
    } catch {}
  }, delay);
}

function lastErrorLines(id) {
  return logStore.history(id).filter(e => e.s === 'err').slice(-8).map(e => logStore.stripAnsi(e.m)).join('\n').slice(-1500);
}

function stop(id, { by = 'system', keepRunningFlag = false } = {}) {
  const r = rt(id);
  r.manualStop = true;
  clearTimeout(r.backoffTimer);
  r.backoffTimer = null;
  r.nextRestartAt = null;
  if (!keepRunningFlag) persistRunning(id, false);
  if (by !== 'system') require('./audit').record(by, 'service.stop', id);
  const svc = db.data.services[id];
  if (svc && svc.type === 'static') { setStatus(id, 'OFFLINE'); return Promise.resolve(state(id)); }
  if (!r.child) { setStatus(id, 'OFFLINE'); return Promise.resolve(state(id)); }

  setStatus(id, 'STOPPING');
  const child = r.child;
  return new Promise(resolve => {
    const done = () => { clearTimeout(killTimer); clearTimeout(giveUp); resolve(state(id)); };
    r.stopWaiters.push(done);
    exec.killTree(child.pid, 'SIGTERM');
    const killTimer = setTimeout(() => exec.killTree(child.pid, 'SIGKILL'), STOP_GRACE_MS);
    const giveUp = setTimeout(() => {
      // Process ignored every signal; detach from it so the panel stays usable.
      if (rt(id).child === child) { rt(id).child = null; rt(id).instance++; setStatus(id, 'OFFLINE'); }
      resolve(state(id));
    }, STOP_GRACE_MS + 4000);
  });
}

async function restart(id, { by = 'system' } = {}) {
  services.get(id);
  if (by !== 'system') require('./audit').record(by, 'service.restart', id);
  await stop(id, { keepRunningFlag: true });
  rt(id).restarts++;
  return start(id, { reason: 'manual' });
}

function writeStdin(id, text) {
  const r = rt(id);
  if (!r.child || !r.child.stdin || !r.child.stdin.writable) throw httpError(409, 'The process is not running');
  r.child.stdin.write(String(text) + '\n');
  sys(id, `> ${text}`);
}

function isRunning(id) {
  return !!rt(id).child || (db.data.services[id] && db.data.services[id].type === 'static' && rt(id).status === 'ONLINE');
}

function forget(id) {
  const r = runtime.get(id);
  if (r) clearTimeout(r.backoffTimer);
  runtime.delete(id);
  diagnostics.clear(id);
}

// ---------- metrics sampling ----------
async function sample() {
  const pids = [];
  const owners = {};
  for (const [id, r] of runtime) {
    if (r.child && r.child.pid) { pids.push(r.child.pid); owners[r.child.pid] = id; }
  }
  if (!pids.length) return;
  let stats = {};
  try { stats = await pidusage(pids); } catch {
    for (const pid of pids) { try { stats[pid] = await pidusage(pid); } catch {} }
  }
  const out = {};
  for (const [pid, s] of Object.entries(stats)) {
    const id = owners[pid];
    if (!id || !s) continue;
    const r = rt(id);
    r.stats = { cpu: Math.round((s.cpu || 0) * 10) / 10, memory: s.memory || 0 };
    out[id] = { cpu: r.stats.cpu, memory: r.stats.memory, uptimeMs: r.startedAt ? Date.now() - r.startedAt : 0 };
    const svc = db.data.services[id];
    if (svc && svc.memoryLimitMb > 0) {
      const pct = (r.stats.memory / (svc.memoryLimitMb * 1024 * 1024)) * 100;
      if (pct >= (svc.memoryAlertPct || 90)) {
        notify({ level: 'warning', event: 'memory', serviceId: id, title: `High memory: ${Math.round(r.stats.memory / 1048576)} MB (${Math.round(pct)}% of limit)`, throttleKey: `mem:${id}`, throttleMs: 30 * 60000 });
      }
    }
  }
  bus.emit('stats', out);
}
const sampler = setInterval(() => { sample().catch(() => {}); }, 2000);
sampler.unref();

// ---------- HTTP health checks (web services) ----------
function healthCheck(id) {
  const svc = db.data.services[id];
  const r = rt(id);
  if (!svc || svc.type !== 'web' || !svc.healthCheck.enabled || r.status !== 'ONLINE' || !svc.port) return;
  if (Date.now() - (r.startedAt || 0) < 15000) return; // give it time to boot
  const req = http.get({ host: '127.0.0.1', port: svc.port, path: svc.healthCheck.path || '/', timeout: 5000 }, res => {
    res.resume();
    if (res.statusCode < 500) { r.healthFailures = 0; return; }
    fail(`HTTP ${res.statusCode}`);
  });
  req.on('timeout', () => { req.destroy(); });
  req.on('error', e => fail(e.code || e.message));
  function fail(reason) {
    r.healthFailures++;
    sys(id, `Health check failed (${reason}) — ${r.healthFailures}/${svc.healthCheck.failures}`);
    if (r.healthFailures >= svc.healthCheck.failures) {
      r.healthFailures = 0;
      notify({ level: 'warning', event: 'healthCheck', serviceId: id, title: 'Health check failed — restarting', message: reason, throttleKey: `hc:${id}`, throttleMs: 10 * 60000 });
      restart(id).catch(() => {});
    }
  }
}
const healthTimers = new Map();
setInterval(() => {
  for (const svc of Object.values(db.data.services)) {
    if (svc.type !== 'web' || !svc.healthCheck.enabled) continue;
    const last = healthTimers.get(svc.id) || 0;
    if (Date.now() - last >= svc.healthCheck.intervalSec * 1000) {
      healthTimers.set(svc.id, Date.now());
      healthCheck(svc.id);
    }
  }
}, 5000).unref();

// ---------- boot / shutdown ----------
async function restoreOnBoot() {
  for (const svc of Object.values(db.data.services)) {
    if (svc.autostart && svc.wasRunning) {
      sys(svc.id, 'OmniHost restarted — bringing this service back online.');
      start(svc.id, { reason: 'boot' }).catch(e => console.warn(`[pm] could not restore ${svc.id}: ${e.message}`));
    }
  }
}

async function stopAll() {
  const ids = [...runtime.keys()].filter(id => rt(id).child);
  await Promise.all(ids.map(id => stop(id, { keepRunningFlag: true })));
}

module.exports = { start, stop, restart, writeStdin, state, isRunning, forget, restoreOnBoot, stopAll, commandFor };

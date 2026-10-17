// Dependency management for services: npm for Node, pip (+ per-service venv) for Python.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const services = require('./services');
const logStore = require('./logStore');
const exec = require('./exec');
const { httpError } = require('./errors');

const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(@[A-Za-z0-9._^~<>=*|-]+)?$/i;
const PIP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?([<>=!~]=?[A-Za-z0-9.*+!-]+)?$/;
const MARKER = '.omnihost-installed';

const busy = new Set();

function kind(id) {
  const d = services.dir(id);
  const svc = services.get(id);
  if (svc.runtime === 'python') return 'python';
  if (svc.runtime === 'node') return 'node';
  return fs.existsSync(path.join(d, 'requirements.txt')) && !fs.existsSync(path.join(d, 'package.json')) ? 'python' : 'node';
}

function sys(id, text) {
  logStore.append(id, 'sys', text);
}

function requirementsHash(d) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(d, 'requirements.txt'))).digest('hex'); } catch { return null; }
}

function needsInstall(id) {
  const d = services.dir(id);
  if (kind(id) === 'python') {
    const hash = requirementsHash(d);
    if (!hash) return false;
    let marker = '';
    try { marker = fs.readFileSync(path.join(d, '.venv', MARKER), 'utf8').trim(); } catch {}
    return marker !== hash;
  }
  const pkg = services.readPackageJson(id);
  if (!pkg) return false;
  const deps = Object.keys(pkg.dependencies || {});
  if (!deps.length) return false;
  if (!fs.existsSync(path.join(d, 'node_modules'))) return true;
  return deps.some(dep => !fs.existsSync(path.join(d, 'node_modules', ...dep.split('/'))));
}

async function withLock(id, fn) {
  if (busy.has(id)) throw httpError(409, 'An install is already running for this service');
  busy.add(id);
  try { return await fn(); } finally { busy.delete(id); }
}

async function runLogged(id, spec, label) {
  sys(id, `$ ${label}`);
  const svc = services.get(id);
  const res = await exec.run(spec, {
    cwd: services.dir(id),
    env: services.buildEnv(svc),
    onLine: (line, k) => logStore.append(id, k === 'err' ? 'err' : 'out', line)
  });
  sys(id, res.code === 0 ? `✓ ${label} finished` : `✗ ${label} exited with code ${res.code}`);
  return res;
}

async function ensureVenv(id) {
  const d = services.dir(id);
  const venvPy = exec.pythonCommand(d);
  if (venvPy.includes('.venv')) return true;
  const res = await runLogged(id, { cmd: exec.pythonCommand(null), args: ['-m', 'venv', '.venv'] }, 'python -m venv .venv');
  return res.code === 0;
}

async function install(id) {
  return withLock(id, async () => {
    const d = services.dir(id);
    if (kind(id) === 'python') {
      if (!fs.existsSync(path.join(d, 'requirements.txt'))) { sys(id, 'No requirements.txt — nothing to install.'); return { code: 0 }; }
      if (!(await ensureVenv(id))) return { code: 1 };
      const res = await runLogged(id, { cmd: exec.pythonCommand(d), args: ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt'] }, 'pip install -r requirements.txt');
      if (res.code === 0) fs.writeFileSync(path.join(d, '.venv', MARKER), requirementsHash(d) || '');
      return res;
    }
    if (!fs.existsSync(path.join(d, 'package.json'))) { sys(id, 'No package.json — nothing to install.'); return { code: 0 }; }
    const hasLock = fs.existsSync(path.join(d, 'package-lock.json'));
    return runLogged(id, exec.npmCommand(['install', '--omit=dev', '--no-audit', '--no-fund']), hasLock ? 'npm install (using package-lock.json)' : 'npm install');
  });
}

function listPackages(id) {
  const d = services.dir(id);
  if (kind(id) === 'python') {
    let text = '';
    try { text = fs.readFileSync(path.join(d, 'requirements.txt'), 'utf8'); } catch {}
    const deps = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('-'))
      .map(l => { const m = l.match(/^([A-Za-z0-9._\[\],-]+)\s*(.*)$/); return { name: m ? m[1] : l, version: m ? m[2] : '', dev: false }; });
    return { manager: 'pip', file: 'requirements.txt', packages: deps };
  }
  const pkg = services.readPackageJson(id) || {};
  const installedVersion = name => {
    try { return JSON.parse(fs.readFileSync(path.join(d, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version; } catch { return null; }
  };
  const list = [];
  for (const [name, version] of Object.entries(pkg.dependencies || {})) list.push({ name, version, installed: installedVersion(name), dev: false });
  for (const [name, version] of Object.entries(pkg.devDependencies || {})) list.push({ name, version, installed: installedVersion(name), dev: true });
  return { manager: 'npm', file: 'package.json', packages: list, scripts: pkg.scripts || {} };
}

function validatePackageName(id, name) {
  const ok = kind(id) === 'python' ? PIP_NAME_RE.test(name) : NPM_NAME_RE.test(name);
  if (!ok || name.startsWith('-')) throw httpError(400, `"${name}" is not a valid package name`);
}

function ensurePackageJson(id) {
  const file = path.join(services.dir(id), 'package.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ name: id.toLowerCase(), version: '1.0.0', private: true, dependencies: {} }, null, 2) + '\n');
  }
}

async function addPackage(id, name, { dev = false } = {}) {
  validatePackageName(id, name);
  return withLock(id, async () => {
    const d = services.dir(id);
    if (kind(id) === 'python') {
      if (!(await ensureVenv(id))) return { code: 1 };
      const res = await runLogged(id, { cmd: exec.pythonCommand(d), args: ['-m', 'pip', 'install', '--disable-pip-version-check', name] }, `pip install ${name}`);
      if (res.code === 0) {
        const file = path.join(d, 'requirements.txt');
        const base = name.split(/[<>=!~[]/)[0].toLowerCase();
        const lines = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split(/\r?\n/).filter(l => l.trim() && l.split(/[<>=!~[\s]/)[0].toLowerCase() !== base);
        lines.push(name);
        fs.writeFileSync(file, lines.join('\n') + '\n');
        fs.writeFileSync(path.join(d, '.venv', MARKER), requirementsHash(d) || '');
      }
      return res;
    }
    ensurePackageJson(id);
    return runLogged(id, exec.npmCommand(['install', dev ? '--save-dev' : '--save', '--no-audit', '--no-fund', name]), `npm install ${dev ? '-D ' : ''}${name}`);
  });
}

async function removePackage(id, name) {
  validatePackageName(id, name);
  return withLock(id, async () => {
    const d = services.dir(id);
    if (kind(id) === 'python') {
      const res = await runLogged(id, { cmd: exec.pythonCommand(d), args: ['-m', 'pip', 'uninstall', '-y', name] }, `pip uninstall ${name}`);
      const file = path.join(d, 'requirements.txt');
      if (fs.existsSync(file)) {
        const base = name.toLowerCase();
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && l.split(/[<>=!~[\s]/)[0].toLowerCase() !== base);
        fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
      }
      return res;
    }
    return runLogged(id, exec.npmCommand(['uninstall', '--no-audit', '--no-fund', name]), `npm uninstall ${name}`);
  });
}

async function upgrade(id, name) {
  if (name) validatePackageName(id, name);
  return withLock(id, async () => {
    const d = services.dir(id);
    if (kind(id) === 'python') {
      if (!(await ensureVenv(id))) return { code: 1 };
      const args = name ? ['-m', 'pip', 'install', '--upgrade', name] : ['-m', 'pip', 'install', '--upgrade', '-r', 'requirements.txt'];
      return runLogged(id, { cmd: exec.pythonCommand(d), args }, `pip install --upgrade ${name || '-r requirements.txt'}`);
    }
    const args = name ? ['install', '--no-audit', '--no-fund', `${name}@latest`] : ['update', '--no-audit', '--no-fund'];
    return runLogged(id, exec.npmCommand(args), name ? `npm install ${name}@latest` : 'npm update');
  });
}

async function outdated(id) {
  const d = services.dir(id);
  const svc = services.get(id);
  if (kind(id) === 'python') {
    const res = await exec.run({ cmd: exec.pythonCommand(d), args: ['-m', 'pip', 'list', '--outdated', '--format=json', '--disable-pip-version-check'] }, { cwd: d, env: services.buildEnv(svc), timeoutMs: 120000 });
    try { return JSON.parse(res.output.trim().split('\n').pop()).map(p => ({ name: p.name, current: p.version, latest: p.latest_version })); } catch { return []; }
  }
  const res = await exec.run(exec.npmCommand(['outdated', '--json']), { cwd: d, env: services.buildEnv(svc), timeoutMs: 120000 });
  try {
    const json = JSON.parse(res.output.slice(res.output.indexOf('{')) || '{}');
    return Object.entries(json).map(([name, v]) => ({ name, current: v.current, wanted: v.wanted, latest: v.latest }));
  } catch { return []; }
}

// Run the service's build command (e.g. "npm run build") with its environment, streamed to the console.
async function build(id) {
  const svc = services.get(id);
  const argv = exec.splitArgs(svc.buildCommand);
  if (!argv.length) throw httpError(400, 'Set a build command in Settings first');
  return withLock(id, () => runLogged(id, exec.resolveCommand(argv, services.dir(id)), svc.buildCommand));
}

// Security audit: `npm audit` for Node, `pip check` (dependency conflicts) for Python.
async function audit(id) {
  const d = services.dir(id);
  const svc = services.get(id);
  if (kind(id) === 'python') {
    if (!fs.existsSync(path.join(d, '.venv'))) return { manager: 'pip', ok: null, message: 'Dependencies are not installed yet.' };
    const res = await exec.run({ cmd: exec.pythonCommand(d), args: ['-m', 'pip', 'check', '--disable-pip-version-check'] }, { cwd: d, env: services.buildEnv(svc), timeoutMs: 120000 });
    return { manager: 'pip', ok: res.code === 0, message: res.output.trim().slice(0, 4000) || 'No broken requirements found.' };
  }
  if (!fs.existsSync(path.join(d, 'package.json'))) return { manager: 'npm', ok: null, message: 'No package.json.' };
  if (!fs.existsSync(path.join(d, 'package-lock.json'))) return { manager: 'npm', ok: null, message: 'npm audit needs a package-lock.json — install dependencies first.' };
  const res = await exec.run(exec.npmCommand(['audit', '--json', '--omit=dev']), { cwd: d, env: services.buildEnv(svc), timeoutMs: 120000 });
  let json;
  try { json = JSON.parse(res.output.slice(res.output.indexOf('{'))); } catch { return { manager: 'npm', ok: null, message: 'npm audit returned no readable result (offline?).' }; }
  const counts = (json.metadata && json.metadata.vulnerabilities) || {};
  const issues = Object.values(json.vulnerabilities || {}).map(v => ({
    name: v.name, severity: v.severity, range: v.range, fixAvailable: !!v.fixAvailable,
    title: (Array.isArray(v.via) ? v.via.find(x => typeof x === 'object') || {} : {}).title || ''
  }));
  const total = Object.entries(counts).filter(([k]) => k !== 'total').reduce((a, [, n]) => a + n, 0);
  return { manager: 'npm', ok: total === 0, counts, issues, message: total ? `${total} known vulnerabilit${total === 1 ? 'y' : 'ies'}` : 'No known vulnerabilities.' };
}

// `npm audit fix` without --force (never makes breaking upgrades).
async function auditFix(id) {
  return withLock(id, () => runLogged(id, exec.npmCommand(['audit', 'fix', '--omit=dev', '--no-fund']), 'npm audit fix'));
}

module.exports = { install, build, audit, auditFix, needsInstall, listPackages, addPackage, removePackage, upgrade, outdated, kind, isBusy: id => busy.has(id) };

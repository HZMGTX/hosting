// Environment variables: per-service .env and shared env groups. Values are masked unless revealed.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const envFile = require('../lib/envFile');
const services = require('../lib/services');
const { httpError } = require('../lib/errors');
const { service, bool, str } = require('./_util');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const SECRET_HINT = /TOKEN|SECRET|PASSWORD|PASS|KEY|PRIVATE|CREDENTIAL|DATABASE_URL|_URI$|_DSN$/i;

function present(vars, reveal) {
  return Object.entries(vars).map(([key, value]) => ({
    key,
    value: reveal ? value : (SECRET_HINT.test(key) ? envFile.mask(value) : value),
    secret: SECRET_HINT.test(key),
    empty: value === ''
  }));
}

function validateUpdates(updates) {
  if (!updates || typeof updates !== 'object') throw httpError(400, 'Expected { vars: { KEY: value } }');
  const out = {};
  for (const [k, v] of Object.entries(updates)) {
    if (!KEY_RE.test(k)) throw httpError(400, `"${k}" is not a valid variable name`);
    if (v !== null && typeof v !== 'string') throw httpError(400, `Value for ${k} must be text`);
    if (v && v.length > 32768) throw httpError(400, `Value for ${k} is too long`);
    out[k] = v;
  }
  return out;
}

// ----- per service -----
const svcRouter = express.Router({ mergeParams: true });

svcRouter.get('/', service(), (req, res) => {
  const reveal = bool(req.query.reveal);
  if (reveal && !auth.can(req.user, 'service.edit', req.svc.id)) throw httpError(403, 'Viewers cannot reveal secrets');
  if (reveal) audit.record(req, 'env.revealed', req.svc.id);
  const vars = envFile.readVars(services.envPath(req.svc.id));
  const inherited = services.groupVars(req.svc);
  res.json({
    vars: present(vars, reveal),
    inherited: present(inherited, reveal).map(v => ({ ...v, overridden: v.key in vars })),
    groups: req.svc.envGroups,
    system: Object.keys(Object.fromEntries(Object.entries({
      OMNIHOST_SERVICE_ID: req.svc.id,
      PORT: req.svc.type === 'web' ? req.svc.port : undefined,
      DATABASE_PATH: req.svc.sqlite ? services.sqlitePath(req.svc.id) : undefined
    }).filter(([, v]) => v !== undefined)))
  });
});

// PATCH { vars: { KEY: "value", OLD: null } } — only listed keys change; masked values are ignored.
svcRouter.patch('/', service('service.edit'), (req, res) => {
  const updates = validateUpdates(req.body.vars);
  const current = envFile.readVars(services.envPath(req.svc.id));
  for (const [k, v] of Object.entries(updates)) {
    if (typeof v === 'string' && v.includes('•') && k in current && envFile.mask(current[k]) === v) delete updates[k];
  }
  envFile.writeVars(services.envPath(req.svc.id), updates);
  audit.record(req, 'env.updated', req.svc.id, Object.keys(updates).join(', '));
  res.json({ ok: true, changed: Object.keys(updates) });
});

// Raw .env text (editor mode).
svcRouter.get('/raw', service('service.edit'), (req, res) => {
  audit.record(req, 'env.revealed', req.svc.id, 'raw');
  res.json({ text: envFile.readFile(services.envPath(req.svc.id)) });
});
svcRouter.put('/raw', service('service.edit'), (req, res) => {
  if (typeof req.body.text !== 'string' || req.body.text.length > 256 * 1024) throw httpError(400, 'Invalid .env text');
  require('fs').writeFileSync(services.envPath(req.svc.id), req.body.text, 'utf8');
  audit.record(req, 'env.updated', req.svc.id, 'raw edit');
  res.json({ ok: true });
});

// ----- shared groups -----
const groupRouter = express.Router();

groupRouter.get('/', (req, res) => {
  const reveal = bool(req.query.reveal) && auth.can(req.user, 'admin');
  res.json(Object.values(db.data.envGroups).map(g => ({
    id: g.id, name: g.name, description: g.description || '',
    vars: present(g.vars, reveal),
    services: Object.values(db.data.services).filter(s => s.envGroups.includes(g.id)).map(s => s.id)
  })));
});

groupRouter.post('/', auth.requirePerm('admin'), (req, res) => {
  const name = str(req.body.name, 60).trim();
  if (!name) throw httpError(400, 'Name is required');
  const id = 'g_' + crypto.randomBytes(5).toString('hex');
  db.data.envGroups[id] = { id, name, description: str(req.body.description, 200), vars: validateUpdates(req.body.vars || {}) };
  db.save();
  audit.record(req, 'envgroup.created', name);
  res.json({ id, name });
});

groupRouter.patch('/:gid', auth.requirePerm('admin'), (req, res) => {
  const g = db.data.envGroups[req.params.gid];
  if (!g) throw httpError(404, 'Group not found');
  if (req.body.name !== undefined) g.name = str(req.body.name, 60).trim() || g.name;
  if (req.body.description !== undefined) g.description = str(req.body.description, 200);
  if (req.body.vars) {
    const updates = validateUpdates(req.body.vars);
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) delete g.vars[k];
      else if (!(v.includes('•') && k in g.vars && envFile.mask(g.vars[k]) === v)) g.vars[k] = v;
    }
  }
  if (Array.isArray(req.body.services)) {
    for (const s of Object.values(db.data.services)) {
      const want = req.body.services.includes(s.id);
      const has = s.envGroups.includes(g.id);
      if (want && !has) s.envGroups.push(g.id);
      if (!want && has) s.envGroups = s.envGroups.filter(x => x !== g.id);
    }
  }
  db.save();
  audit.record(req, 'envgroup.updated', g.name);
  res.json({ ok: true });
});

groupRouter.delete('/:gid', auth.requirePerm('admin'), (req, res) => {
  const g = db.data.envGroups[req.params.gid];
  if (!g) throw httpError(404, 'Group not found');
  delete db.data.envGroups[g.id];
  for (const s of Object.values(db.data.services)) s.envGroups = s.envGroups.filter(x => x !== g.id);
  db.save();
  audit.record(req, 'envgroup.deleted', g.name);
  res.json({ ok: true });
});

// TCP reachability check for a connection string (does not authenticate).
groupRouter.post('/test-connection', auth.requirePerm('admin'), async (req, res) => {
  let url;
  try { url = new URL(str(req.body.url, 2000)); } catch { throw httpError(400, 'Not a valid connection URL'); }
  const defaults = { 'postgres:': 5432, 'postgresql:': 5432, 'redis:': 6379, 'rediss:': 6379, 'mongodb:': 27017, 'mysql:': 3306, 'https:': 443, 'http:': 80 };
  if (url.protocol === 'mongodb+srv:') return res.json({ ok: null, message: 'SRV records cannot be tested with a plain TCP check.' });
  const port = parseInt(url.port, 10) || defaults[url.protocol];
  if (!port || !url.hostname) throw httpError(400, 'Could not work out host and port');
  const started = Date.now();
  const ok = await new Promise(resolve => {
    const sock = require('net').connect({ host: url.hostname, port, timeout: 5000 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error', () => resolve(false));
  });
  res.json({ ok, host: url.hostname, port, ms: Date.now() - started, message: ok ? 'Port is reachable (credentials not checked).' : 'Could not reach that host/port.' });
});

module.exports = { svcRouter, groupRouter };

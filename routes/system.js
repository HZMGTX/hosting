// Panel-wide endpoints: overview, settings, notifications, audit, domains, key-value store, API docs.
const express = require('express');
const os = require('os');
const fs = require('fs');
const db = require('../db');
const config = require('../lib/config');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const pm = require('../lib/processManager');
const metrics = require('../lib/metrics');
const aiAssist = require('../lib/aiAssist');
const { notify } = require('../lib/notify');
const { isValidId } = require('../lib/safePath');
const { httpError } = require('../lib/errors');
const { bool, str } = require('./_util');

const router = express.Router();
const startedAt = Date.now();

// Host CPU usage is computed from the delta between two os.cpus() snapshots.
let lastCpu = os.cpus();
let hostCpu = 0;
setInterval(() => {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const prev = lastCpu[i] ? lastCpu[i].times : c.times;
    for (const k of Object.keys(c.times)) total += c.times[k] - prev[k];
    idle += c.times.idle - prev.idle;
  });
  hostCpu = total ? Math.round((1 - idle / total) * 1000) / 10 : 0;
  lastCpu = now;
}, 3000).unref();

function diskInfo() {
  try {
    const s = fs.statfsSync(config.DATA_DIR);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return null; }
}

router.get('/overview', (req, res) => {
  const visible = Object.values(db.data.services).filter(s => auth.can(req.user, 'service.view', s.id));
  const states = visible.map(s => ({ id: s.id, name: s.name, type: s.type, ...pm.state(s.id), uptime24h: metrics.uptime(s.id, '24h') }));
  res.json({
    host: {
      platform: `${os.type()} ${os.release()}`, arch: os.arch(), hostname: os.hostname(), cpus: os.cpus().length,
      cpuPercent: hostCpu, load: os.loadavg(), memTotal: os.totalmem(), memFree: os.freemem(), disk: diskInfo(),
      uptime: os.uptime(), node: process.version, panelUptime: Math.round((Date.now() - startedAt) / 1000),
      panelMemory: process.memoryUsage().rss
    },
    counts: {
      total: states.length,
      online: states.filter(s => s.status === 'ONLINE').length,
      crashed: states.filter(s => s.status === 'CRASHED').length,
      byType: states.reduce((a, s) => ((a[s.type] = (a[s.type] || 0) + 1), a), {})
    },
    services: states,
    notifications: db.data.notifications.filter(n => !n.serviceId || auth.can(req.user, 'service.view', n.serviceId)).slice(-10).reverse(),
    features: { ai: aiAssist.enabled(), publicUrl: config.PUBLIC_URL, statusPage: db.data.settings.statusPage.enabled }
  });
});

router.get('/info', (req, res) => {
  res.json({
    version: require('../package.json').version,
    ai: aiAssist.enabled(),
    aiModel: aiAssist.enabled() ? config.OMNI_AI_MODEL : null,
    publicUrl: config.PUBLIC_URL,
    production: config.isProd,
    roles: auth.ROLES
  });
});

// ----- notifications -----
router.get('/notifications', (req, res) => {
  const list = db.data.notifications.filter(n => !n.serviceId || auth.can(req.user, 'service.view', n.serviceId));
  res.json(list.slice(-200).reverse());
});
router.post('/notifications/read', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? new Set(req.body.ids) : null;
  for (const n of db.data.notifications) if (!ids || ids.has(n.id)) n.read = true;
  db.save();
  res.json({ ok: true });
});

// ----- settings (admin) -----
router.get('/settings', auth.requirePerm('admin'), (req, res) => {
  const s = db.data.settings;
  res.json({ alerts: s.alerts, statusPage: s.statusPage, backups: s.backups, logs: s.logs });
});
router.patch('/settings', auth.requirePerm('admin'), (req, res) => {
  const s = db.data.settings;
  const b = req.body || {};
  const urlOk = u => !u || /^https:\/\/[^\s]+$/.test(u);
  if (b.alerts) {
    if (b.alerts.discordWebhook !== undefined) {
      if (b.alerts.discordWebhook && !/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(b.alerts.discordWebhook)) throw httpError(400, 'That is not a Discord webhook URL');
      s.alerts.discordWebhook = b.alerts.discordWebhook;
    }
    if (b.alerts.httpWebhook !== undefined) {
      if (!urlOk(b.alerts.httpWebhook)) throw httpError(400, 'Webhook URL must start with https://');
      s.alerts.httpWebhook = b.alerts.httpWebhook;
    }
    if (b.alerts.events) for (const k of Object.keys(s.alerts.events)) if (k in b.alerts.events) s.alerts.events[k] = bool(b.alerts.events[k]);
  }
  if (b.statusPage) {
    if (b.statusPage.enabled !== undefined) s.statusPage.enabled = bool(b.statusPage.enabled);
    if (b.statusPage.title !== undefined) s.statusPage.title = str(b.statusPage.title, 80) || 'Service Status';
  }
  if (b.backups) {
    if (b.backups.retention !== undefined) s.backups.retention = Math.max(1, Math.min(200, parseInt(b.backups.retention, 10) || 10));
    if (b.backups.dailyHour !== undefined) s.backups.dailyHour = Math.max(0, Math.min(23, parseInt(b.backups.dailyHour, 10) || 0));
  }
  if (b.logs) {
    if (b.logs.maxSizeMb !== undefined) s.logs.maxSizeMb = Math.max(1, Math.min(500, parseInt(b.logs.maxSizeMb, 10) || 5));
    if (b.logs.keepFiles !== undefined) s.logs.keepFiles = Math.max(0, Math.min(20, parseInt(b.logs.keepFiles, 10) || 0));
  }
  db.save();
  audit.record(req, 'settings.updated', '', Object.keys(b).join(', '));
  res.json({ ok: true });
});
router.post('/settings/test-alert', auth.requirePerm('admin'), (req, res) => {
  notify({ level: 'info', event: 'test', title: 'Test alert from OmniHost', message: `Sent by ${req.user.username}. If you can read this, alerts work.` });
  res.json({ ok: true });
});

// ----- audit (admin) -----
router.get('/audit', auth.requirePerm('admin'), (req, res) => {
  res.json(audit.query({ user: str(req.query.user, 40), action: str(req.query.action, 60), target: str(req.query.target, 60), q: str(req.query.q, 100), before: str(req.query.before, 40), limit: parseInt(req.query.limit, 10) || 200 }));
});

// ----- custom domains -----
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
router.get('/domains', (req, res) => {
  res.json(Object.entries(db.data.domains)
    .filter(([, d]) => auth.can(req.user, 'service.view', d.serviceId))
    .map(([name, d]) => ({ name, ...d })));
});
router.post('/domains', (req, res) => {
  const name = str(req.body.domain, 253).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const serviceId = str(req.body.serviceId, 40);
  if (!DOMAIN_RE.test(name)) throw httpError(400, 'Enter a domain like bot.example.com');
  if (!isValidId(serviceId) || !db.data.services[serviceId]) throw httpError(404, 'Service not found');
  if (!auth.can(req.user, 'service.edit', serviceId)) throw httpError(403, 'You cannot edit that service');
  if (!['web', 'static'].includes(db.data.services[serviceId].type)) throw httpError(400, 'Only web apps and static sites can have domains');
  const panelHost = (config.PUBLIC_URL ? new URL(config.PUBLIC_URL).hostname : String(req.headers.host || '').replace(/:\d+$/, '')).toLowerCase();
  if (name === panelHost) throw httpError(400, 'That is the panel\'s own domain');
  if (db.data.domains[name] && db.data.domains[name].serviceId !== serviceId) throw httpError(409, 'That domain is already mapped to another service');
  db.data.domains[name] = { serviceId, createdAt: new Date().toISOString(), createdBy: req.user.username };
  db.save();
  audit.record(req, 'domain.added', serviceId, name);
  res.json({ name, serviceId, cnameTarget: panelHost });
});
router.delete('/domains/:name', (req, res) => {
  const d = db.data.domains[req.params.name];
  if (!d) throw httpError(404, 'Domain not found');
  if (!auth.can(req.user, 'service.edit', d.serviceId)) throw httpError(403, 'You cannot edit that service');
  delete db.data.domains[req.params.name];
  db.save();
  audit.record(req, 'domain.removed', d.serviceId, req.params.name);
  res.json({ ok: true });
});
router.get('/domains/:name/check', async (req, res) => {
  const name = req.params.name;
  if (!db.data.domains[name]) throw httpError(404, 'Domain not found');
  const dns = require('dns').promises;
  const result = { name, cname: [], a: [] };
  try { result.cname = await dns.resolveCname(name); } catch {}
  try { result.a = await dns.resolve4(name); } catch {}
  res.json(result);
});

// ----- whole-panel export / import (owner) -----
const panelTransfer = require('../lib/panelTransfer');
const importUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_MB * 5 * 1024 * 1024, files: 1 } });

router.get('/export', auth.requirePerm('owner'), (req, res) => {
  const buf = panelTransfer.exportPanel({ includeBackups: bool(req.query.backups) });
  audit.record(req, 'panel.exported', '', bool(req.query.backups) ? 'with backups' : '');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="omnihost-export-${new Date().toISOString().slice(0, 10)}.zip"`);
  res.end(buf);
});

router.post('/import', auth.requirePerm('owner'), importUpload.single('file'), (req, res) => {
  if (!req.file) throw httpError(400, 'Choose an export ZIP to import');
  const report = panelTransfer.importPanel(req.file.buffer, { by: req.user });
  audit.record(req, 'panel.imported', '', `${report.imported.length} service(s), ${report.skipped.length} skipped`);
  // Bring back services that were running when the export was made.
  for (const id of report.imported) {
    const s = db.data.services[id];
    if (s && s.autostart && s.wasRunning) pm.start(id).catch(() => {});
  }
  res.json(report);
});

// ----- key-value store (JSON documents, admin) -----
const COLL_RE = /^[A-Za-z0-9_-]{1,40}$/;
router.get('/kv', auth.requirePerm('admin'), (req, res) => {
  res.json(Object.entries(db.data.collections).map(([name, docs]) => ({ name, count: Object.keys(docs).length })));
});
router.get('/kv/:coll', auth.requirePerm('admin'), (req, res) => {
  if (!COLL_RE.test(req.params.coll)) throw httpError(400, 'Invalid collection name');
  res.json(db.data.collections[req.params.coll] || {});
});
router.put('/kv/:coll/:key', auth.requirePerm('admin'), (req, res) => {
  if (!COLL_RE.test(req.params.coll) || !/^[^\0]{1,200}$/.test(req.params.key)) throw httpError(400, 'Invalid collection or key');
  if (JSON.stringify(req.body.value ?? null).length > 512 * 1024) throw httpError(413, 'Document too large');
  (db.data.collections[req.params.coll] = db.data.collections[req.params.coll] || {})[req.params.key] = req.body.value ?? null;
  db.save();
  audit.record(req, 'kv.set', req.params.coll, req.params.key);
  res.json({ ok: true });
});
router.delete('/kv/:coll/:key', auth.requirePerm('admin'), (req, res) => {
  const c = db.data.collections[req.params.coll];
  if (!c || !(req.params.key in c)) throw httpError(404, 'Not found');
  delete c[req.params.key];
  if (!Object.keys(c).length) delete db.data.collections[req.params.coll];
  db.save();
  audit.record(req, 'kv.delete', req.params.coll, req.params.key);
  res.json({ ok: true });
});

module.exports = router;

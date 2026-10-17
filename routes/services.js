// Service CRUD, lifecycle, logs, packages, schedules, backups, deploys, metrics, Discord tools, AI, SQLite.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const pm = require('../lib/processManager');
const services = require('../lib/services');
const logStore = require('../lib/logStore');
const diagnostics = require('../lib/diagnostics');
const installer = require('../lib/installer');
const templates = require('../lib/templates');
const backups = require('../lib/backups');
const deploys = require('../lib/deploys');
const pipeline = require('../lib/pipeline');
const gitLib = require('../lib/git');
const metrics = require('../lib/metrics');
const scheduler = require('../lib/scheduler');
const cron = require('../lib/cron');
const sqlite = require('../lib/sqlite');
const discordApi = require('../lib/discordApi');
const aiAssist = require('../lib/aiAssist');
const { normalizeService, publicService, TYPES, RESTART_POLICIES, PORTABLE_FIELDS } = require('../lib/serviceModel');
const { slugify, assertId, resolveInside } = require('../lib/safePath');
const { httpError } = require('../lib/errors');
const { service, bool, str } = require('./_util');

const router = express.Router();

function view(svc) {
  return { ...publicService(svc), state: pm.state(svc.id), diagnostics: diagnostics.list(svc.id) };
}

// ----- list / create -----
router.get('/', (req, res) => {
  res.json(Object.values(db.data.services).filter(s => auth.can(req.user, 'service.view', s.id)).map(view));
});

router.get('/templates', (req, res) => {
  res.json({ templates: templates.list(), features: templates.features() });
});

router.post('/', auth.requirePerm('service.create'), async (req, res) => {
  const body = req.body || {};
  const name = str(body.name, 80).trim();
  if (!name) throw httpError(400, 'Give the service a name');
  let id = body.id ? assertId(body.id) : slugify(name);
  if (db.data.services[id]) {
    if (body.id) throw httpError(409, 'A service with that id already exists');
    let n = 2;
    while (db.data.services[`${id}-${n}`]) n++;
    id = `${id}-${n}`.slice(0, 40);
  }
  const dir = services.dir(id);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw httpError(409, `A folder named "${id}" already exists on disk`);
  fs.mkdirSync(dir, { recursive: true });

  let base = { id, name, type: TYPES.includes(body.type) ? body.type : 'discord', createdBy: req.user.username };
  try {
    if (body.source === 'template') {
      const t = templates.apply(body.templateId, dir, { featureIds: Array.isArray(body.features) ? body.features : [] });
      base = { ...base, type: t.type, runtime: t.runtime, entry: t.entry };
    } else {
      base = { ...base, runtime: body.runtime, entry: str(body.entry, 200) || undefined, command: str(body.command, 500) };
    }
    const svc = normalizeService(base);
    if (body.source === 'git') {
      svc.git.url = gitLib.validateRepoUrl(body.gitUrl);
      svc.git.branch = gitLib.validateBranch(body.gitBranch || 'main');
      svc.git.token = str(body.gitToken, 300);
    }
    if (svc.type === 'web') svc.port = services.allocatePort();
    db.data.services[id] = svc;
    if (req.user.role === 'developer' && !req.user.services.includes(id)) req.user.services.push(id);
    db.save();
    audit.record(req, 'service.created', id, body.source === 'template' ? `template ${body.templateId}` : body.source || 'empty');
    logStore.append(id, 'sys', `Service "${name}" created${body.source === 'template' ? ` from template ${body.templateId}` : ''}.`);
    if (body.source === 'git') {
      try { await pipeline.deployGit(id, { by: req, source: 'git' }); } catch (e) {
        logStore.append(id, 'sys', `Initial clone failed: ${e.message}`);
        return res.status(201).json({ ...view(svc), warning: e.message });
      }
    } else if (body.source === 'template') {
      deploys.record(id, { source: 'template', by: req, message: `Created from ${body.templateId}` });
    }
    res.status(201).json(view(svc));
  } catch (e) {
    if (!db.data.services[id]) fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});

// ----- single service -----
router.get('/:id', service(), (req, res) => {
  const out = view(req.svc);
  out.git.webhookUrl = `/api/hooks/github/${req.svc.id}`;
  if (auth.can(req.user, 'service.edit', req.svc.id)) out.git.webhookSecret = req.svc.git.webhookSecret;
  out.supportsFeatures = templates.supportsFeatures(services.dir(req.svc.id));
  out.aiEnabled = aiAssist.enabled();
  out.domains = Object.entries(db.data.domains).filter(([, d]) => d.serviceId === req.svc.id).map(([name, d]) => ({ name, ...d }));
  res.json(out);
});

router.patch('/:id', service('service.edit'), async (req, res) => {
  const svc = req.svc;
  const b = req.body || {};
  const before = JSON.stringify(svc);
  if (b.name !== undefined) svc.name = str(b.name, 80).trim() || svc.name;
  if (b.type !== undefined && TYPES.includes(b.type)) {
    svc.type = b.type;
    if (svc.type === 'web' && !svc.port) svc.port = services.allocatePort();
  }
  if (b.runtime !== undefined && ['node', 'python', 'custom'].includes(b.runtime)) svc.runtime = b.runtime;
  if (b.entry !== undefined) {
    const entry = str(b.entry, 200).trim();
    if (entry) { resolveInside(services.dir(svc.id), entry); svc.entry = entry; }
  }
  if (b.command !== undefined) {
    if (!auth.can(req.user, 'service.exec', svc.id) && b.command !== svc.command) throw httpError(403, 'Only admins can set a custom start command');
    svc.command = str(b.command, 500);
  }
  if (b.nodeArgs !== undefined) svc.nodeArgs = str(b.nodeArgs, 300);
  if (b.buildCommand !== undefined) svc.buildCommand = str(b.buildCommand, 500).trim();
  if (b.buildOnStart !== undefined) svc.buildOnStart = bool(b.buildOnStart);
  if (b.tags !== undefined) svc.tags = normalizeService({ tags: Array.isArray(b.tags) ? b.tags.map(t => String(t).trim()) : [] }).tags;
  if (b.restartPolicy !== undefined && RESTART_POLICIES.includes(b.restartPolicy)) svc.restartPolicy = b.restartPolicy;
  if (b.memoryLimitMb !== undefined) svc.memoryLimitMb = Math.max(0, Math.min(65536, parseInt(b.memoryLimitMb, 10) || 0));
  if (b.memoryAlertPct !== undefined) svc.memoryAlertPct = Math.max(10, Math.min(100, parseInt(b.memoryAlertPct, 10) || 90));
  if (b.autostart !== undefined) svc.autostart = bool(b.autostart);
  if (b.staticRoot !== undefined) { const r = str(b.staticRoot, 200).trim() || '.'; if (r !== '.') resolveInside(services.dir(svc.id), r); svc.staticRoot = r; }
  if (b.spa !== undefined) svc.spa = bool(b.spa);
  if (b.sandbox !== undefined) svc.sandbox = bool(b.sandbox);
  if (b.dailyBackup !== undefined) svc.dailyBackup = bool(b.dailyBackup);
  if (b.statusPage !== undefined) svc.statusPage = bool(b.statusPage);
  if (b.port !== undefined && svc.type === 'web') {
    const p = parseInt(b.port, 10);
    if (!p || p < 1024 || p > 65535) throw httpError(400, 'Port must be 1024-65535');
    if (Object.values(db.data.services).some(s => s.id !== svc.id && s.port === p)) throw httpError(409, 'Another service uses that port');
    svc.port = p;
  }
  if (b.healthCheck) {
    svc.healthCheck = normalizeService({ healthCheck: { ...svc.healthCheck, ...b.healthCheck } }).healthCheck;
    if (!svc.healthCheck.path.startsWith('/')) svc.healthCheck.path = '/' + svc.healthCheck.path;
  }
  if (b.envGroups !== undefined) svc.envGroups = (Array.isArray(b.envGroups) ? b.envGroups : []).filter(g => db.data.envGroups[g]);
  svc.updatedAt = new Date().toISOString();
  db.save();
  if (JSON.stringify(svc) !== before) audit.record(req, 'service.settings', svc.id, Object.keys(b).join(', '));
  res.json(view(svc));
});

router.delete('/:id', service('service.delete'), async (req, res) => {
  const id = req.svc.id;
  await pm.stop(id);
  pm.forget(id);
  fs.rmSync(services.dir(id), { recursive: true, force: true });
  logStore.removeService(id);
  metrics.remove(id);
  if (!bool(req.query.keepBackups)) backups.removeService(id);
  fs.rmSync(services.sqlitePath(id), { force: true });
  delete db.data.services[id];
  delete db.data.deploys[id];
  for (const [name, d] of Object.entries(db.data.domains)) if (d.serviceId === id) delete db.data.domains[name];
  for (const u of Object.values(db.data.users)) u.services = (u.services || []).filter(s => s !== id);
  db.save();
  audit.record(req, 'service.deleted', id);
  res.json({ ok: true });
});

// ----- duplicate / export / activity -----
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (backups.SKIP_DIRS.has(ent.name)) continue;
    const s = path.join(src, ent.name), d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

router.post('/:id/duplicate', auth.requirePerm('service.create'), service('service.edit'), (req, res) => {
  const src = req.svc;
  const name = str(req.body.name, 80).trim() || `${src.name} copy`;
  let id = slugify(name);
  let n = 2;
  while (db.data.services[id] || fs.existsSync(services.dir(id))) id = `${slugify(name)}-${n++}`.slice(0, 40);
  copyTree(services.dir(src.id), services.dir(id));
  const copy = normalizeService({ id, name, createdBy: req.user.username, ...Object.fromEntries(PORTABLE_FIELDS.map(k => [k, src[k]])) });
  copy.envGroups = [...src.envGroups];
  copy.schedules = [];
  if (copy.type === 'web') copy.port = services.allocatePort();
  db.data.services[id] = copy;
  if (req.user.role === 'developer' && !req.user.services.includes(id)) req.user.services.push(id);
  db.save();
  audit.record(req, 'service.duplicated', id, `from ${src.id}`);
  logStore.append(id, 'sys', `Duplicated from "${src.name}". Dependencies install on first start.`);
  res.status(201).json(view(copy));
});

// Download the whole service (code + settings manifest, without secrets or installed deps).
router.get('/:id/export', service('service.edit'), (req, res) => {
  const zip = new (require('adm-zip'))();
  const base = services.dir(req.svc.id);
  const add = rel => {
    for (const ent of fs.readdirSync(rel ? path.join(base, rel) : base, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (!backups.SKIP_DIRS.has(ent.name)) add(r); }
      else if (ent.isFile() && !/^\.env/i.test(ent.name)) zip.addFile(r, fs.readFileSync(path.join(base, r)));
    }
  };
  if (fs.existsSync(base)) add('');
  const envKeys = Object.keys(require('../lib/envFile').readVars(services.envPath(req.svc.id)));
  zip.addFile('omnihost-service.json', Buffer.from(JSON.stringify({
    omnihost: 1, name: req.svc.name, settings: Object.fromEntries(PORTABLE_FIELDS.map(k => [k, req.svc[k]])),
    envKeys, git: { url: req.svc.git.url, branch: req.svc.git.branch }
  }, null, 2)));
  audit.record(req, 'service.exported', req.svc.id);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.svc.id}.zip"`);
  res.end(zip.toBuffer());
});

router.get('/:id/activity', service(), (req, res) => {
  const admin = auth.can(req.user, 'admin');
  res.json(audit.query({ target: req.svc.id, limit: 100 }).map(e => (admin ? e : { ...e, ip: undefined })));
});

// ----- lifecycle -----
router.post('/:id/start', service('service.operate'), async (req, res) => {
  res.json(await pm.start(req.svc.id, { by: req }));
});
router.post('/:id/stop', service('service.operate'), async (req, res) => {
  res.json(await pm.stop(req.svc.id, { by: req }));
});
router.post('/:id/restart', service('service.operate'), async (req, res) => {
  res.json(await pm.restart(req.svc.id, { by: req }));
});
router.post('/:id/stdin', service('service.operate'), (req, res) => {
  const text = str(req.body.text, 4000);
  if (!text) throw httpError(400, 'Nothing to send');
  pm.writeStdin(req.svc.id, text);
  res.json({ ok: true });
});

// ----- logs -----
router.get('/:id/logs', service(), (req, res) => {
  if (req.query.q || req.query.stream) {
    return res.json(logStore.search(req.svc.id, { q: str(req.query.q, 200), stream: ['out', 'err', 'sys'].includes(req.query.stream) ? req.query.stream : '' }));
  }
  res.json(logStore.history(req.svc.id));
});
router.get('/:id/logs/download', service(), (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.svc.id}-logs.txt"`);
  for (const f of logStore.exportFiles(req.svc.id)) res.write(fs.readFileSync(f));
  res.end();
});
router.delete('/:id/logs', service('service.operate'), (req, res) => {
  logStore.clear(req.svc.id);
  res.json({ ok: true });
});

// ----- diagnostics -----
router.delete('/:id/diagnostics/:rule', service('service.operate'), (req, res) => {
  diagnostics.dismiss(req.svc.id, req.params.rule);
  res.json({ ok: true });
});

// ----- packages & commands -----
router.get('/:id/packages', service(), (req, res) => {
  res.json({ ...installer.listPackages(req.svc.id), installing: installer.isBusy(req.svc.id), needsInstall: installer.needsInstall(req.svc.id) });
});
router.get('/:id/packages/outdated', service(), async (req, res) => {
  res.json(await installer.outdated(req.svc.id));
});
router.post('/:id/install', service('service.edit'), async (req, res) => {
  audit.record(req, 'packages.install_all', req.svc.id);
  const r = await installer.install(req.svc.id);
  res.json({ ok: r.code === 0, code: r.code });
});
router.post('/:id/packages', service('service.edit'), async (req, res) => {
  const name = str(req.body.name, 200).trim();
  audit.record(req, 'packages.add', req.svc.id, name);
  const r = await installer.addPackage(req.svc.id, name, { dev: bool(req.body.dev) });
  res.json({ ok: r.code === 0, code: r.code });
});
router.delete('/:id/packages/:name', service('service.edit'), async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  audit.record(req, 'packages.remove', req.svc.id, name);
  const r = await installer.removePackage(req.svc.id, name);
  res.json({ ok: r.code === 0, code: r.code });
});
router.post('/:id/packages/upgrade', service('service.edit'), async (req, res) => {
  const name = str(req.body.name, 200).trim();
  audit.record(req, 'packages.upgrade', req.svc.id, name || 'all');
  const r = await installer.upgrade(req.svc.id, name || null);
  res.json({ ok: r.code === 0, code: r.code });
});
router.post('/:id/packages/audit', service(), async (req, res) => {
  res.json(await installer.audit(req.svc.id));
});
router.post('/:id/packages/audit-fix', service('service.edit'), async (req, res) => {
  audit.record(req, 'packages.audit_fix', req.svc.id);
  const r = await installer.auditFix(req.svc.id);
  res.json({ ok: r.code === 0, code: r.code });
});
router.post('/:id/build', service('service.edit'), async (req, res) => {
  audit.record(req, 'service.build', req.svc.id, req.svc.buildCommand);
  const r = await installer.build(req.svc.id);
  res.json({ ok: r.code === 0, code: r.code });
});
router.post('/:id/run-script', service('service.edit'), async (req, res) => {
  const r = await pipeline.runScript(req.svc.id, str(req.body.script, 100), { by: req });
  res.json({ ok: r.code === 0, code: r.code });
});
router.post('/:id/exec', service('service.exec'), async (req, res) => {
  const r = await pipeline.runCommand(req.svc.id, str(req.body.command, 1000), { by: req });
  res.json({ ok: r.code === 0, code: r.code });
});

// ----- schedules -----
router.get('/:id/schedules', service(), (req, res) => {
  res.json(req.svc.schedules.map(s => ({ ...s, nextRunAt: (() => { try { return cron.nextRun(s.cron); } catch { return null; } })() })));
});
router.post('/:id/schedules', service('service.edit'), (req, res) => {
  if (req.body.action === 'command' && !auth.can(req.user, 'service.exec', req.svc.id)) throw httpError(403, 'Only admins can schedule commands');
  let job;
  try { job = scheduler.normalizeSchedule(req.body); } catch (e) { throw httpError(400, e.message); }
  req.svc.schedules.push(job);
  db.save();
  audit.record(req, 'schedule.created', req.svc.id, `${job.cron} ${job.action}`);
  res.json(job);
});
router.patch('/:id/schedules/:jid', service('service.edit'), (req, res) => {
  const idx = req.svc.schedules.findIndex(s => s.id === req.params.jid);
  if (idx < 0) throw httpError(404, 'Schedule not found');
  const merged = { ...req.svc.schedules[idx], ...req.body, id: req.params.jid };
  if (merged.action === 'command' && !auth.can(req.user, 'service.exec', req.svc.id)) throw httpError(403, 'Only admins can schedule commands');
  try { req.svc.schedules[idx] = scheduler.normalizeSchedule(merged); } catch (e) { throw httpError(400, e.message); }
  db.save();
  res.json(req.svc.schedules[idx]);
});
router.post('/:id/schedules/:jid/run', service('service.operate'), async (req, res) => {
  const job = req.svc.schedules.find(s => s.id === req.params.jid);
  if (!job) throw httpError(404, 'Schedule not found');
  scheduler.runJob(req.svc, job);
  res.json({ ok: true });
});
router.delete('/:id/schedules/:jid', service('service.edit'), (req, res) => {
  req.svc.schedules = req.svc.schedules.filter(s => s.id !== req.params.jid);
  db.save();
  res.json({ ok: true });
});

// ----- backups -----
router.get('/:id/backups', service(), (req, res) => res.json(backups.list(req.svc.id)));
router.post('/:id/backups', service('service.edit'), (req, res) => {
  const rec = backups.create(req.svc.id, { reason: 'manual', by: req.user, note: str(req.body.note, 200) });
  audit.record(req, 'backup.created', req.svc.id, rec.id);
  res.json(rec);
});
router.post('/:id/backups/:bid/restore', service('service.edit'), async (req, res) => {
  res.json(await pipeline.rollback(req.svc.id, req.params.bid, { by: req, source: 'restore' }));
});
router.patch('/:id/backups/:bid', service('service.edit'), (req, res) => {
  res.json(backups.setPinned(req.svc.id, req.params.bid, bool(req.body.pinned)));
});
router.delete('/:id/backups/:bid', service('service.edit'), (req, res) => {
  backups.remove(req.svc.id, req.params.bid);
  audit.record(req, 'backup.deleted', req.svc.id, req.params.bid);
  res.json({ ok: true });
});
router.get('/:id/backups/:bid/download', service('service.edit'), (req, res) => {
  const { file } = backups.filePath(req.svc.id, req.params.bid);
  res.download(file, `${req.svc.id}-${req.params.bid}.zip`);
});

// ----- deploys & git -----
router.get('/:id/deploys', service(), (req, res) => res.json(deploys.list(req.svc.id)));
router.post('/:id/deploys/:did/rollback', service('service.edit'), async (req, res) => {
  const d = (db.data.deploys[req.svc.id] || []).find(x => x.id === req.params.did);
  if (!d || !d.backupId) throw httpError(404, 'That deploy has no snapshot to roll back to');
  res.json(await pipeline.rollback(req.svc.id, d.backupId, { by: req }));
});
router.put('/:id/git', service('service.edit'), async (req, res) => {
  const g = req.svc.git;
  if (req.body.url !== undefined) g.url = req.body.url ? gitLib.validateRepoUrl(req.body.url) : '';
  if (req.body.branch !== undefined) g.branch = gitLib.validateBranch(req.body.branch || 'main');
  if (req.body.token !== undefined && req.body.token !== '••••') g.token = str(req.body.token, 300);
  if (req.body.autoDeploy !== undefined) g.autoDeploy = bool(req.body.autoDeploy);
  if (bool(req.body.regenerateSecret)) g.webhookSecret = crypto.randomBytes(20).toString('hex');
  db.save();
  audit.record(req, 'git.configured', req.svc.id, g.url);
  res.json(view(req.svc).git);
});
router.get('/:id/git/detect', service(), async (req, res) => {
  res.json(await gitLib.detectRemote(req.svc.id));
});
router.post('/:id/git/deploy', service('service.edit'), async (req, res) => {
  res.json(await pipeline.deployGit(req.svc.id, { by: req, source: 'git' }));
});

// ----- metrics -----
router.get('/:id/metrics', service(), (req, res) => {
  const range = ['1h', '6h', '24h', '7d', '30d'].includes(req.query.range) ? req.query.range : '1h';
  res.json({
    range, points: metrics.range(req.svc.id, range),
    uptime: { '24h': metrics.uptime(req.svc.id, '24h'), '7d': metrics.uptime(req.svc.id, '7d'), '30d': metrics.uptime(req.svc.id, '30d') },
    state: pm.state(req.svc.id)
  });
});

// ----- discord tools -----
router.get('/:id/discord', service('service.edit'), async (req, res) => {
  res.json(await discordApi.profile(req.svc));
});
router.get('/:id/discord/guilds', service('service.edit'), async (req, res) => {
  res.json(await discordApi.guilds(req.svc));
});
router.delete('/:id/discord/guilds/:gid', service('service.edit'), async (req, res) => {
  if (!/^\d{15,25}$/.test(req.params.gid)) throw httpError(400, 'Invalid server id');
  await discordApi.leaveGuild(req.svc, req.params.gid);
  audit.record(req, 'discord.left_guild', req.svc.id, req.params.gid);
  res.json({ ok: true });
});
router.post('/:id/features', service('service.edit'), (req, res) => {
  const dir = services.dir(req.svc.id);
  if (!templates.supportsFeatures(dir)) throw httpError(400, 'Feature packs need the slash-command template layout (index.js loading commands/)');
  const result = templates.addFeature(dir, str(req.body.feature, 50));
  audit.record(req, 'feature.added', req.svc.id, result.feature.id);
  deploys.editorSave(req.svc.id, req.user, `feature ${result.feature.id}`);
  logStore.append(req.svc.id, 'sys', `Added feature "${result.feature.name}" (${result.added.join(', ')}). Restart the bot and run "npm run deploy" to register new commands.`);
  res.json(result);
});

// ----- AI assistant -----
router.post('/:id/ai/analyze', service('service.edit'), async (req, res) => {
  audit.record(req, 'ai.analyze', req.svc.id);
  res.json(await aiAssist.analyze(req.svc.id, { file: req.body.file ? str(req.body.file, 300) : undefined }));
});
router.post('/:id/ai/apply', service('service.edit'), (req, res) => {
  const file = str(req.body.file, 300);
  const edits = Array.isArray(req.body.edits) ? req.body.edits.filter(e => typeof e.search === 'string' && typeof e.replace === 'string') : [];
  if (!file || !edits.length) throw httpError(400, 'Nothing to apply');
  backups.create(req.svc.id, { reason: 'pre-ai-fix', by: req.user });
  const r = aiAssist.applyEdits(req.svc.id, file, edits);
  audit.record(req, 'ai.applied', req.svc.id, file);
  deploys.editorSave(req.svc.id, req.user, file);
  res.json(r);
});

// ----- SQLite -----
router.get('/:id/sqlite', service(), (req, res) => res.json({ enabled: req.svc.sqlite, ...sqlite.info(req.svc.id) }));
router.post('/:id/sqlite/enable', service('service.edit'), (req, res) => {
  sqlite.enable(req.svc.id);
  req.svc.sqlite = true;
  db.save();
  audit.record(req, 'sqlite.enabled', req.svc.id);
  logStore.append(req.svc.id, 'sys', 'SQLite database enabled. Its path is available as DATABASE_PATH after the next restart.');
  res.json({ enabled: true, ...sqlite.info(req.svc.id) });
});
router.post('/:id/sqlite/query', service(), (req, res) => {
  const canWrite = auth.can(req.user, 'service.edit', req.svc.id);
  const readOnly = !canWrite || bool(req.body.readOnly);
  if (!readOnly) audit.record(req, 'sqlite.write', req.svc.id, str(req.body.sql, 300));
  res.json(sqlite.query(req.svc.id, req.body.sql, { readOnly, limit: Math.min(5000, parseInt(req.body.limit, 10) || 500) }));
});
router.get('/:id/sqlite/download', service('service.edit'), (req, res) => {
  const file = services.sqlitePath(req.svc.id);
  if (!fs.existsSync(file)) throw httpError(404, 'No database');
  res.download(file, `${req.svc.id}.sqlite`);
});

module.exports = router;

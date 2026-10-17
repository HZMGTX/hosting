// File manager API. Every path is resolved with resolveInside(), so nothing can escape the service folder.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');
const config = require('../lib/config');
const services = require('../lib/services');
const logStore = require('../lib/logStore');
const deploys = require('../lib/deploys');
const pm = require('../lib/processManager');
const audit = require('../lib/audit');
const { resolveInside, toRel, cleanRel } = require('../lib/safePath');
const { httpError } = require('../lib/errors');
const { PORTABLE_FIELDS, normalizeService } = require('../lib/serviceModel');
const { service, bool, str } = require('./_util');

const router = express.Router({ mergeParams: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 2000, fieldSize: 2 * 1024 * 1024 }
});

const HIDDEN_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', '.npm']);
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 5000;

function isBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function readHead(file, bytes = 8000) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

// GET tree: folders + files (no contents). Heavy folders are listed but not expanded.
router.get('/tree', service(), (req, res) => {
  const base = services.dir(req.svc.id);
  fs.mkdirSync(base, { recursive: true });
  const entries = [];
  let truncated = false;
  const walk = rel => {
    if (entries.length >= MAX_TREE_ENTRIES) { truncated = true; return; }
    const full = rel ? path.join(base, rel) : base;
    let list = [];
    try { list = fs.readdirSync(full, { withFileTypes: true }); } catch { return; }
    list.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const ent of list) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        const hidden = HIDDEN_DIRS.has(ent.name);
        entries.push({ path: childRel, type: 'dir', collapsed: hidden });
        if (!hidden) walk(childRel);
      } else if (ent.isFile()) {
        let size = 0;
        try { size = fs.statSync(path.join(full, ent.name)).size; } catch {}
        entries.push({ path: childRel, type: 'file', size });
      }
      if (entries.length >= MAX_TREE_ENTRIES) { truncated = true; return; }
    }
  };
  walk('');
  res.json({ entries, truncated });
});

// .env files hold secrets: only people who may edit the service can read them.
function assertCanReadSecrets(req, rel) {
  if (/(^|\/)\.env[^/]*$/i.test(rel) && !require('../lib/auth').can(req.user, 'service.edit', req.svc.id)) {
    throw httpError(403, 'Viewers cannot read secret files');
  }
}

router.get('/content', service(), (req, res) => {
  const base = services.dir(req.svc.id);
  const file = resolveInside(base, str(req.query.path, 1000));
  assertCanReadSecrets(req, toRel(base, file));
  let stat;
  try { stat = fs.statSync(file); } catch { throw httpError(404, 'File not found'); }
  if (!stat.isFile()) throw httpError(400, 'Not a file');
  const head = readHead(file);
  if (isBinary(head)) return res.json({ path: toRel(base, file), size: stat.size, binary: true, content: null, mtime: stat.mtimeMs });
  if (stat.size > 5 * MAX_EDIT_BYTES) return res.json({ path: toRel(base, file), size: stat.size, binary: false, tooLarge: true, content: null, mtime: stat.mtimeMs });
  res.json({
    path: toRel(base, file), size: stat.size, binary: false, readOnly: stat.size > MAX_EDIT_BYTES,
    content: fs.readFileSync(file, 'utf8'), mtime: stat.mtimeMs
  });
});

router.put('/content', service('service.edit'), async (req, res) => {
  const base = services.dir(req.svc.id);
  const rel = str(req.body.path, 1000);
  const file = resolveInside(base, rel);
  if (typeof req.body.content !== 'string') throw httpError(400, 'content must be text');
  if (Buffer.byteLength(req.body.content) > MAX_EDIT_BYTES) throw httpError(413, 'File is too large to save from the editor');
  // Optimistic concurrency: refuse to overwrite a file someone changed after it was opened.
  if (req.body.expectedMtime && fs.existsSync(file)) {
    const mtime = fs.statSync(file).mtimeMs;
    if (Math.abs(mtime - Number(req.body.expectedMtime)) > 1 && !bool(req.body.force)) throw httpError(409, 'This file changed on disk since you opened it');
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) throw httpError(400, 'A folder with that name exists');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, req.body.content, 'utf8');
  const relPath = toRel(base, file);
  deploys.editorSave(req.svc.id, req.user, relPath);
  audit.record(req, 'file.saved', req.svc.id, relPath);
  let restarted = false;
  if (bool(req.body.restart) && pm.isRunning(req.svc.id) && req.svc.type !== 'static') {
    pm.restart(req.svc.id).catch(() => {});
    restarted = true;
  }
  res.json({ ok: true, path: relPath, mtime: fs.statSync(file).mtimeMs, size: fs.statSync(file).size, restarted });
});

router.post('/mkdir', service('service.edit'), (req, res) => {
  const base = services.dir(req.svc.id);
  const dir = resolveInside(base, str(req.body.path, 1000));
  fs.mkdirSync(dir, { recursive: true });
  audit.record(req, 'file.mkdir', req.svc.id, toRel(base, dir));
  res.json({ ok: true, path: toRel(base, dir) });
});

router.post('/rename', service('service.edit'), (req, res) => {
  const base = services.dir(req.svc.id);
  const from = resolveInside(base, str(req.body.from, 1000));
  const to = resolveInside(base, str(req.body.to, 1000));
  if (!fs.existsSync(from)) throw httpError(404, 'Source not found');
  if (fs.existsSync(to)) throw httpError(409, 'Something already exists at the new path');
  if (to.startsWith(from + path.sep)) throw httpError(400, 'Cannot move a folder into itself');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  logStore.append(req.svc.id, 'sys', `Renamed ${toRel(base, from)} → ${toRel(base, to)}`);
  audit.record(req, 'file.renamed', req.svc.id, `${toRel(base, from)} -> ${toRel(base, to)}`);
  res.json({ ok: true, path: toRel(base, to) });
});

router.delete('/', service('service.edit'), (req, res) => {
  const base = services.dir(req.svc.id);
  const target = resolveInside(base, str(req.query.path, 1000));
  if (!fs.existsSync(target)) throw httpError(404, 'Not found');
  fs.rmSync(target, { recursive: true, force: true });
  logStore.append(req.svc.id, 'sys', `Deleted ${toRel(base, target)}`);
  audit.record(req, 'file.deleted', req.svc.id, toRel(base, target));
  res.json({ ok: true });
});

router.get('/download', service(), (req, res) => {
  const base = services.dir(req.svc.id);
  const rel = cleanRel(str(req.query.path, 1000));
  const target = rel ? resolveInside(base, rel) : base;
  if (!fs.existsSync(target)) throw httpError(404, 'Not found');
  if (rel) assertCanReadSecrets(req, toRel(base, target));
  if (fs.statSync(target).isDirectory()) {
    const zip = new AdmZip();
    const add = (dir, prefix) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (HIDDEN_DIRS.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        const zrel = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) add(full, zrel);
        else if (ent.isFile() && (!/^\.env/i.test(ent.name) || require('../lib/auth').can(req.user, 'service.edit', req.svc.id))) zip.addFile(zrel, fs.readFileSync(full));
      }
    };
    add(target, '');
    const name = `${rel ? path.basename(target) : req.svc.id}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
    return res.end(zip.toBuffer());
  }
  res.download(target, path.basename(target));
});

// Upload files/folders/ZIPs. Optional fields: dir (target folder), paths[] (relative paths for folder uploads), extract.
router.post('/upload', service('service.edit'), upload.array('files'), async (req, res) => {
  const base = services.dir(req.svc.id);
  const targetDir = req.body.dir ? resolveInside(base, req.body.dir) : base;
  const relPaths = [].concat(req.body.paths || []);
  const extract = req.body.extract === undefined ? true : bool(req.body.extract);
  const written = [];
  // Validate every destination before writing anything, so a malicious archive cannot partly apply.
  const plan = [];
  let extractedZip = false;
  (req.files || []).forEach((file, i) => {
    const name = relPaths[i] ? cleanRel(relPaths[i]) : path.basename(file.originalname);
    if (extract && /\.zip$/i.test(file.originalname)) {
      extractedZip = true;
      // ZIP contents always go into the service's main folder, whatever folder it was dropped on.
      for (const item of planZip(file)) plan.push({ target: resolveInside(base, item.rel), data: item.data });
    } else {
      plan.push({ target: resolveInside(targetDir, name), data: () => file.buffer });
    }
  });
  for (const p of plan) {
    fs.mkdirSync(path.dirname(p.target), { recursive: true });
    fs.writeFileSync(p.target, p.data());
    written.push(toRel(base, p.target));
  }
  logStore.append(req.svc.id, 'sys', extractedZip ? `Unzipped ${written.length} file(s) into the main folder.` : `Uploaded ${written.length} file(s).`);
  // A ZIP exported from OmniHost carries its settings in omnihost-service.json: apply them, then drop the file.
  let importedSettings = false;
  const manifestPath = path.join(base, 'omnihost-service.json');
  if (extractedZip && fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.omnihost && manifest.settings && typeof manifest.settings === 'object') {
        const picked = Object.fromEntries(PORTABLE_FIELDS.filter(k => k in manifest.settings).map(k => [k, manifest.settings[k]]));
        // Arbitrary start commands stay an admin-only setting.
        if (!require('../lib/auth').can(req.user, 'service.exec', req.svc.id)) delete picked.command;
        const merged = normalizeService({ ...req.svc, ...picked });
        for (const k of Object.keys(picked)) req.svc[k] = merged[k];
        if (req.svc.type === 'web' && !req.svc.port) req.svc.port = services.allocatePort();
        if (manifest.git && manifest.git.url && !req.svc.git.url) Object.assign(req.svc.git, { url: String(manifest.git.url), branch: String(manifest.git.branch || 'main') });
        require('../db').save();
        importedSettings = true;
        const missing = Array.isArray(manifest.envKeys) ? manifest.envKeys.filter(k => typeof k === 'string') : [];
        logStore.append(req.svc.id, 'sys', `Imported settings from omnihost-service.json.${missing.length ? ` Set these variables in the Environment tab: ${missing.join(', ')}` : ''}`);
      }
    } catch (e) {
      logStore.append(req.svc.id, 'sys', `Ignored omnihost-service.json: ${e.message}`);
    }
    fs.rmSync(manifestPath, { force: true });
    const mi = written.indexOf('omnihost-service.json');
    if (mi >= 0) written.splice(mi, 1);
  }
  // After a project ZIP, point the service at the right start file if the configured one is missing.
  let entry = null;
  if (extractedZip && written.length) {
    entry = services.detectEntry(req.svc);
    if (entry) logStore.append(req.svc.id, 'sys', `Start file set to ${entry.entry} (${entry.runtime === 'python' ? 'Python' : 'Node.js'}).`);
  }
  audit.record(req, 'file.uploaded', req.svc.id, `${written.length} file(s)${extractedZip ? ' from ZIP' : ''}`);
  if (written.length) deploys.record(req.svc.id, { source: 'upload', by: req.user, message: `${extractedZip ? 'Unzipped' : 'Uploaded'} ${written.length} file(s)` });
  res.json({ ok: true, written, extracted: extractedZip, entry: entry && entry.entry, importedSettings });
});

// Files that are never worth extracting: OS junk and installed dependencies (reinstalled on start).
const ZIP_SKIP_DIRS = new Set(['__MACOSX', 'node_modules', '.venv', 'venv', '__pycache__', '.npm']);
const ZIP_SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// List the files in an uploaded ZIP as paths relative to the project root, unwrapping any number of
// wrapper folders ("bot.zip/bot-main/bot/index.js" -> "index.js").
function planZip(file) {
  let zip;
  try { zip = new AdmZip(file.buffer); } catch { throw httpError(400, `${file.originalname} is not a valid ZIP file`); }
  let items = zip.getEntries()
    .filter(e => !e.isDirectory)
    .map(e => ({ rel: e.entryName.replace(/\\/g, '/').replace(/^\/+/, ''), entry: e }))
    .filter(({ rel }) => {
      const parts = rel.split('/');
      return rel && !parts.some(seg => ZIP_SKIP_DIRS.has(seg)) && !ZIP_SKIP_FILES.has(parts[parts.length - 1]);
    });
  if (!items.length) throw httpError(400, `${file.originalname} has no files in it`);
  // Keep stripping the first folder while every file shares it.
  for (;;) {
    const first = items[0].rel.split('/')[0];
    if (!items.every(it => it.rel.includes('/') && it.rel.split('/')[0] === first)) break;
    items = items.map(it => ({ ...it, rel: it.rel.slice(first.length + 1) }));
  }
  return items.map(it => ({ rel: it.rel, data: () => it.entry.getData() }));
}

// Full-text search across text files.
router.get('/search', service(), (req, res) => {
  const q = str(req.query.q, 200);
  if (q.length < 2) throw httpError(400, 'Search for at least 2 characters');
  const base = services.dir(req.svc.id);
  const needle = q.toLowerCase();
  const results = [];
  const walk = rel => {
    if (results.length >= 300) return;
    const full = rel ? path.join(base, rel) : base;
    let list = [];
    try { list = fs.readdirSync(full, { withFileTypes: true }); } catch { return; }
    for (const ent of list) {
      if (results.length >= 300) return;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (!HIDDEN_DIRS.has(ent.name)) walk(childRel); continue; }
      if (!ent.isFile() || ent.name === '.env') continue;
      const fp = path.join(full, ent.name);
      let stat;
      try { stat = fs.statSync(fp); } catch { continue; }
      if (stat.size > 1024 * 1024) continue;
      const buf = fs.readFileSync(fp);
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (results.length < 300 && line.toLowerCase().includes(needle)) results.push({ path: childRel, line: i + 1, text: line.trim().slice(0, 200) });
      });
      if (ent.name.toLowerCase().includes(needle) && !results.some(r => r.path === childRel)) results.push({ path: childRel, line: 0, text: '(file name match)' });
    }
  };
  walk('');
  res.json(results);
});

module.exports = router;

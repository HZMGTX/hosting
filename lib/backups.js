// Service snapshots (ZIP), restore, retention and download.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const config = require('./config');
const db = require('../db');
const services = require('./services');
const logStore = require('./logStore');
const { resolveInside } = require('./safePath');
const { httpError } = require('./errors');
const { notify } = require('./notify');

// Never snapshot installed dependencies or VCS internals — they are restorable.
const SKIP_DIRS = new Set(['node_modules', '.venv', '.git', '__pycache__', '.npm']);

function backupDir(id) {
  const d = path.join(config.BACKUPS_DIR, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function list(id) {
  return (db.data.backups[id] || []).slice().reverse();
}

function addFolder(zip, base, rel = '') {
  const full = rel ? path.join(base, rel) : base;
  for (const ent of fs.readdirSync(full, { withFileTypes: true })) {
    if (ent.isDirectory() && SKIP_DIRS.has(ent.name)) continue;
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) addFolder(zip, base, childRel);
    else if (ent.isFile()) zip.addFile(childRel, fs.readFileSync(path.join(base, childRel)));
  }
}

function create(id, { reason = 'manual', by = 'system', note = '' } = {}) {
  services.get(id);
  const src = services.dir(id);
  if (!fs.existsSync(src)) throw httpError(404, 'Service folder does not exist');
  const bid = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const file = path.join(backupDir(id), `${bid}.zip`);
  try {
    const zip = new AdmZip();
    addFolder(zip, src);
    zip.writeZip(file);
  } catch (e) {
    notify({ level: 'error', event: 'backupFailed', serviceId: id, title: 'Backup failed', message: e.message });
    throw e;
  }
  const rec = {
    id: bid, reason, note, by: require('./audit').actorName(by),
    createdAt: new Date().toISOString(), size: fs.statSync(file).size,
    commit: (db.data.services[id].git || {}).lastCommit || ''
  };
  (db.data.backups[id] = db.data.backups[id] || []).push(rec);
  applyRetention(id);
  db.save();
  logStore.append(id, 'sys', `Backup created (${reason}, ${(rec.size / 1024).toFixed(0)} KB).`);
  return rec;
}

function applyRetention(id) {
  const keep = Math.max(1, (db.data.settings.backups || {}).retention || 10);
  const all = db.data.backups[id] || [];
  // Pinned backups are never deleted automatically.
  const removable = all.filter(b => !b.pinned);
  while (removable.length > keep) {
    const old = removable.shift();
    fs.rmSync(path.join(backupDir(id), `${old.id}.zip`), { force: true });
    all.splice(all.indexOf(old), 1);
  }
}

function filePath(id, bid) {
  const rec = (db.data.backups[id] || []).find(b => b.id === bid);
  if (!rec) throw httpError(404, 'Backup not found');
  const file = path.join(backupDir(id), `${bid}.zip`);
  if (!fs.existsSync(file)) throw httpError(404, 'Backup file is missing on disk');
  return { rec, file };
}

// Replace the service folder contents with a snapshot. Keeps node_modules/.venv/.git to avoid reinstalling.
function restoreFiles(id, bid) {
  const { file } = filePath(id, bid);
  const dest = services.dir(id);
  const zip = new AdmZip(file);
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  // Validate everything first so a bad archive cannot half-apply.
  const targets = entries.map(e => ({ e, target: resolveInside(dest, e.entryName) }));
  for (const ent of fs.readdirSync(dest, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    fs.rmSync(path.join(dest, ent.name), { recursive: true, force: true });
  }
  for (const { e, target } of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.getData());
  }
  logStore.append(id, 'sys', `Restored files from backup ${bid}.`);
}

function remove(id, bid) {
  const { rec, file } = filePath(id, bid);
  fs.rmSync(file, { force: true });
  db.data.backups[id] = (db.data.backups[id] || []).filter(b => b !== rec);
  db.save();
}

function setPinned(id, bid, pinned) {
  const { rec } = filePath(id, bid);
  rec.pinned = !!pinned;
  db.save();
  return rec;
}

function removeService(id) {
  fs.rmSync(path.join(config.BACKUPS_DIR, id), { recursive: true, force: true });
  delete db.data.backups[id];
}

module.exports = { create, list, restoreFiles, filePath, remove, setPinned, removeService, SKIP_DIRS };

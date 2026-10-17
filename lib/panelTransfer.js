// Whole-panel export/import: move every service (code, .env, settings, SQLite data) between installs,
// e.g. from your PC to Railway. Accounts, sessions and API tokens are never exported.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('./config');
const db = require('../db');
const services = require('./services');
const logStore = require('./logStore');
const { normalizeService } = require('./serviceModel');
const { isValidId, resolveInside } = require('./safePath');
const { httpError } = require('./errors');

const SKIP_DIRS = new Set(['node_modules', '.venv', '__pycache__', '.npm']);
const FORMAT = 'omnihost-panel-export';

function addDir(zip, base, prefix) {
  if (!fs.existsSync(base)) return;
  const walk = rel => {
    for (const ent of fs.readdirSync(rel ? path.join(base, rel) : base, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(r); }
      else if (ent.isFile()) zip.addFile(`${prefix}/${r}`, fs.readFileSync(path.join(base, r)));
    }
  };
  walk('');
}

function exportPanel({ includeBackups = false } = {}) {
  const zip = new AdmZip();
  const d = db.data;
  const ids = Object.keys(d.services);
  const manifest = {
    format: FORMAT, version: 1, exportedAt: new Date().toISOString(),
    services: d.services, envGroups: d.envGroups, domains: d.domains, monitors: d.monitors,
    collections: d.collections, deploys: d.deploys,
    backups: includeBackups ? d.backups : {},
    settings: { alerts: d.settings.alerts, statusPage: d.settings.statusPage, backups: d.settings.backups, logs: d.settings.logs }
  };
  zip.addFile('omnihost-export.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  for (const id of ids) {
    addDir(zip, services.dir(id), `services/${id}`);
    const sqlite = services.sqlitePath(id);
    if (fs.existsSync(sqlite)) zip.addFile(`databases/${id}.sqlite`, fs.readFileSync(sqlite));
    if (includeBackups) addDir(zip, path.join(config.BACKUPS_DIR, id), `backups/${id}`);
  }
  return zip.toBuffer();
}

// Import into this install. Services whose id already exists are skipped (never overwritten).
function importPanel(buffer, { by = 'system' } = {}) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { throw httpError(400, 'That is not a valid ZIP file'); }
  const manifestEntry = zip.getEntry('omnihost-export.json');
  if (!manifestEntry) throw httpError(400, 'This ZIP is not an OmniHost panel export (omnihost-export.json is missing)');
  let manifest;
  try { manifest = JSON.parse(manifestEntry.getData().toString('utf8')); } catch { throw httpError(400, 'The export manifest is unreadable'); }
  if (manifest.format !== FORMAT) throw httpError(400, 'Unsupported export format');

  const d = db.data;
  const report = { imported: [], skipped: [], envGroups: 0, domains: 0, monitors: 0 };
  const incoming = Object.values(manifest.services || {}).filter(s => s && isValidId(s.id));
  const toImport = incoming.filter(s => {
    if (d.services[s.id] || fs.existsSync(services.dir(s.id))) { report.skipped.push(s.id); return false; }
    return true;
  });
  const wanted = new Set(toImport.map(s => s.id));

  // Validate every path before writing anything.
  const writes = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/\\/g, '/');
    let m;
    if ((m = name.match(/^services\/([^/]+)\/(.+)$/)) && wanted.has(m[1])) {
      writes.push({ target: resolveInside(services.dir(m[1]), m[2]), entry: e });
    } else if ((m = name.match(/^databases\/([^/]+)\.sqlite$/)) && wanted.has(m[1])) {
      writes.push({ target: services.sqlitePath(m[1]), entry: e });
    } else if ((m = name.match(/^backups\/([^/]+)\/([^/]+\.zip)$/)) && wanted.has(m[1])) {
      writes.push({ target: resolveInside(path.join(config.BACKUPS_DIR, m[1]), m[2]), entry: e });
    }
  }
  for (const w of writes) {
    fs.mkdirSync(path.dirname(w.target), { recursive: true });
    fs.writeFileSync(w.target, w.entry.getData());
  }

  const usedPorts = new Set(Object.values(d.services).map(s => s.port).filter(Boolean));
  for (const raw of toImport) {
    const svc = normalizeService(raw);
    fs.mkdirSync(services.dir(svc.id), { recursive: true });
    if (svc.type === 'web' && (!svc.port || usedPorts.has(svc.port))) svc.port = services.allocatePort();
    if (svc.port) usedPorts.add(svc.port);
    svc.envGroups = svc.envGroups.filter(g => (manifest.envGroups || {})[g] || d.envGroups[g]);
    d.services[svc.id] = svc;
    if (manifest.deploys && Array.isArray(manifest.deploys[svc.id])) d.deploys[svc.id] = manifest.deploys[svc.id];
    if (manifest.backups && Array.isArray(manifest.backups[svc.id])) d.backups[svc.id] = manifest.backups[svc.id];
    logStore.append(svc.id, 'sys', `Imported from a panel export by ${by && by.username ? by.username : by}.`);
    report.imported.push(svc.id);
  }
  for (const [gid, g] of Object.entries(manifest.envGroups || {})) {
    if (!d.envGroups[gid] && g && typeof g.vars === 'object') { d.envGroups[gid] = g; report.envGroups++; }
  }
  for (const [name, dm] of Object.entries(manifest.domains || {})) {
    if (!d.domains[name] && dm && d.services[dm.serviceId]) { d.domains[name] = dm; report.domains++; }
  }
  for (const [mid, mon] of Object.entries(manifest.monitors || {})) {
    if (!d.monitors[mid] && mon && mon.type) { d.monitors[mid] = mon; report.monitors++; }
  }
  for (const [c, docs] of Object.entries(manifest.collections || {})) {
    if (/^[A-Za-z0-9_-]{1,40}$/.test(c)) d.collections[c] = { ...(docs || {}), ...(d.collections[c] || {}) };
  }
  if (manifest.settings && manifest.settings.alerts && !d.settings.alerts.discordWebhook && !d.settings.alerts.httpWebhook) {
    d.settings.alerts = { ...d.settings.alerts, ...manifest.settings.alerts, events: { ...d.settings.alerts.events, ...(manifest.settings.alerts.events || {}) } };
  }
  db.save();
  return report;
}

module.exports = { exportPanel, importPanel };

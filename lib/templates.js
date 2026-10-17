// Starter templates and Discord feature packs.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const envFile = require('./envFile');
const { httpError } = require('./errors');
const { resolveInside } = require('./safePath');

const FEATURES_DIR = path.join(config.TEMPLATES_DIR, '_features');

function list() {
  return fs.readdirSync(config.TEMPLATES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_'))
    .map(d => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(config.TEMPLATES_DIR, d.name, 'template.json'), 'utf8'));
        return { id: d.name, ...meta };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (a.order || 99) - (b.order || 99));
}

function get(id) {
  const t = list().find(x => x.id === id);
  if (!t) throw httpError(404, 'Template not found');
  return t;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === 'template.json') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

function features() {
  return JSON.parse(fs.readFileSync(path.join(FEATURES_DIR, 'features.json'), 'utf8'));
}

// Copy a template into a service folder. Existing files are never overwritten.
function apply(templateId, destDir, { featureIds = [] } = {}) {
  const t = get(templateId);
  copyDir(path.join(config.TEMPLATES_DIR, t.id), destDir);
  const envUpdates = {};
  const current = envFile.readVars(path.join(destDir, '.env'));
  for (const [k, v] of Object.entries(t.env || {})) if (!(k in current)) envUpdates[k] = v;
  if (Object.keys(envUpdates).length) envFile.writeVars(path.join(destDir, '.env'), envUpdates);
  for (const fid of featureIds) addFeature(destDir, fid);
  return t;
}

function addFeature(destDir, featureId) {
  const f = features().find(x => x.id === featureId);
  if (!f) throw httpError(404, `Unknown feature "${featureId}"`);
  const added = [];
  for (const [target, source] of Object.entries(f.files)) {
    const dest = resolveInside(destDir, target);
    if (fs.existsSync(dest)) throw httpError(409, `${target} already exists — remove it first to reinstall this feature`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(FEATURES_DIR, source), dest);
    added.push(target);
  }
  if (f.env) {
    const current = envFile.readVars(path.join(destDir, '.env'));
    const updates = {};
    for (const [k, v] of Object.entries(f.env)) if (!(k in current)) updates[k] = v;
    if (Object.keys(updates).length) envFile.writeVars(path.join(destDir, '.env'), updates);
  }
  return { feature: f, added };
}

// A feature pack only works with the file-based loader from the slash-command template.
function supportsFeatures(destDir) {
  try {
    const src = fs.readFileSync(path.join(destDir, 'index.js'), 'utf8');
    return src.includes("loadModules('commands')");
  } catch { return false; }
}

module.exports = { list, get, apply, features, addFeature, supportsFeatures };

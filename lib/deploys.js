// Deploy history: every code change gets an entry with a snapshot that can be rolled back to.
const crypto = require('crypto');
const db = require('../db');
const backups = require('./backups');
const logStore = require('./logStore');
const { notify } = require('./notify');

const MAX_ENTRIES = 100;
const EDITOR_SNAPSHOT_DELAY_MS = 60 * 1000;
const editorTimers = new Map();

function list(id) {
  return (db.data.deploys[id] || []).slice().reverse();
}

// source: git | upload | editor | template | restore | rollback | webhook
function record(id, { source, by = 'system', commit = '', message = '', status = 'success', snapshot = true }) {
  const entry = {
    id: crypto.randomBytes(5).toString('hex'),
    at: new Date().toISOString(),
    source, status,
    by: require('./audit').actorName(by),
    commit, message: String(message || '').slice(0, 300),
    backupId: null
  };
  if (snapshot && status === 'success') {
    try { entry.backupId = backups.create(id, { reason: `deploy:${source}`, by }).id; } catch (e) {
      logStore.append(id, 'sys', `Could not snapshot this deploy: ${e.message}`);
    }
  }
  const arr = (db.data.deploys[id] = db.data.deploys[id] || []);
  arr.push(entry);
  if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
  db.save();
  if (['git', 'webhook', 'rollback', 'upload'].includes(source)) {
    notify({
      level: status === 'success' ? 'success' : 'error', event: 'deploy', serviceId: id,
      title: status === 'success' ? `Deployed (${source})` : `Deploy failed (${source})`,
      message: [commit && commit.slice(0, 7), message].filter(Boolean).join(' — ')
    });
  }
  return entry;
}

// Editor saves are grouped: one history entry + one snapshot a minute after the last save.
function editorSave(id, by, file) {
  const arr = (db.data.deploys[id] = db.data.deploys[id] || []);
  let entry = arr[arr.length - 1];
  const recent = entry && entry.source === 'editor' && !entry.backupId && Date.now() - Date.parse(entry.at) < 10 * 60 * 1000;
  if (!recent) {
    entry = record(id, { source: 'editor', by, message: `Edited ${file}`, snapshot: false });
  } else {
    const files = new Set(entry.message.replace(/^Edited /, '').split(', '));
    files.add(file);
    entry.message = 'Edited ' + [...files].slice(0, 8).join(', ');
    entry.at = new Date().toISOString();
    db.save();
  }
  clearTimeout(editorTimers.get(id));
  editorTimers.set(id, setTimeout(() => {
    editorTimers.delete(id);
    try {
      if (!db.data.services[id]) return;
      entry.backupId = backups.create(id, { reason: 'deploy:editor', by }).id;
      db.save();
    } catch {}
  }, EDITOR_SNAPSHOT_DELAY_MS));
}

module.exports = { list, record, editorSave };

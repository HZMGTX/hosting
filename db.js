// OmniHost persistence layer: one JSON document, cached in memory, written atomically.
const fs = require('fs');
const path = require('path');
const config = require('./lib/config');
const envFile = require('./lib/envFile');
const { normalizeService } = require('./lib/serviceModel');
const { isValidId } = require('./lib/safePath');

const DB_VERSION = 2;

function defaults() {
  return {
    version: DB_VERSION,
    users: {},
    sessions: {},
    invites: {},
    apiTokens: {},
    services: {},
    envGroups: {},
    domains: {},
    monitors: {},
    backups: {},
    deploys: {},
    notifications: [],
    audit: [],
    collections: {},
    settings: {
      alerts: {
        discordWebhook: '',
        httpWebhook: '',
        events: { crash: true, crashLoop: true, recovered: true, memory: true, deploy: true, backupFailed: true, healthCheck: true, monitor: true }
      },
      statusPage: { enabled: false, title: 'Service Status' },
      backups: { retention: 10, dailyHour: 3 },
      logs: { maxSizeMb: 5, keepFiles: 3 },
      nextPort: config.APP_PORT_START
    }
  };
}

let data = null;
let saveTimer = null;

function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function mergeDefaults(target, base) {
  for (const [k, v] of Object.entries(base)) {
    if (target[k] === undefined) target[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      mergeDefaults(target[k], v);
    }
  }
  return target;
}

// Old (v1) format: fake seed data + plaintext tokens in bots.json/database.json.
function migrateV1(old) {
  const fresh = defaults();
  const botsJson = path.join(config.SERVICES_DIR, 'bots.json');
  let legacyBots = {};
  try { legacyBots = JSON.parse(fs.readFileSync(botsJson, 'utf8')); } catch {}
  const fromDb = (old && old.bots) || {};
  const report = [];

  const folders = fs.existsSync(config.SERVICES_DIR)
    ? fs.readdirSync(config.SERVICES_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    : [];

  for (const id of folders) {
    if (!isValidId(id)) { report.push(`skipped folder with unsupported name "${id}"`); continue; }
    const legacy = { ...(fromDb[id] || {}), ...(legacyBots[id] || {}) };
    const dir = path.join(config.SERVICES_DIR, id);
    // Move any stored token into the bot's own .env (only if it doesn't have one already).
    if (legacy.token) {
      const envPath = path.join(dir, '.env');
      const vars = envFile.readVars(envPath);
      if (!vars.DISCORD_BOT_TOKEN && !vars.DISCORD_TOKEN) envFile.writeVars(envPath, { DISCORD_BOT_TOKEN: legacy.token });
    }
    let entry = legacy.entry || 'index.js';
    if (!fs.existsSync(path.join(dir, entry)) && fs.existsSync(path.join(dir, 'main.py'))) entry = 'main.py';
    fresh.services[id] = normalizeService({
      id, name: legacy.name || id, type: 'discord', entry, autostart: true, createdAt: legacy.updatedAt
    });
    report.push(`imported service "${id}"`);
  }
  for (const id of Object.keys(legacyBots)) {
    if (!fresh.services[id]) report.push(`dropped orphan bot entry "${id}" (no folder on disk)`);
  }

  // Keep backups of the originals, with tokens stripped so they aren't duplicated in plaintext.
  const strip = obj => JSON.parse(JSON.stringify(obj || {}, (k, v) => (k === 'token' && v ? '[moved to the service .env]' : v)));
  if (fs.existsSync(botsJson)) {
    writeAtomic(botsJson + '.bak', JSON.stringify(strip(legacyBots), null, 2));
    fs.unlinkSync(botsJson);
  }
  if (old) writeAtomic(config.DB_FILE + '.v1.bak', JSON.stringify(strip(old), null, 2));

  fresh.audit.push({ id: Date.now().toString(36), at: new Date().toISOString(), user: 'system', action: 'migrate.v1', target: '', details: report.join('; ') });
  console.log('[db] Migrated v1 database:', report.join('; ') || 'nothing to import');
  return fresh;
}

function load() {
  let raw = null;
  if (fs.existsSync(config.DB_FILE)) {
    try { raw = JSON.parse(fs.readFileSync(config.DB_FILE, 'utf8')); } catch (e) {
      const broken = config.DB_FILE + '.corrupt-' + Date.now();
      fs.copyFileSync(config.DB_FILE, broken);
      console.error(`[db] database.json was unreadable (${e.message}); copied to ${broken} and starting fresh.`);
    }
  }
  if (!raw || raw.version !== DB_VERSION) {
    data = migrateV1(raw);
    saveNow();
  } else {
    data = mergeDefaults(raw, defaults());
    for (const id of Object.keys(data.services)) data.services[id] = normalizeService(data.services[id]);
  }
  return data;
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeAtomic(config.DB_FILE, JSON.stringify(data, null, 2));
}

// Debounced save: many quick mutations become one disk write.
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try { saveNow(); } catch (e) { console.error('[db] save failed:', e.message); }
  }, 150);
}

const db = {
  load,
  save,
  saveNow,
  get data() { return data || load(); },
  defaults
};

module.exports = db;

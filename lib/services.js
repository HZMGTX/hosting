// Service registry helpers: folders, env assembly, port allocation.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('../db');
const envFile = require('./envFile');
const { baseEnv } = require('./exec');
const { httpError } = require('./errors');
const { assertId } = require('./safePath');

function dir(id) {
  assertId(id, 'service id');
  return path.join(config.SERVICES_DIR, id);
}

function get(id) {
  const s = db.data.services[id];
  if (!s) throw httpError(404, 'Service not found');
  return s;
}

function envPath(id) {
  return path.join(dir(id), '.env');
}

function sqlitePath(id) {
  return path.join(config.SQLITE_DIR, `${id}.sqlite`);
}

function allocatePort() {
  const used = new Set(Object.values(db.data.services).map(s => s.port).filter(Boolean));
  let port = Math.max(config.APP_PORT_START, db.data.settings.nextPort || config.APP_PORT_START);
  while (used.has(port) || port === config.PORT) port++;
  db.data.settings.nextPort = port + 1;
  db.save();
  return port;
}

// Variables from attached env groups (in attach order), then the service's own .env on top.
function groupVars(service) {
  const out = {};
  for (const gid of service.envGroups || []) {
    const g = db.data.envGroups[gid];
    if (g) Object.assign(out, g.vars);
  }
  return out;
}

function buildEnv(service) {
  const id = service.id;
  const own = envFile.readVars(envPath(id));
  const env = { ...baseEnv(), ...groupVars(service), ...own };
  // Universal token aliases so templates and imported bots both find it.
  if (env.DISCORD_TOKEN && !env.DISCORD_BOT_TOKEN) env.DISCORD_BOT_TOKEN = env.DISCORD_TOKEN;
  if (env.DISCORD_BOT_TOKEN && !env.DISCORD_TOKEN) env.DISCORD_TOKEN = env.DISCORD_BOT_TOKEN;
  env.OMNIHOST_SERVICE_ID = id;
  env.OMNIHOST = '1';
  if (service.type === 'web') {
    if (!service.port) service.port = allocatePort();
    env.PORT = String(service.port);
    env.HOST = '127.0.0.1';
    env.BASE_PATH = `/apps/${id}`;
  }
  if (service.sqlite) env.DATABASE_PATH = sqlitePath(id);
  // Fallback module resolution: the bot's own node_modules first, then the panel's (has discord.js).
  env.NODE_PATH = [path.join(dir(id), 'node_modules'), path.join(config.ROOT, 'node_modules')].join(path.delimiter);
  env.PYTHONUNBUFFERED = '1';
  return env;
}

function readPackageJson(id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir(id), 'package.json'), 'utf8')); } catch { return null; }
}

// If the configured start file doesn't exist (e.g. after uploading a project ZIP), find the real one
// from package.json or common names and update the service. Returns { entry, runtime } or null.
function detectEntry(svc) {
  if (svc.type === 'static' || svc.runtime === 'custom' || svc.type === 'custom') return null;
  const d = dir(svc.id);
  if (fs.existsSync(path.join(d, svc.entry))) return null;
  const candidates = [];
  const pkg = readPackageJson(svc.id);
  if (pkg) {
    const start = pkg.scripts && pkg.scripts.start && pkg.scripts.start.match(/^\s*node\s+(?:--?\S+\s+)*([^\s&|;]+\.(?:m?js|cjs))/);
    if (start) candidates.push(start[1]);
    if (typeof pkg.main === 'string') candidates.push(pkg.main);
  }
  candidates.push('index.js', 'bot.js', 'main.js', 'app.js', 'server.js', 'src/index.js', 'src/bot.js', 'src/main.js', 'dist/index.js',
    'main.py', 'bot.py', 'app.py', 'run.py', 'src/main.py', 'src/bot.py');
  const found = candidates.map(c => c.replace(/^\.\//, '')).find(c => {
    const full = path.resolve(d, c);
    return full.startsWith(path.resolve(d) + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile();
  });
  if (!found) return null;
  svc.entry = found;
  svc.runtime = /\.py$/i.test(found) ? 'python' : 'node';
  svc.updatedAt = new Date().toISOString();
  db.save();
  return { entry: svc.entry, runtime: svc.runtime };
}

module.exports = { dir, get, envPath, sqlitePath, allocatePort, groupVars, buildEnv, readPackageJson, detectEntry };

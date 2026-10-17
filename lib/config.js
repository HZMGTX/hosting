// Central runtime configuration, read once from environment variables.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';
const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT);
const SYSTEM_DIR = path.join(DATA_DIR, '.omnihost');

const config = {
  ROOT,
  isProd,
  PORT: parseInt(process.env.PORT, 10) || 3000,
  // Locally the panel is only reachable from this PC; in Docker/production it listens publicly.
  HOST: process.env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
  DATA_DIR,
  SYSTEM_DIR,
  SERVICES_DIR: path.join(DATA_DIR, 'hosted_bots'),
  DB_FILE: path.join(DATA_DIR, 'database.json'),
  LOGS_DIR: path.join(SYSTEM_DIR, 'logs'),
  BACKUPS_DIR: path.join(SYSTEM_DIR, 'backups'),
  METRICS_DIR: path.join(SYSTEM_DIR, 'metrics'),
  SQLITE_DIR: path.join(SYSTEM_DIR, 'databases'),
  TMP_DIR: path.join(SYSTEM_DIR, 'tmp'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  TEMPLATES_DIR: path.join(ROOT, 'lib', 'templates'),
  APP_PORT_START: parseInt(process.env.APP_PORT_START, 10) || 4100,
  PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  OMNI_AI_MODEL: process.env.OMNI_AI_MODEL || 'claude-opus-5-5',
  MAX_UPLOAD_MB: parseInt(process.env.MAX_UPLOAD_MB, 10) || 100,
  SESSION_SECRET: ''
};

for (const dir of [config.SERVICES_DIR, config.SYSTEM_DIR, config.LOGS_DIR, config.BACKUPS_DIR,
  config.METRICS_DIR, config.SQLITE_DIR, config.TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// A stable secret is needed to sign webhook/invite material. Use the env var when given,
// otherwise generate one and keep it in the data volume so it survives restarts.
const secretFile = path.join(SYSTEM_DIR, 'secret.key');
if (process.env.SESSION_SECRET) {
  config.SESSION_SECRET = process.env.SESSION_SECRET;
} else if (fs.existsSync(secretFile)) {
  config.SESSION_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
} else {
  config.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretFile, config.SESSION_SECRET, { mode: 0o600 });
}

// Panel-only secrets that must never leak into hosted service processes.
config.PANEL_ONLY_ENV = ['SESSION_SECRET', 'ANTHROPIC_API_KEY', 'OMNI_AI_MODEL', 'DATA_DIR', 'PUBLIC_URL',
  'APP_PORT_START', 'MAX_UPLOAD_MB', 'HOST', 'PORT', 'RAILWAY_TOKEN'];

module.exports = config;

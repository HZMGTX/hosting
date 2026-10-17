// Shape & defaults of a hosted service record (stored in db.services).
const crypto = require('crypto');

const TYPES = ['discord', 'web', 'static', 'worker', 'custom'];
const RUNTIMES = ['node', 'python', 'custom'];
const RESTART_POLICIES = ['always', 'on-failure', 'never'];

function inferRuntime(entry) {
  return /\.py$/i.test(entry || '') ? 'python' : 'node';
}

function normalizeService(input) {
  const s = input || {};
  const entry = typeof s.entry === 'string' && s.entry.trim() ? s.entry.trim() : 'index.js';
  const type = TYPES.includes(s.type) ? s.type : 'discord';
  let runtime = RUNTIMES.includes(s.runtime) ? s.runtime : inferRuntime(entry);
  if (s.command && runtime !== 'custom' && type === 'custom') runtime = 'custom';
  const now = new Date().toISOString();
  return {
    id: s.id,
    name: (s.name || s.id || '').toString().slice(0, 80),
    type,
    runtime,
    entry,
    command: typeof s.command === 'string' ? s.command : '',
    buildCommand: typeof s.buildCommand === 'string' ? s.buildCommand : '',
    buildOnStart: !!s.buildOnStart,
    tags: Array.isArray(s.tags) ? s.tags.filter(t => typeof t === 'string' && /^[\w -]{1,24}$/.test(t)).slice(0, 8) : [],
    nodeArgs: typeof s.nodeArgs === 'string' ? s.nodeArgs : '',
    restartPolicy: RESTART_POLICIES.includes(s.restartPolicy) ? s.restartPolicy : 'always',
    memoryLimitMb: Math.max(0, parseInt(s.memoryLimitMb, 10) || 0),
    autostart: s.autostart !== false,
    wasRunning: !!s.wasRunning,
    port: Number.isInteger(s.port) ? s.port : null,
    staticRoot: typeof s.staticRoot === 'string' && s.staticRoot ? s.staticRoot : '.',
    spa: s.spa !== false,
    sandbox: s.sandbox !== false,
    healthCheck: {
      enabled: !!(s.healthCheck && s.healthCheck.enabled),
      path: (s.healthCheck && s.healthCheck.path) || '/',
      intervalSec: Math.max(10, parseInt(s.healthCheck && s.healthCheck.intervalSec, 10) || 30),
      failures: Math.max(1, parseInt(s.healthCheck && s.healthCheck.failures, 10) || 3)
    },
    git: {
      url: (s.git && s.git.url) || '',
      branch: (s.git && s.git.branch) || 'main',
      token: (s.git && s.git.token) || '',
      webhookSecret: (s.git && s.git.webhookSecret) || crypto.randomBytes(20).toString('hex'),
      autoDeploy: !(s.git && s.git.autoDeploy === false),
      lastCommit: (s.git && s.git.lastCommit) || '',
      lastMessage: (s.git && s.git.lastMessage) || '',
      lastDeployAt: (s.git && s.git.lastDeployAt) || null
    },
    envGroups: Array.isArray(s.envGroups) ? s.envGroups.filter(x => typeof x === 'string') : [],
    sqlite: !!s.sqlite,
    schedules: Array.isArray(s.schedules) ? s.schedules : [],
    dailyBackup: !!s.dailyBackup,
    statusPage: !!s.statusPage,
    memoryAlertPct: Math.min(100, Math.max(0, parseInt(s.memoryAlertPct, 10) || 90)),
    createdAt: s.createdAt || now,
    updatedAt: s.updatedAt || now,
    createdBy: s.createdBy || null
  };
}

// Public view of a service: never include git tokens or webhook secrets.
function publicService(s) {
  const { git, ...rest } = s;
  return {
    ...rest,
    git: {
      url: git.url, branch: git.branch, autoDeploy: git.autoDeploy, hasToken: !!git.token,
      lastCommit: git.lastCommit, lastMessage: git.lastMessage, lastDeployAt: git.lastDeployAt
    }
  };
}

// Settings that travel with a service when it is duplicated, exported or imported (no secrets, ids or state).
const PORTABLE_FIELDS = ['type', 'runtime', 'entry', 'command', 'nodeArgs', 'buildCommand', 'buildOnStart', 'restartPolicy', 'memoryLimitMb',
  'memoryAlertPct', 'autostart', 'staticRoot', 'spa', 'sandbox', 'healthCheck', 'tags', 'dailyBackup'];

module.exports = { TYPES, RUNTIMES, RESTART_POLICIES, PORTABLE_FIELDS, normalizeService, publicService, inferRuntime };

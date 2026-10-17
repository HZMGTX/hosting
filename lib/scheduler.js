// Minute-tick scheduler: per-service cron jobs + daily backups.
const crypto = require('crypto');
const db = require('../db');
const cron = require('./cron');
const pm = require('./processManager');
const backups = require('./backups');
const pipeline = require('./pipeline');
const logStore = require('./logStore');

const ACTIONS = ['restart', 'start', 'stop', 'backup', 'command', 'deploy'];
let lastTick = '';

function normalizeSchedule(input) {
  const err = cron.validate(input.cron);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  if (!ACTIONS.includes(input.action)) throw Object.assign(new Error('Unknown action'), { status: 400 });
  if (input.action === 'command' && !String(input.command || '').trim()) throw Object.assign(new Error('Command is required'), { status: 400 });
  return {
    id: input.id || crypto.randomBytes(4).toString('hex'),
    cron: String(input.cron).trim(),
    action: input.action,
    command: input.action === 'command' ? String(input.command).trim() : '',
    enabled: input.enabled !== false,
    lastRunAt: input.lastRunAt || null,
    lastResult: input.lastResult || ''
  };
}

async function runJob(svc, job) {
  const id = svc.id;
  logStore.append(id, 'sys', `⏰ Scheduled task: ${job.action}${job.command ? ' ' + job.command : ''} (${job.cron})`);
  job.lastRunAt = new Date().toISOString();
  try {
    switch (job.action) {
      case 'restart': await pm.restart(id); break;
      case 'start': await pm.start(id); break;
      case 'stop': await pm.stop(id); break;
      case 'backup': backups.create(id, { reason: 'scheduled' }); break;
      case 'deploy': await pipeline.deployGit(id, { source: 'schedule' }); break;
      case 'command': {
        const res = await pipeline.runCommand(id, job.command);
        if (res.code !== 0) throw new Error(`exit code ${res.code}`);
        break;
      }
    }
    job.lastResult = 'ok';
  } catch (e) {
    job.lastResult = 'failed: ' + e.message;
    logStore.append(id, 'sys', `Scheduled task failed: ${e.message}`);
  }
  db.save();
}

function tick() {
  const now = new Date();
  const key = now.toISOString().slice(0, 16);
  if (key === lastTick) return;
  lastTick = key;
  const backupHour = (db.data.settings.backups || {}).dailyHour ?? 3;
  for (const svc of Object.values(db.data.services)) {
    for (const job of svc.schedules || []) {
      if (!job.enabled) continue;
      try {
        if (cron.matches(cron.parse(job.cron), now)) runJob(svc, job);
      } catch {}
    }
    if (svc.dailyBackup && now.getHours() === backupHour && now.getMinutes() === 0) {
      try { backups.create(svc.id, { reason: 'daily' }); } catch {}
    }
  }
}

function init() {
  setInterval(tick, 15 * 1000).unref();
}

module.exports = { init, normalizeSchedule, runJob, ACTIONS };

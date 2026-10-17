// High-level operations that combine several modules (deploy, rollback, run command).
const fs = require('fs');
const path = require('path');
const db = require('../db');
const services = require('./services');
const pm = require('./processManager');
const git = require('./git');
const installer = require('./installer');
const backups = require('./backups');
const deploys = require('./deploys');
const logStore = require('./logStore');
const exec = require('./exec');
const audit = require('./audit');
const { httpError } = require('./errors');

// Git deploy: clone (first time) or pull, then install and restart if it was running.
async function deployGit(id, { by = 'system', source = 'git' } = {}) {
  const svc = services.get(id);
  const wasRunning = pm.isRunning(id);
  const isCheckout = fs.existsSync(path.join(services.dir(id), '.git'));
  try {
    const info = isCheckout ? await git.pull(id) : await git.clone(id, { by });
    if (installer.needsInstall(id) || (isCheckout && info.changed)) await installer.install(id);
    if (svc.buildCommand) {
      const built = await installer.build(id);
      if (built.code !== 0) throw httpError(400, `Build failed (exit ${built.code}) — see the console`);
    }
    if (wasRunning) await pm.restart(id);
    const entry = deploys.record(id, { source, by, commit: info.commit, message: info.message });
    audit.record(by, 'deploy.git', id, `${info.commit.slice(0, 7)} ${info.message}`);
    return { ...info, deploy: entry, restarted: wasRunning, service: svc.id };
  } catch (e) {
    deploys.record(id, { source, by, status: 'failed', message: e.message, snapshot: false });
    throw e;
  }
}

// Roll back to the snapshot of a previous deploy (or any backup).
async function rollback(id, backupId, { by = 'system', source = 'rollback' } = {}) {
  services.get(id);
  const wasRunning = pm.isRunning(id);
  if (wasRunning) await pm.stop(id, { keepRunningFlag: true });
  backups.create(id, { reason: 'pre-restore', by });
  backups.restoreFiles(id, backupId);
  if (installer.needsInstall(id)) await installer.install(id);
  if (wasRunning) await pm.start(id);
  audit.record(by, source === 'rollback' ? 'deploy.rollback' : 'backup.restore', id, backupId);
  return deploys.record(id, { source, by, message: `Restored snapshot ${backupId}` });
}

// One-off commands and package.json scripts, streamed to the service console.
const jobs = new Map(); // id -> { child-like promise }
async function runCommand(id, commandLine, { by = 'system' } = {}) {
  const svc = services.get(id);
  if (jobs.has(id)) throw httpError(409, 'A command is already running for this service');
  const argv = exec.splitArgs(commandLine);
  if (!argv.length) throw httpError(400, 'Command is empty');
  const spec = exec.resolveCommand(argv, services.dir(id));
  logStore.append(id, 'sys', `$ ${commandLine}`);
  audit.record(by, 'service.exec', id, commandLine);
  const p = exec.run(spec, {
    cwd: services.dir(id),
    env: services.buildEnv(svc),
    timeoutMs: 15 * 60 * 1000,
    onLine: (line, k) => logStore.append(id, k, line)
  }).then(res => {
    logStore.append(id, 'sys', `Command finished with exit code ${res.code}.`);
    return res;
  }).finally(() => jobs.delete(id));
  jobs.set(id, p);
  return p;
}

async function runScript(id, script, opts) {
  const pkg = services.readPackageJson(id);
  if (!pkg || !pkg.scripts || !pkg.scripts[script]) throw httpError(404, `No script named "${script}" in package.json`);
  return runCommand(id, `npm run ${JSON.stringify(script)}`, opts);
}

module.exports = { deployGit, rollback, runCommand, runScript, isJobRunning: id => jobs.has(id) };

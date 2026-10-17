// Real GitHub/Git deploys: clone, pull, redeploy, webhook signature verification.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const db = require('../db');
const services = require('./services');
const logStore = require('./logStore');
const exec = require('./exec');
const backups = require('./backups');
const { httpError } = require('./errors');

const running = new Set();

function validateRepoUrl(url) {
  if (typeof url !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[\w.@:/~-]+?(\.git)?\/?$/.test(url.trim())) {
    throw httpError(400, 'Use an https:// repository URL, e.g. https://github.com/you/your-bot');
  }
  return url.trim().replace(/\/+$/, '');
}

function validateBranch(branch) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    throw httpError(400, 'Invalid branch name');
  }
  return branch;
}

// Credentials go in a one-off header instead of the remote URL so they are never written to .git/config.
function gitArgs(svc, args) {
  const pre = ['-c', 'core.askPass=', '-c', 'credential.helper='];
  if (svc.git.token) {
    const basic = Buffer.from(`x-access-token:${svc.git.token}`).toString('base64');
    pre.push('-c', `http.extraHeader=Authorization: Basic ${basic}`);
  }
  return [...pre, ...args];
}

function gitEnv() {
  return { ...exec.baseEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };
}

async function git(id, args, { cwd, quiet = false } = {}) {
  const svc = services.get(id);
  const res = await exec.run({ cmd: 'git', args: gitArgs(svc, args) }, {
    cwd: cwd || services.dir(id),
    env: gitEnv(),
    timeoutMs: 5 * 60 * 1000,
    onLine: quiet ? null : (line, k) => logStore.append(id, k === 'err' ? 'out' : 'out', line.replace(/x-access-token:[^@\s]+/g, 'x-access-token:***'))
  });
  return res;
}

async function headInfo(id) {
  const sha = (await git(id, ['rev-parse', 'HEAD'], { quiet: true })).output.trim();
  const msg = (await git(id, ['log', '-1', '--pretty=%s'], { quiet: true })).output.trim();
  return { commit: /^[0-9a-f]{7,40}$/.test(sha) ? sha : '', message: msg.split('\n')[0] || '' };
}

async function detectRemote(id) {
  const d = services.dir(id);
  if (!fs.existsSync(path.join(d, '.git'))) return null;
  const url = (await git(id, ['remote', 'get-url', 'origin'], { quiet: true })).output.trim();
  const branch = (await git(id, ['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true })).output.trim();
  return { url: url.startsWith('http') ? url : '', branch: /^[\w./-]+$/.test(branch) ? branch : 'main' };
}

async function lock(id, fn) {
  if (running.has(id)) throw httpError(409, 'A deploy is already running for this service');
  running.add(id);
  try { return await fn(); } finally { running.delete(id); }
}

// First-time connect: snapshot whatever is there, then replace it with a fresh clone (keeping .env).
async function clone(id, { by } = {}) {
  return lock(id, async () => {
    const svc = services.get(id);
    const d = services.dir(id);
    const url = validateRepoUrl(svc.git.url);
    const branch = validateBranch(svc.git.branch || 'main');
    fs.mkdirSync(d, { recursive: true });
    const hasFiles = fs.readdirSync(d).some(n => n !== '.env');
    if (hasFiles) backups.create(id, { reason: 'pre-clone', by });

    const tmp = path.join(config.TMP_DIR, `clone-${id}-${Date.now()}`);
    logStore.append(id, 'sys', `Cloning ${url} (branch ${branch})…`);
    const res = await git(id, ['clone', '--depth', '1', '--branch', branch, '--', url, tmp], { cwd: config.TMP_DIR });
    if (res.code !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw httpError(400, 'git clone failed — check the URL, branch and (for private repos) the access token. Details are in the console.');
    }
    for (const name of fs.readdirSync(d)) {
      if (name === '.env' || name === 'node_modules' || name === '.venv') continue;
      fs.rmSync(path.join(d, name), { recursive: true, force: true });
    }
    for (const name of fs.readdirSync(tmp)) {
      if (name === '.env' && fs.existsSync(path.join(d, '.env'))) continue; // never overwrite real secrets
      fs.renameSync(path.join(tmp, name), path.join(d, name));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    const info = await headInfo(id);
    Object.assign(svc.git, { lastCommit: info.commit, lastMessage: info.message, lastDeployAt: new Date().toISOString() });
    db.save();
    logStore.append(id, 'sys', `✓ Cloned ${info.commit.slice(0, 7)} — ${info.message}`);
    return info;
  });
}

// Update to the newest commit on the branch. Untracked files like .env survive reset --hard.
async function pull(id) {
  return lock(id, async () => {
    const svc = services.get(id);
    const d = services.dir(id);
    if (!fs.existsSync(path.join(d, '.git'))) throw httpError(400, 'This service is not a git checkout yet — connect a repository first');
    const branch = validateBranch(svc.git.branch || 'main');
    if (svc.git.url) {
      await git(id, ['remote', 'set-url', 'origin', validateRepoUrl(svc.git.url)], { quiet: true });
    }
    logStore.append(id, 'sys', `Fetching origin/${branch}…`);
    const fetchRes = await git(id, ['fetch', '--depth', '1', 'origin', branch]);
    if (fetchRes.code !== 0) throw httpError(400, 'git fetch failed — see the console for details');
    const before = svc.git.lastCommit;
    const reset = await git(id, ['reset', '--hard', 'FETCH_HEAD']);
    if (reset.code !== 0) throw httpError(400, 'git reset failed — see the console for details');
    const info = await headInfo(id);
    Object.assign(svc.git, { lastCommit: info.commit, lastMessage: info.message, lastDeployAt: new Date().toISOString() });
    db.save();
    logStore.append(id, 'sys', info.commit === before ? 'Already up to date.' : `✓ Updated to ${info.commit.slice(0, 7)} — ${info.message}`);
    return { ...info, changed: info.commit !== before };
  });
}

function verifySignature(secret, rawBody, header) {
  if (!secret || !header || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { clone, pull, detectRemote, verifySignature, validateRepoUrl, validateBranch, isBusy: id => running.has(id) };

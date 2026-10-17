// Command helpers: resolve node/npm/python executables and run commands without a shell.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const isWin = process.platform === 'win32';

// npm on Windows is a .cmd shim that cannot be spawned without a shell, so run npm-cli.js with node directly.
function npmCommand(args) {
  const cli = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].find(p => fs.existsSync(p));
  if (cli) return { cmd: process.execPath, args: [cli, ...args] };
  return { cmd: isWin ? 'npm.cmd' : 'npm', args, needsShell: isWin };
}

function pythonCommand(serviceDir) {
  const venvPy = isWin ? path.join(serviceDir, '.venv', 'Scripts', 'python.exe') : path.join(serviceDir, '.venv', 'bin', 'python');
  if (serviceDir && fs.existsSync(venvPy)) return venvPy;
  return process.env.PYTHON || (isWin ? 'python' : 'python3');
}

// Split a command line into argv, honouring "double" and 'single' quotes. No shell expansion.
function splitArgs(str) {
  const out = [];
  let cur = '', quote = null, has = false;
  for (const ch of String(str || '')) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

// Map a user command line to an executable. "node"/"npm"/"npx"/"python" get special handling.
function resolveCommand(argv, serviceDir) {
  const [first, ...rest] = argv;
  if (!first) throw new Error('Empty command');
  if (first === 'node') return { cmd: process.execPath, args: rest };
  if (first === 'npm') return npmCommand(rest);
  if (first === 'npx') return npmCommand(['exec', '--yes', '--', ...rest]);
  if (first === 'python' || first === 'python3' || first === 'py') return { cmd: pythonCommand(serviceDir), args: rest };
  if (first === 'pip' || first === 'pip3') return { cmd: pythonCommand(serviceDir), args: ['-m', 'pip', ...rest] };
  return { cmd: first, args: rest };
}

// Environment for child processes: panel secrets removed.
function baseEnv() {
  const env = { ...process.env };
  for (const k of config.PANEL_ONLY_ENV) delete env[k];
  return env;
}

// Run to completion, streaming lines to onLine. Resolves { code, output }.
function run(cmdSpec, { cwd, env, onLine, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise(resolve => {
    let output = '';
    let child;
    try {
      child = spawn(cmdSpec.cmd, cmdSpec.args, {
        cwd, env: env || baseEnv(), shell: !!cmdSpec.needsShell, windowsHide: true, detached: !isWin
      });
    } catch (e) {
      if (onLine) onLine(`Failed to start ${cmdSpec.cmd}: ${e.message}`, 'err');
      return resolve({ code: -1, output: e.message });
    }
    const timer = setTimeout(() => {
      if (onLine) onLine(`Command timed out after ${Math.round(timeoutMs / 1000)}s`, 'err');
      killTree(child.pid);
    }, timeoutMs);
    const pipe = (stream, kind) => {
      let partial = '';
      stream.on('data', chunk => {
        const text = partial + chunk.toString();
        output += chunk.toString();
        if (output.length > 2_000_000) output = output.slice(-1_000_000);
        const lines = text.split(/\r?\n/);
        partial = lines.pop();
        for (const l of lines) if (l.trim() && onLine) onLine(l, kind);
      });
      stream.on('end', () => { if (partial.trim() && onLine) onLine(partial, kind); });
    };
    pipe(child.stdout, 'out');
    pipe(child.stderr, 'err');
    child.on('error', e => {
      clearTimeout(timer);
      if (onLine) onLine(`Failed to start ${path.basename(cmdSpec.cmd)}: ${e.message}`, 'err');
      resolve({ code: -1, output: output + e.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

// Kill a process and everything it spawned.
function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  if (isWin) {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, shell: false }); } catch {}
    return;
  }
  try { process.kill(-pid, signal); } catch {
    try { process.kill(pid, signal); } catch {}
  }
}

module.exports = { isWin, npmCommand, pythonCommand, splitArgs, resolveCommand, baseEnv, run, killTree };

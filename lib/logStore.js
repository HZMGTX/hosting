// Per-service log buffer (memory) + rotating log files on disk + search.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('../db');
const bus = require('./bus');

const BUFFER_LINES = 1000;
const buffers = new Map();   // serviceId -> [{t, s, m}]
const streams = new Map();   // serviceId -> { stream, size }

function logPath(id, n = 0) {
  return path.join(config.LOGS_DIR, n ? `${id}.log.${n}` : `${id}.log`);
}

function settings() {
  const s = db.data.settings.logs || {};
  return { maxBytes: Math.max(1, s.maxSizeMb || 5) * 1024 * 1024, keepFiles: Math.max(0, s.keepFiles ?? 3) };
}

function rotate(id) {
  const st = streams.get(id);
  if (st) { st.stream.end(); streams.delete(id); }
  const { keepFiles } = settings();
  try {
    if (keepFiles === 0) { fs.rmSync(logPath(id), { force: true }); return; }
    fs.rmSync(logPath(id, keepFiles), { force: true });
    for (let i = keepFiles - 1; i >= 1; i--) {
      if (fs.existsSync(logPath(id, i))) fs.renameSync(logPath(id, i), logPath(id, i + 1));
    }
    if (fs.existsSync(logPath(id))) fs.renameSync(logPath(id), logPath(id, 1));
  } catch (e) {
    console.warn('[logs] rotate failed:', e.message);
  }
}

function getStream(id) {
  let st = streams.get(id);
  if (!st) {
    let size = 0;
    try { size = fs.statSync(logPath(id)).size; } catch {}
    st = { stream: fs.createWriteStream(logPath(id), { flags: 'a' }), size };
    st.stream.on('error', e => console.warn('[logs] write failed:', e.message));
    streams.set(id, st);
  }
  return st;
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

// stream: 'out' | 'err' | 'sys'
function append(id, stream, text) {
  const entry = { t: Date.now(), s: stream, m: String(text).slice(0, 8000) };
  let buf = buffers.get(id);
  if (!buf) { buf = []; buffers.set(id, buf); }
  buf.push(entry);
  if (buf.length > BUFFER_LINES) buf.splice(0, buf.length - BUFFER_LINES);

  const line = `${new Date(entry.t).toISOString()} [${stream}] ${stripAnsi(entry.m)}\n`;
  const st = getStream(id);
  st.stream.write(line);
  st.size += Buffer.byteLength(line);
  if (st.size > settings().maxBytes) rotate(id);

  bus.emit('log', { serviceId: id, entry });
  return entry;
}

function history(id) {
  if (!buffers.has(id)) {
    // Warm the buffer from the newest log file so history survives panel restarts.
    const lines = tailFile(logPath(id), BUFFER_LINES);
    buffers.set(id, lines.map(parseLine).filter(Boolean));
  }
  return buffers.get(id);
}

function parseLine(raw) {
  const m = raw.match(/^(\S+) \[(out|err|sys)\] (.*)$/);
  if (!m) return null;
  return { t: Date.parse(m[1]) || 0, s: m[2], m: m[3] };
}

function tailFile(file, maxLines) {
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (stat.size > size) lines.shift(); // first line may be partial
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function clear(id) {
  buffers.set(id, []);
}

// Full-text search across the live file and rotated files (newest first).
function search(id, { q = '', stream = '', limit = 500 } = {}) {
  const needle = q.toLowerCase();
  const results = [];
  const { keepFiles } = settings();
  for (let n = 0; n <= keepFiles && results.length < limit; n++) {
    const file = logPath(id, n);
    if (!fs.existsSync(file)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      const e = parseLine(lines[i]);
      if (!e) continue;
      if (stream && e.s !== stream) continue;
      if (needle && !e.m.toLowerCase().includes(needle)) continue;
      results.push(e);
    }
  }
  return results;
}

function exportFiles(id) {
  const { keepFiles } = settings();
  const files = [];
  for (let n = keepFiles; n >= 0; n--) if (fs.existsSync(logPath(id, n))) files.push(logPath(id, n));
  return files;
}

function removeService(id) {
  const st = streams.get(id);
  if (st) { st.stream.end(); streams.delete(id); }
  buffers.delete(id);
  for (let n = 0; n <= 10; n++) fs.rmSync(logPath(id, n), { force: true });
}

module.exports = { append, history, clear, search, exportFiles, removeService, stripAnsi };

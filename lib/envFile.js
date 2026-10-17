// .env parsing/serialising that preserves comments, blank lines and key order.
const fs = require('fs');

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)?\s*$/;

function unquote(raw) {
  const v = (raw || '').trim();
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1);
  // Unquoted: strip trailing " # comment"
  const hash = v.search(/\s#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

function quote(value) {
  const v = String(value ?? '');
  if (v === '' || /^[A-Za-z0-9_./:@,+-]*$/.test(v)) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
}

function parseLines(text) {
  return String(text || '').split(/\r?\n/).map(raw => {
    const m = raw.match(LINE_RE);
    if (m && !raw.trim().startsWith('#')) return { type: 'kv', key: m[1], value: unquote(m[2]), raw };
    return { type: 'other', raw };
  });
}

function parse(text) {
  const out = {};
  for (const line of parseLines(text)) if (line.type === 'kv') out[line.key] = line.value;
  return out;
}

// Apply updates ({KEY: value} sets, {KEY: null} deletes) without disturbing anything else.
function update(text, updates) {
  const lines = parseLines(text);
  const pending = { ...updates };
  const result = [];
  for (const line of lines) {
    if (line.type === 'kv' && Object.prototype.hasOwnProperty.call(pending, line.key)) {
      const val = pending[line.key];
      delete pending[line.key];
      if (val === null || val === undefined) continue;
      result.push(`${line.key}=${quote(val)}`);
    } else {
      result.push(line.raw);
    }
  }
  while (result.length && result[result.length - 1].trim() === '') result.pop();
  for (const [key, val] of Object.entries(pending)) {
    if (val === null || val === undefined) continue;
    result.push(`${key}=${quote(val)}`);
  }
  return result.join('\n') + '\n';
}

function readFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function readVars(file) {
  return parse(readFile(file));
}

function writeVars(file, updates) {
  fs.writeFileSync(file, update(readFile(file), updates), 'utf8');
}

function mask(value) {
  const v = String(value ?? '');
  if (!v) return '';
  if (v.length <= 6) return '•'.repeat(v.length);
  return v.slice(0, 3) + '•'.repeat(Math.min(12, v.length - 5)) + v.slice(-2);
}

module.exports = { parse, update, quote, readVars, writeVars, readFile, mask };

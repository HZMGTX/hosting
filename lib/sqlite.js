// Built-in per-service SQLite databases using Node's node:sqlite (no extra dependency).
const fs = require('fs');
const services = require('./services');
const { httpError } = require('./errors');

let DatabaseSync = null;
function driver() {
  if (!DatabaseSync) {
    const emit = process.emitWarning;
    process.emitWarning = () => {}; // silence the "SQLite is experimental" notice
    try { ({ DatabaseSync } = require('node:sqlite')); } finally { process.emitWarning = emit; }
  }
  return DatabaseSync;
}

function open(id, { readOnly = false, create = false } = {}) {
  const file = services.sqlitePath(id);
  if (!fs.existsSync(file) && !create) throw httpError(404, 'This service has no database yet — enable it first');
  const Db = driver();
  const conn = new Db(file, { readOnly });
  conn.exec('PRAGMA busy_timeout = 3000');
  if (!readOnly) conn.exec('PRAGMA journal_mode = WAL');
  return conn;
}

function enable(id) {
  const conn = open(id, { create: true });
  conn.close();
  return services.sqlitePath(id);
}

function info(id) {
  const file = services.sqlitePath(id);
  if (!fs.existsSync(file)) return { exists: false, path: file, tables: [] };
  const conn = open(id, { readOnly: true });
  try {
    const tables = conn.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(t => {
        let rows = null;
        try { rows = conn.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get().n; } catch {}
        const columns = conn.prepare(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`).all()
          .map(c => ({ name: c.name, type: c.type, pk: !!c.pk, notnull: !!c.notnull }));
        return { name: t.name, type: t.type, rows, columns, sql: t.sql };
      });
    return { exists: true, path: file, size: fs.statSync(file).size, tables };
  } finally {
    conn.close();
  }
}

function serialize(v) {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `<blob ${v.length} bytes>`;
  return v;
}

// Run one statement (or a script of several when it has no result set).
function query(id, sql, { readOnly = true, limit = 500 } = {}) {
  const text = String(sql || '').trim();
  if (!text) throw httpError(400, 'Query is empty');
  const conn = open(id, { readOnly });
  const started = process.hrtime.bigint();
  try {
    let stmt;
    try {
      stmt = conn.prepare(text);
    } catch (e) {
      // prepare() only accepts one statement; run multi-statement scripts with exec().
      if (/more than one statement|multiple statements/i.test(e.message) || text.split(';').filter(s => s.trim()).length > 1) {
        if (readOnly) throw httpError(400, 'Read-only mode runs one statement at a time');
        conn.exec(text);
        return { columns: [], rows: [], changes: null, ms: Number(process.hrtime.bigint() - started) / 1e6, script: true };
      }
      throw httpError(400, e.message);
    }
    const columns = typeof stmt.columns === 'function' ? stmt.columns().map(c => c.name) : [];
    if (columns.length) {
      const rows = [];
      let truncated = false;
      for (const row of stmt.iterate()) {
        if (rows.length >= limit) { truncated = true; break; }
        rows.push(columns.map(c => serialize(row[c])));
      }
      return { columns, rows, truncated, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    }
    const r = stmt.run();
    return { columns: [], rows: [], changes: Number(r.changes), lastInsertRowid: serialize(r.lastInsertRowid), ms: Number(process.hrtime.bigint() - started) / 1e6 };
  } catch (e) {
    if (e.status) throw e;
    throw httpError(400, e.message);
  } finally {
    conn.close();
  }
}

module.exports = { enable, info, query };

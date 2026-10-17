// Built-in SQLite database: enable, browse tables, run SQL.
import { h, icon, mount, btn, toast, busy, empty, fmtBytes, copyField, badge } from '../../ui.js';
import { api, svcUrl } from '../../api.js';
import { store } from '../../store.js';
import { createEditor } from '../../components/editor.js';

export async function databaseTab(root, svc) {
  const id = svc.id;
  const canEdit = store.can('edit', id);
  let info;
  try { info = await api.get(svcUrl(id, '/sqlite')); } catch (e) { return mount(root, empty('alert', 'Could not load database', e.message)); }

  if (!info.enabled || !info.exists) {
    const enable = btn('Enable SQLite database', { variant: 'primary', icon: 'database', disabled: !canEdit });
    enable.addEventListener('click', busy(enable, async () => {
      await api.post(svcUrl(id, '/sqlite/enable'));
      toast('Database created. Restart the service so it sees DATABASE_PATH.', 'success');
      databaseTab(root, { ...svc, sqlite: true });
    }));
    return mount(root, h('div', { class: 'card' }, empty('database', 'Built-in SQLite database',
      'Give this service its own SQLite file, stored outside the code folder so deploys and rollbacks never touch it. Its path is passed to your code as DATABASE_PATH.',
      h('div', null, enable, h('p', { class: 'small muted mt' }, 'Node: new (require("node:sqlite").DatabaseSync)(process.env.DATABASE_PATH) · Python: sqlite3.connect(os.environ["DATABASE_PATH"])')))));
  }

  const result = h('div', { class: 'mt' });
  let readOnly = !canEdit;
  const editor = createEditor({ value: info.tables[0] ? `SELECT * FROM "${info.tables[0].name}" LIMIT 100;` : 'CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);', path: 'query.sql', onSave: () => run() });

  async function run() {
    const sql = editor.getValue().trim();
    if (!sql) return;
    try {
      const r = await api.post(svcUrl(id, '/sqlite/query'), { sql, readOnly });
      if (r.columns.length) {
        mount(result,
          h('div', { class: 'small muted mb-sm' }, `${r.rows.length} row(s)${r.truncated ? ' (truncated)' : ''} · ${r.ms.toFixed(1)} ms`),
          h('div', { class: 'sql-result' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, r.columns.map(c => h('th', null, c)))),
            h('tbody', null, r.rows.map(row => h('tr', null, row.map(v => h('td', { title: v === null ? 'NULL' : String(v) }, v === null ? h('span', { class: 'sql-null' }, 'NULL') : String(v)))))))));
      } else {
        mount(result, h('div', { class: 'callout success' }, icon('check', 16), h('div', { class: 'callout-body' }, h('p', null, r.script ? `Script executed in ${r.ms.toFixed(1)} ms.` : `${r.changes} row(s) changed in ${r.ms.toFixed(1)} ms.`))));
        refreshTables();
      }
    } catch (e) {
      mount(result, h('div', { class: 'callout error' }, icon('alert', 16), h('div', { class: 'callout-body' }, h('p', { class: 'mono' }, e.message))));
    }
  }

  const tablesBox = h('div');
  async function refreshTables() {
    info = await api.get(svcUrl(id, '/sqlite'));
    renderTables();
  }
  function renderTables() {
    mount(tablesBox, info.tables.length ? h('div', { class: 'list' }, info.tables.map(t => h('div', {
      class: 'list-item', style: { cursor: 'pointer' }, title: t.sql || '',
      onClick: () => { editor.setValue(`SELECT * FROM "${t.name}" LIMIT 100;`); run(); }
    }, icon(t.type === 'view' ? 'eye' : 'database', 14), h('div', { class: 'grow' }, h('div', { class: 'mono small' }, t.name), h('div', { class: 'tiny faint ellipsis' }, t.columns.map(c => c.name + (c.pk ? '*' : '')).join(', '))), h('span', { class: 'tiny muted' }, t.rows ?? '')))) : h('p', { class: 'small muted' }, 'No tables yet.'));
  }
  renderTables();

  const runBtn = btn('Run', { variant: 'primary', icon: 'play' });
  runBtn.addEventListener('click', busy(runBtn, run));

  mount(root, h('div', { class: 'sql-layout' },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, icon('database', 16), 'Tables'), btn('', { size: 'sm', variant: 'ghost', icon: 'refresh', title: 'Refresh', onClick: refreshTables })),
      tablesBox, h('hr'),
      h('div', { class: 'small muted' }, `Size: ${fmtBytes(info.size)}`),
      h('div', { class: 'mt-sm' }, h('div', { class: 'tiny faint mb-sm' }, 'DATABASE_PATH'), copyField(info.path)),
      canEdit ? h('a', { class: 'btn sm mt', href: svcUrl(id, '/sqlite/download') }, icon('download', 14), 'Download .sqlite') : null),
    h('div', { class: 'card', style: { minWidth: 0 } },
      h('div', { class: 'card-head' }, h('h3', null, icon('terminal', 16), 'SQL'),
        h('div', { class: 'row' },
          canEdit ? h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: readOnly, onChange: e => { readOnly = e.target.checked; } }), 'Read-only') : badge('Read-only', 'info'),
          runBtn)),
      h('div', { style: { height: '170px', display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } }, editor.el),
      h('div', { class: 'tiny faint mt-sm' }, 'Ctrl+S runs the query. Write queries are recorded in the audit log.'),
      result)));
  return () => editor.destroy();
}

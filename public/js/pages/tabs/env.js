// Environment variables editor: key/value rows (masked secrets) or raw .env text, plus shared groups.
import { h, icon, mount, btn, toast, busy, empty } from '../../ui.js';
import { api, svcUrl } from '../../api.js';
import { store } from '../../store.js';
import { createEditor } from '../../components/editor.js';

export async function envTab(root, svc, q) {
  const id = svc.id;
  const canEdit = store.can('edit', id);
  let data;
  let revealed = false;
  let mode = 'table';
  const original = new Map();
  let rows = [];
  let groupsList = [];

  async function load() {
    data = await api.get(svcUrl(id, `/env${revealed ? '?reveal=1' : ''}`));
    original.clear();
    for (const v of data.vars) original.set(v.key, v.value);
    rows = data.vars.map(v => ({ key: v.key, value: v.value, secret: v.secret, orig: v.key }));
    render();
  }

  function rowEl(r) {
    const keyIn = h('input', { class: 'input mono', value: r.key, placeholder: 'KEY', 'aria-label': 'Variable name', disabled: !canEdit, onInput: e => { r.key = e.target.value.trim(); } });
    const valIn = h('input', {
      class: 'input mono', value: r.value, placeholder: 'value', 'aria-label': `Value of ${r.key}`, disabled: !canEdit,
      type: r.secret && !revealed && r.value ? 'password' : 'text', autocomplete: 'off',
      onInput: e => { r.value = e.target.value; }, onFocus: e => { if (r.secret && r.value.includes('•')) e.target.select(); }
    });
    const el = h('div', { class: 'input-group mb-sm' },
      h('div', { style: { flex: '0 0 34%' } }, keyIn), h('div', { class: 'grow' }, valIn),
      canEdit ? btn('', { variant: 'ghost', icon: 'trash', title: 'Remove', onClick: () => { rows = rows.filter(x => x !== r); el.remove(); } }) : null);
    if (q.focus && r.key === q.focus) setTimeout(() => { valIn.focus(); valIn.select(); }, 50);
    return el;
  }

  async function saveTable() {
    const updates = {};
    const seen = new Set();
    for (const r of rows) {
      if (!r.key) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(r.key)) throw new Error(`"${r.key}" is not a valid variable name`);
      if (seen.has(r.key)) throw new Error(`${r.key} appears twice`);
      seen.add(r.key);
      if (r.orig && r.orig !== r.key) updates[r.orig] = null;
      if (original.get(r.key) !== r.value || r.orig !== r.key) updates[r.key] = r.value;
    }
    for (const k of original.keys()) if (!seen.has(k)) updates[k] = null;
    if (!Object.keys(updates).length) return toast('No changes', 'info');
    await api.patch(svcUrl(id, '/env'), { vars: updates });
    toast('Environment saved. Restart the service to apply.', 'success');
    await load();
  }

  async function renderRaw(holder) {
    const { text } = await api.get(svcUrl(id, '/env/raw'));
    const ed = createEditor({ value: text, path: '.env', readOnly: !canEdit, onSave: () => saveRaw() });
    async function saveRaw() {
      await api.put(svcUrl(id, '/env/raw'), { text: ed.getValue() });
      toast('.env saved. Restart the service to apply.', 'success');
    }
    const saveBtn = btn('Save .env', { variant: 'primary', icon: 'save' });
    saveBtn.addEventListener('click', busy(saveBtn, saveRaw));
    mount(holder, h('div', { style: { height: '360px', display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' } }, ed.el),
      canEdit ? h('div', { class: 'form-actions' }, saveBtn) : null);
  }

  function render() {
    const listHolder = h('div');
    if (mode === 'raw') renderRaw(listHolder).catch(e => mount(listHolder, h('p', { class: 'lvl-error' }, e.message)));
    else mount(listHolder, rows.length ? rows.map(rowEl) : h('p', { class: 'muted small' }, 'No variables yet.'));
    const saveBtn = btn('Save changes', { variant: 'primary', icon: 'save' });
    saveBtn.addEventListener('click', busy(saveBtn, saveTable));

    mount(root,
      h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)' } },
        h('div', { class: 'card' },
          h('div', { class: 'card-head' },
            h('div', null, h('h2', null, icon('key', 18), 'Variables'), h('p', null, 'Stored in this service\'s .env file. Never shown to other services.')),
            h('div', { class: 'row' },
              h('div', { class: 'seg' }, ['table', 'raw'].map(m => h('button', { class: mode === m ? 'active' : '', disabled: m === 'raw' && !canEdit, onClick: () => { mode = m; render(); } }, m === 'table' ? 'Table' : 'Raw .env'))),
              mode === 'table' && canEdit ? btn(revealed ? 'Hide' : 'Reveal', { size: 'sm', icon: revealed ? 'eyeOff' : 'eye', onClick: async () => { revealed = !revealed; await load(); } }) : null)),
          svc.type === 'discord' && !rows.some(r => (r.key === 'DISCORD_BOT_TOKEN' || r.key === 'DISCORD_TOKEN') && r.value)
            ? h('div', { class: 'callout warning' }, icon('alert', 18), h('div', { class: 'callout-body' }, h('strong', null, 'Bot token missing'), h('p', null, 'Add DISCORD_BOT_TOKEN from the Discord Developer Portal → your app → Bot → Reset Token.'))) : null,
          listHolder,
          mode === 'table' && canEdit ? h('div', { class: 'row between mt' },
            btn('Add variable', { icon: 'plus', onClick: () => { const r = { key: '', value: '', secret: false, orig: null }; rows.push(r); const el = rowEl(r); listHolder.querySelector('p') ? mount(listHolder, el) : listHolder.appendChild(el); el.querySelector('input').focus(); } }),
            saveBtn) : null),
        h('div', { class: 'col gap-lg' },
          h('div', { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', null, icon('layers', 16), 'Shared groups')),
            data.inherited.length ? h('div', { class: 'list' }, data.inherited.map(v => h('div', { class: 'list-item small' },
              h('span', { class: 'mono grow ellipsis', style: { textDecoration: v.overridden ? 'line-through' : 'none' } }, v.key),
              h('span', { class: 'mono faint ellipsis', style: { maxWidth: '45%' } }, v.value)))) : h('p', { class: 'muted small' }, 'No shared groups attached.'),
            canEdit ? h('div', { class: 'mt-sm' }, ...(groupsList || []).map(g => h('label', { class: 'check' },
              h('input', { type: 'checkbox', checked: data.groups.includes(g.id), onChange: async e => {
                const next = e.target.checked ? [...data.groups, g.id] : data.groups.filter(x => x !== g.id);
                await api.patch(svcUrl(id), { envGroups: next });
                await load();
              } }), h('span', null, g.name, h('span', { class: 'desc' }, `${g.vars.length} variable(s)`)))),
            !(groupsList || []).length ? h('a', { href: '#/env-groups', class: 'small' }, 'Create a shared group →') : null) : null),
          h('div', { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', null, icon('info', 16), 'Provided automatically')),
            h('div', { class: 'list' }, data.system.map(k => h('div', { class: 'list-item mono small' }, k))),
            h('p', { class: 'small muted mt-sm' }, 'DISCORD_TOKEN and DISCORD_BOT_TOKEN are aliased, so either name works.')))));
  }

  try {
    groupsList = await api.get('/api/env-groups');
  } catch { groupsList = []; }
  try { await load(); } catch (e) { mount(root, empty('alert', 'Could not load variables', e.message)); }
}

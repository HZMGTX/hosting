// Backups: snapshots of the service folder, restore, pin, download, daily schedule.
import { h, icon, mount, btn, toast, busy, confirmDialog, timeAgo, fmtDate, fmtBytes, badge, empty } from '../../ui.js';
import { api, svcUrl } from '../../api.js';
import { store } from '../../store.js';

const REASON = { manual: 'Manual', daily: 'Daily', scheduled: 'Scheduled', 'pre-restore': 'Before restore', 'pre-clone': 'Before git clone', 'pre-ai-fix': 'Before AI fix' };

export async function backupsTab(root, svc) {
  const id = svc.id;
  const canEdit = store.can('edit', id);
  const list = h('div');

  async function load() {
    const items = await api.get(svcUrl(id, '/backups'));
    mount(list, items.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Created'), h('th', null, 'Reason'), h('th', null, 'Size'), h('th', null, 'Commit'), h('th', null, ''))),
      h('tbody', null, items.map(b => {
        const restore = btn('Restore', { size: 'sm', icon: 'restart', disabled: !canEdit });
        restore.addEventListener('click', busy(restore, async () => {
          if (!(await confirmDialog(`Restore the snapshot from ${fmtDate(b.createdAt)}?`, { okLabel: 'Restore', detail: 'Current files are backed up first. Installed dependencies are kept. The service restarts if running.' }))) return;
          await api.post(svcUrl(id, `/backups/${b.id}/restore`));
          toast('Snapshot restored', 'success');
          load();
        }));
        const pin = btn('', { size: 'sm', variant: b.pinned ? 'primary' : 'ghost', icon: 'pin', title: b.pinned ? 'Unpin (allow automatic cleanup)' : 'Pin (keep forever)', disabled: !canEdit });
        pin.addEventListener('click', busy(pin, async () => { await api.patch(svcUrl(id, `/backups/${b.id}`), { pinned: !b.pinned }); load(); }));
        const del = btn('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Delete', disabled: !canEdit });
        del.addEventListener('click', busy(del, async () => { if (await confirmDialog('Delete this backup permanently?', { danger: true, okLabel: 'Delete' })) { await api.del(svcUrl(id, `/backups/${b.id}`)); load(); } }));
        return h('tr', null,
          h('td', { title: fmtDate(b.createdAt) }, timeAgo(b.createdAt), h('div', { class: 'tiny faint' }, `by ${b.by}`)),
          h('td', null, badge(REASON[b.reason] || b.reason.replace(/^deploy:/, 'Deploy · '), b.reason.startsWith('deploy') ? 'accent' : ''), b.note ? h('div', { class: 'tiny muted' }, b.note) : null),
          h('td', { class: 'mono small' }, fmtBytes(b.size)),
          h('td', { class: 'mono small' }, b.commit ? b.commit.slice(0, 7) : '—'),
          h('td', { class: 'actions' }, canEdit ? [restore, ' ', h('a', { class: 'btn sm ghost icon', href: svcUrl(id, `/backups/${b.id}/download`), title: 'Download ZIP' }, icon('download', 14)), pin, del] : null));
      })))) : empty('archive', 'No backups yet', 'Create one now, enable daily backups, or deploy — every deploy snapshots automatically.'));
  }

  const create = btn('Back up now', { variant: 'primary', icon: 'archive', disabled: !canEdit });
  create.addEventListener('click', busy(create, async () => { await api.post(svcUrl(id, '/backups'), {}); toast('Backup created', 'success'); load(); }));

  mount(root,
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', null, icon('archive', 18), 'Backups'), h('p', null, 'ZIP snapshots of the service folder (without node_modules, .venv and .git). Oldest unpinned ones are removed past the retention limit set in Panel settings.')),
        h('div', { class: 'row' },
          h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: svc.dailyBackup, disabled: !canEdit, onChange: async e => { await api.patch(svcUrl(id), { dailyBackup: e.target.checked }); svc.dailyBackup = e.target.checked; toast(e.target.checked ? 'Daily backups on' : 'Daily backups off', 'success'); } }), 'Daily backup'),
          create)),
      list));
  load().catch(e => mount(list, h('p', { class: 'lvl-error' }, e.message)));
}

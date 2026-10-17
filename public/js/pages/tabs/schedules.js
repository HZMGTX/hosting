// Cron schedules: restart/start/stop/backup/deploy/command on a timetable.
import { h, icon, mount, btn, toast, busy, confirmDialog, timeAgo, fmtDate, modal, field, empty, badge } from '../../ui.js';
import { api, svcUrl } from '../../api.js';
import { store } from '../../store.js';

const ACTIONS = { restart: 'Restart', start: 'Start', stop: 'Stop', backup: 'Back up', deploy: 'Git pull & deploy', command: 'Run command' };
const PRESETS = [['Every day at 04:00', '0 4 * * *'], ['Every hour', '0 * * * *'], ['Every 6 hours', '0 */6 * * *'], ['Every Monday 09:00', '0 9 * * 1'], ['Every 15 minutes', '*/15 * * * *']];

export async function schedulesTab(root, svc) {
  const id = svc.id;
  const canEdit = store.can('edit', id);
  const list = h('div');

  function editDialog(job) {
    const cronIn = h('input', { class: 'input mono', value: job ? job.cron : '0 4 * * *' });
    const actionSel = h('select', { class: 'select' }, Object.entries(ACTIONS).filter(([k]) => k !== 'command' || store.can('exec', id)).map(([k, l]) => h('option', { value: k, selected: job ? job.action === k : k === 'restart' }, l)));
    const cmdIn = h('input', { class: 'input mono', value: job ? job.command : '', placeholder: 'node scripts/cleanup.js' });
    const cmdField = field('Command', cmdIn, 'Runs in the service folder without a shell.');
    const sync = () => cmdField.classList.toggle('hidden', actionSel.value !== 'command');
    actionSel.addEventListener('change', sync);
    sync();
    const save = btn(job ? 'Save' : 'Add schedule', { variant: 'primary' });
    const m = modal({
      title: job ? 'Edit schedule' : 'New schedule',
      body: h('div', null,
        field('When (cron)', cronIn, 'minute hour day-of-month month day-of-week — times use the server clock.'),
        h('div', { class: 'row wrap mb' }, PRESETS.map(([l, c]) => btn(l, { size: 'sm', variant: 'ghost', onClick: () => { cronIn.value = c; } }))),
        field('Action', actionSel), cmdField),
      footer: [btn('Cancel', { onClick: () => m.close() }), save]
    });
    save.addEventListener('click', busy(save, async () => {
      const body = { cron: cronIn.value.trim(), action: actionSel.value, command: cmdIn.value.trim() };
      if (job) await api.patch(svcUrl(id, `/schedules/${job.id}`), body);
      else await api.post(svcUrl(id, '/schedules'), body);
      m.close();
      toast('Schedule saved', 'success');
      load();
    }));
  }

  async function load() {
    const jobs = await api.get(svcUrl(id, '/schedules'));
    mount(list, jobs.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Schedule'), h('th', null, 'Action'), h('th', null, 'Next run'), h('th', null, 'Last run'), h('th', null, 'On'), h('th', null, ''))),
      h('tbody', null, jobs.map(j => h('tr', null,
        h('td', { class: 'mono' }, j.cron),
        h('td', null, ACTIONS[j.action], j.command ? h('div', { class: 'mono tiny muted' }, j.command) : null),
        h('td', { class: 'small', title: j.nextRunAt ? fmtDate(j.nextRunAt) : '' }, j.enabled && j.nextRunAt ? timeAgo(j.nextRunAt) : '—'),
        h('td', { class: 'small' }, j.lastRunAt ? timeAgo(j.lastRunAt) : 'never', j.lastResult ? h('div', null, badge(j.lastResult === 'ok' ? 'ok' : 'failed', j.lastResult === 'ok' ? 'success' : 'danger')) : null),
        h('td', null, h('input', { type: 'checkbox', checked: j.enabled, disabled: !canEdit, 'aria-label': 'Enabled', onChange: async e => { await api.patch(svcUrl(id, `/schedules/${j.id}`), { enabled: e.target.checked }); load(); } })),
        h('td', { class: 'actions' }, canEdit ? [
          btn('', { size: 'sm', variant: 'ghost', icon: 'play', title: 'Run now', onClick: async () => { await api.post(svcUrl(id, `/schedules/${j.id}/run`)); toast('Started — see the console', 'info'); setTimeout(load, 1500); } }),
          btn('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Edit', onClick: () => editDialog(j) }),
          btn('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Delete', onClick: async () => { if (await confirmDialog('Delete this schedule?', { danger: true, okLabel: 'Delete' })) { await api.del(svcUrl(id, `/schedules/${j.id}`)); load(); } } })
        ] : null)))))) : empty('clock', 'No schedules', 'Restart nightly, back up hourly, pull new code every morning, or run any script on a timetable.'));
  }

  mount(root, h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, icon('clock', 18), 'Schedules'), h('p', null, `Server time now: ${new Date().toLocaleTimeString()} (your browser).`)),
      canEdit ? btn('New schedule', { variant: 'primary', icon: 'plus', onClick: () => editDialog(null) }) : null),
    list));
  load().catch(e => mount(list, h('p', { class: 'lvl-error' }, e.message)));
}

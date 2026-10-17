// Service settings: identity, runtime/start command, restart policy, resources, web options, danger zone.
import { h, icon, mount, btn, toast, busy, field, confirmDialog, promptDialog, copyField, timeAgo, fmtDate } from '../../ui.js';
import { api, svcUrl } from '../../api.js';
import { store } from '../../store.js';
import { navigate } from '../../router.js';

export function settingsTab(root, svc, q) {
  const id = svc.id;
  const canEdit = store.can('edit', id);
  const s = JSON.parse(JSON.stringify(svc));
  const dis = !canEdit;

  const input = (key, attrs = {}) => h('input', { class: 'input', value: s[key] ?? '', disabled: dis, ...attrs, onInput: e => { s[key] = attrs.type === 'number' ? e.target.value : e.target.value; } });
  const select = (key, options) => h('select', { class: 'select', disabled: dis, onChange: e => { s[key] = e.target.value; renderConditional(); } },
    options.map(([v, l]) => h('option', { value: v, selected: s[key] === v }, l)));
  const check = (key, label, desc) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: !!s[key], disabled: dis, onChange: e => { s[key] = e.target.checked; } }),
    h('span', null, label, desc ? h('span', { class: 'desc' }, desc) : null));

  const conditional = h('div');
  function renderConditional() {
    mount(conditional,
      s.runtime === 'custom' || s.type === 'custom'
        ? field('Start command', h('input', { class: 'input mono', value: s.command, disabled: dis || !store.can('exec', id), placeholder: 'npm start   ·   java -Xmx1G -jar server.jar nogui', onInput: e => { s.command = e.target.value; } }),
          store.can('exec', id) ? 'Run without a shell. "node", "npm", "npx" and "python" are resolved automatically.' : 'Only admins can change the start command.')
        : field('Entry file', h('input', { class: 'input mono', value: s.entry, disabled: dis, onInput: e => { s.entry = e.target.value; } }), 'Relative to the service folder, e.g. index.js, src/bot.js, main.py.'),
      s.runtime === 'node' && s.type !== 'static' ? field('Node.js flags', h('input', { class: 'input mono', value: s.nodeArgs, disabled: dis, placeholder: '--enable-source-maps --trace-warnings', onInput: e => { s.nodeArgs = e.target.value; } })) : null,
      s.type === 'web' ? h('div', null,
        h('div', { class: 'grid cols-2' },
          field('Internal port', h('input', { class: 'input mono', type: 'number', value: s.port || '', disabled: dis, onInput: e => { s.port = e.target.value; } }), 'Your app must listen on process.env.PORT.'),
          field('Health check path', h('input', { class: 'input mono', value: s.healthCheck.path, disabled: dis, onInput: e => { s.healthCheck.path = e.target.value; } }))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.healthCheck.enabled, disabled: dis, onChange: e => { s.healthCheck.enabled = e.target.checked; } }),
          h('span', null, 'HTTP health checks', h('span', { class: 'desc' }, `Restart after ${s.healthCheck.failures} failed checks (every ${s.healthCheck.intervalSec}s).`)))) : null,
      s.type === 'static' ? h('div', null,
        field('Site folder', h('input', { class: 'input mono', value: s.staticRoot, disabled: dis, placeholder: '.  or  dist  or  public', onInput: e => { s.staticRoot = e.target.value; } }), 'Folder that contains index.html.'),
        check('spa', 'Single-page app fallback', 'Unknown paths serve index.html (React/Vue routers).')) : null,
      s.runtime !== 'custom' || s.type === 'static' ? h('div', null,
        field('Build command', h('input', { class: 'input mono', value: s.buildCommand, disabled: dis, placeholder: 'npm run build   ·   npx vite build   ·   python manage.py collectstatic --noinput', onInput: e => { s.buildCommand = e.target.value; } }),
          'Runs after every git deploy. Use it for React/Vite/Next exports, TypeScript, asset bundling.'),
        check('buildOnStart', 'Also build before every start', 'Slower starts, but the running code always matches the source.')) : null,
      s.type === 'web' || s.type === 'static' ? check('sandbox', 'Isolate at /apps/ URL (recommended)', 'Runs the app in a sandboxed origin so its JavaScript cannot use your panel login. Turn off only if the app needs cookies or localStorage at /apps/; custom domains are never sandboxed.') : null);
  }
  renderConditional();

  const saveBtn = btn('Save settings', { variant: 'primary', icon: 'save', disabled: dis });
  saveBtn.addEventListener('click', busy(saveBtn, async () => {
    const body = {
      name: s.name, type: s.type, runtime: s.runtime, entry: s.entry, nodeArgs: s.nodeArgs, restartPolicy: s.restartPolicy,
      memoryLimitMb: s.memoryLimitMb, memoryAlertPct: s.memoryAlertPct, autostart: s.autostart, staticRoot: s.staticRoot, spa: s.spa,
      sandbox: s.sandbox, statusPage: s.statusPage, healthCheck: s.healthCheck,
      buildCommand: s.buildCommand, buildOnStart: s.buildOnStart,
      tags: String(s.tagsText ?? (s.tags || []).join(', ')).split(',').map(t => t.trim()).filter(Boolean)
    };
    if (store.can('exec', id)) body.command = s.command;
    if (s.type === 'web' && s.port) body.port = s.port;
    const updated = await api.patch(svcUrl(id), body);
    store.upsertService(updated);
    toast('Settings saved. Restart the service to apply runtime changes.', 'success');
  }));

  const buildBtn = btn('Run build now', { icon: 'wrench', disabled: dis || !svc.buildCommand, title: svc.buildCommand ? svc.buildCommand : 'Save a build command first' });
  buildBtn.addEventListener('click', busy(buildBtn, async () => {
    toast('Building… output is in the Console tab', 'info');
    const r = await api.post(svcUrl(id, '/build'));
    toast(r.ok ? 'Build finished' : `Build failed (exit ${r.code}) — see the console`, r.ok ? 'success' : 'error');
  }));

  const dupBtn = btn('Duplicate', { icon: 'copy', disabled: dis || !store.can('create') });
  dupBtn.addEventListener('click', busy(dupBtn, async () => {
    const name = await promptDialog({ title: 'Duplicate service', label: 'Name for the copy', value: `${svc.name} copy`, okLabel: 'Duplicate' });
    if (!name) return;
    const copy = await api.post(svcUrl(id, '/duplicate'), { name });
    store.upsertService(copy);
    toast(`Created ${copy.name}. Variables and files were copied; schedules were not.`, 'success');
    navigate(`/services/${copy.id}`);
  }));

  const activityCard = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('list', 18), 'Recent activity')), h('div', { class: 'small muted' }, 'Loading…'));
  api.get(svcUrl(id, '/activity')).then(list => {
    mount(activityCard, h('div', { class: 'card-head' }, h('h2', null, icon('list', 18), 'Recent activity')),
      list.length ? h('div', { class: 'list', style: { maxHeight: '260px', overflow: 'auto' } }, list.slice(0, 40).map(e => h('div', { class: 'list-item small' },
        h('span', { class: 'grow' }, h('strong', null, e.user), ' ', e.action.replace(/^service\.|^file\./, '').replace(/_/g, ' '), e.details ? h('span', { class: 'muted' }, ` — ${e.details}`) : null),
        h('span', { class: 'tiny faint nowrap', title: fmtDate(e.at) }, timeAgo(e.at))))) : h('p', { class: 'small muted' }, 'Nothing recorded yet.'));
  }).catch(() => {});

  const delBtn = btn('Delete service', { variant: 'danger solid', icon: 'trash', disabled: !store.can('delete', id) });
  delBtn.addEventListener('click', busy(delBtn, async () => {
    const typed = await promptDialog({ title: 'Delete service', label: `Type "${id}" to permanently delete this service, its files, logs, metrics and database.`, okLabel: 'Delete forever', validate: v => (v === id ? null : 'Type the id exactly') });
    if (typed !== id) return;
    const keep = await confirmDialog('Keep its backups on the server? (You can restore them into a new service manually.)', { title: 'Backups', okLabel: 'Keep backups' });
    await api.del(svcUrl(id, keep ? '?keepBackups=1' : ''));
    store.removeService(id);
    toast(`${svc.name} deleted`, 'success');
    navigate('/services');
  }));

  mount(root,
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, icon('settings', 18), 'General')),
        field('Name', input('name', { maxlength: 80 })),
        h('div', { class: 'grid cols-2' },
          field('Type', select('type', [['discord', 'Discord bot'], ['web', 'Web app'], ['static', 'Static site'], ['worker', 'Worker'], ['custom', 'Custom']])),
          field('Runtime', select('runtime', [['node', 'Node.js'], ['python', 'Python'], ['custom', 'Custom command']]))),
        conditional,
        field('Tags', h('input', { class: 'input', value: (s.tags || []).join(', '), disabled: dis, placeholder: 'production, music, league', onInput: e => { s.tagsText = e.target.value; } }), 'Comma separated. Filter by tag on the Services page.'),
        field('Service id', copyField(id), 'Used in URLs and the folder name. Cannot be changed.')),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, icon('shield', 18), 'Reliability & resources')),
        field('When the process exits', select('restartPolicy', [['always', 'Always restart (24/7)'], ['on-failure', 'Restart only if it crashed'], ['never', 'Never restart']]),
          'Crashes back off 1s → 60s. Five crashes in two minutes pause restarts and alert you.'),
        h('div', { class: 'grid cols-2' },
          field('Memory limit (MB)', input('memoryLimitMb', { type: 'number', min: 0, placeholder: '0 = unlimited' }), 'Node.js heap limit. 0 = no limit.'),
          field('Memory alert at (%)', input('memoryAlertPct', { type: 'number', min: 10, max: 100 }))),
        check('autostart', 'Keep running when OmniHost restarts', 'Services that were running come back automatically after a reboot or redeploy of the panel.'),
        check('statusPage', 'Show on public status page', 'Listed at /status when the status page is enabled.'))),
    canEdit ? h('div', { class: 'form-actions mb' }, buildBtn, saveBtn) : null,
    h('div', { class: 'grid cols-2 mb' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('copy', 18), 'Copy & move'), h('p', null, 'Duplicate this service, or download it as a ZIP you can upload into any OmniHost (settings included, secrets left out).'))),
        h('div', { class: 'btn-group' }, dupBtn, h('a', { class: 'btn', href: svcUrl(id, '/export') }, icon('download', 15), 'Export as ZIP'))),
      activityCard),
    h('div', { class: 'card', style: { borderColor: 'color-mix(in srgb, var(--danger) 45%, transparent)' } },
      h('div', { class: 'card-head' }, h('div', null, h('h2', { class: 'lvl-error' }, icon('alert', 18), 'Danger zone'), h('p', null, 'Stops the service and removes its folder, logs, metrics and database. This cannot be undone.')), delBtn)));

  if (q.delete) setTimeout(() => delBtn.click(), 100);
}

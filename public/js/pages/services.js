// Services list + "new service" wizard (template / empty / ZIP / GitHub).
import { h, icon, mount, statusBadge, fmtBytes, fmtDuration, pct, empty, btn, toast, field, busy } from '../ui.js';
import { TYPE_ICON } from '../icons.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { page, serviceIcon } from '../shell.js';
import { navigate } from '../router.js';

const TYPE_LABEL = { discord: 'Discord bot', web: 'Web app', static: 'Static site', worker: 'Worker', custom: 'Custom' };

function card(s) {
  const st = s.state || {};
  const meta = h('div', { class: 'svc-meta' });
  const fill = () => mount(meta,
    h('span', null, icon('cpu', 13), ' ', st.status === 'ONLINE' ? pct(st.cpu) : '—'),
    h('span', null, icon('hardDrive', 13), ' ', st.status === 'ONLINE' ? fmtBytes(st.memory) : '—'),
    h('span', null, icon('clock', 13), ' ', st.status === 'ONLINE' ? fmtDuration(st.uptimeMs) : '—'));
  fill();
  const badgeHolder = h('span', null, statusBadge(st.status || 'OFFLINE'));
  const el = h('a', { class: 'card svc-card', href: `#/services/${encodeURIComponent(s.id)}` },
    h('div', { class: 'svc-top' }, serviceIcon(s.type),
      h('div', { class: 'grow' }, h('div', { class: 'ellipsis', style: { fontWeight: 650 } }, s.name), h('div', { class: 'tiny muted' }, `${TYPE_LABEL[s.type] || s.type} · ${s.runtime === 'python' ? 'Python' : s.runtime === 'custom' ? 'Custom command' : 'Node.js'}`)),
      badgeHolder),
    meta,
    (s.tags || []).length ? h('div', { class: 'row wrap' }, s.tags.map(t => h('span', { class: 'badge' }, t))) : null,
    (s.diagnostics || []).length ? h('div', { class: 'tiny lvl-error row' }, icon('alert', 13), s.diagnostics[s.diagnostics.length - 1].title) : null);
  el._update = () => { Object.assign(st, store.services[s.id].state); mount(badgeHolder, statusBadge(st.status)); fill(); };
  return el;
}

const RUNNING = ['ONLINE', 'STARTING', 'RESTARTING', 'INSTALLING', 'BUILDING'];

export function servicesPage() {
  const el = page('Services');
  let filter = '';
  let typeFilter = '';
  let tagFilter = '';
  let statusFilter = '';
  const selected = new Set();
  const grid = h('div', { class: 'grid auto' });
  const bulkBar = h('div', { class: 'callout info hidden', style: { alignItems: 'center' } });
  const cards = new Map();

  function visible() {
    return Object.values(store.services)
      .filter(s => (!typeFilter || s.type === typeFilter) && (!tagFilter || (s.tags || []).includes(tagFilter)))
      .filter(s => !statusFilter || (statusFilter === 'running' ? RUNNING.includes((s.state || {}).status) : statusFilter === 'crashed' ? (s.state || {}).status === 'CRASHED' : !RUNNING.includes((s.state || {}).status)))
      .filter(s => !filter || s.name.toLowerCase().includes(filter) || s.id.toLowerCase().includes(filter))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function bulk(action, label) {
    const ids = [...selected].filter(id => store.can('operate', id));
    let ok = 0;
    for (const id of ids) {
      try { await api.post(`/api/services/${encodeURIComponent(id)}/${action}`); ok++; } catch (e) { toast(`${store.services[id].name}: ${e.message}`, 'error'); }
    }
    toast(`${label} ${ok} of ${ids.length} service(s)`, ok === ids.length ? 'success' : 'warning');
    selected.clear();
    render();
  }

  function renderBulk() {
    bulkBar.classList.toggle('hidden', !selected.size);
    if (!selected.size) return;
    mount(bulkBar, h('div', { class: 'callout-body' }, h('strong', null, `${selected.size} selected`)),
      h('div', { class: 'btn-group' },
        btn('Start', { size: 'sm', icon: 'play', variant: 'success', onClick: () => bulk('start', 'Started') }),
        btn('Restart', { size: 'sm', icon: 'restart', onClick: () => bulk('restart', 'Restarted') }),
        btn('Stop', { size: 'sm', icon: 'stop', variant: 'danger', onClick: () => bulk('stop', 'Stopped') }),
        btn('Clear', { size: 'sm', variant: 'ghost', onClick: () => { selected.clear(); render(); } })));
  }

  function render() {
    const list = visible();
    cards.clear();
    for (const id of [...selected]) if (!store.services[id]) selected.delete(id);
    if (!Object.keys(store.services).length) {
      renderBulk();
      return mount(grid, h('div', { style: { gridColumn: '1 / -1' } }, empty('server', 'No services yet', 'Create a Discord bot, website, Telegram bot, static site or background worker.',
        store.can('create') ? btn('New service', { variant: 'primary', icon: 'plus', onClick: () => navigate('/services/new') }) : null)));
    }
    mount(grid, list.length ? list.map(s => {
      const c = card(s);
      cards.set(s.id, c);
      const box = h('input', { type: 'checkbox', class: 'svc-select', checked: selected.has(s.id), 'aria-label': `Select ${s.name}`,
        onChange: e => { e.target.checked ? selected.add(s.id) : selected.delete(s.id); renderBulk(); } });
      return h('div', { class: 'svc-wrap' }, c, store.can('operate', s.id) ? box : null);
    }) : h('p', { class: 'muted' }, 'No services match.'));
    renderBulk();
  }

  const all = Object.values(store.services);
  const types = ['', ...new Set(all.map(s => s.type))];
  const tags = ['', ...new Set(all.flatMap(s => s.tags || []))].sort();
  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Services'), h('p', null, 'Everything OmniHost runs for you. Tick cards to start, stop or restart several at once.')),
      h('div', { class: 'row wrap' },
        h('input', { class: 'input', placeholder: 'Filter…', 'aria-label': 'Filter services', style: { width: '180px' }, onInput: e => { filter = e.target.value.toLowerCase(); render(); } }),
        h('select', { class: 'select', style: { width: 'auto' }, 'aria-label': 'Status', onChange: e => { statusFilter = e.target.value; render(); } },
          [['', 'Any status'], ['running', 'Running'], ['stopped', 'Stopped'], ['crashed', 'Crashed']].map(([v, l]) => h('option', { value: v }, l))),
        h('select', { class: 'select', style: { width: 'auto' }, 'aria-label': 'Type', onChange: e => { typeFilter = e.target.value; render(); } },
          types.map(t => h('option', { value: t }, t ? TYPE_LABEL[t] || t : 'All types'))),
        tags.length > 1 ? h('select', { class: 'select', style: { width: 'auto' }, 'aria-label': 'Tag', onChange: e => { tagFilter = e.target.value; render(); } },
          tags.map(t => h('option', { value: t }, t || 'All tags'))) : null,
        store.can('create') ? btn('New service', { variant: 'primary', icon: 'plus', onClick: () => navigate('/services/new') }) : null)),
    bulkBar,
    grid);
  render();
  const off1 = store.on('services', render);
  const off2 = store.on('state', ({ id }) => { const c = cards.get(id); if (c) c._update(); });
  return () => { off1(); off2(); };
}

// ---------- new service wizard ----------
export async function newServicePage() {
  const el = page([{ label: 'Services', href: '/services' }, 'New service']);
  if (!store.can('create')) return mount(el, empty('lock', 'No permission', 'Viewers cannot create services.'));
  let data;
  try { data = await api.get('/api/services/templates'); } catch (e) { return mount(el, h('p', { class: 'lvl-error' }, e.message)); }

  const state = { source: 'template', templateId: data.templates[0] && data.templates[0].id, features: new Set(), type: 'discord', runtime: 'node' };
  const nameInput = h('input', { class: 'input', placeholder: 'e.g. Ticket Bot', maxlength: 80, autofocus: true });
  const body = h('div');
  const zipInput = h('input', { type: 'file', accept: '.zip', class: 'input' });

  const sourceBtns = [
    ['template', 'Start from a template', 'sparkles', 'Working starter code for bots, sites and workers.'],
    ['git', 'Import from GitHub', 'git', 'Clone a repository and redeploy on every push.'],
    ['zip', 'Upload a ZIP', 'upload', 'Your existing project as a .zip archive.'],
    ['empty', 'Empty service', 'file', 'Start blank and add files yourself.']
  ];

  function renderBody() {
    const srcPicker = h('div', { class: 'pick-grid mb' }, sourceBtns.map(([id, title, ic, desc]) => h('button', {
      type: 'button', class: ['pick', state.source === id ? 'selected' : ''], onClick: () => { state.source = id; renderBody(); }
    }, h('div', { class: 'pick-title' }, icon(ic, 16), title), h('div', { class: 'pick-desc' }, desc))));

    let detail;
    if (state.source === 'template') {
      const tpl = data.templates.find(t => t.id === state.templateId);
      detail = h('div', null,
        h('div', { class: 'label-text mb-sm' }, 'Template'),
        h('div', { class: 'pick-grid mb' }, data.templates.map(t => h('button', {
          type: 'button', class: ['pick', state.templateId === t.id ? 'selected' : ''], onClick: () => { state.templateId = t.id; renderBody(); }
        }, h('div', { class: 'pick-title' }, icon(TYPE_ICON[t.type] || 'server', 16), t.name), h('div', { class: 'pick-desc' }, t.description)))),
        tpl && tpl.features ? h('div', null,
          h('div', { class: 'label-text mb-sm' }, 'Feature packs (optional)'),
          data.features.map(f => h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: state.features.has(f.id), onChange: e => { e.target.checked ? state.features.add(f.id) : state.features.delete(f.id); } }),
            h('span', null, f.name, h('span', { class: 'desc' }, f.description))))) : null);
    } else {
      const typeSel = h('select', { class: 'select', onChange: e => { state.type = e.target.value; } },
        Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v, selected: state.type === v }, l)));
      const rtSel = h('select', { class: 'select', onChange: e => { state.runtime = e.target.value; } },
        [['node', 'Node.js'], ['python', 'Python'], ['custom', 'Custom command']].map(([v, l]) => h('option', { value: v, selected: state.runtime === v }, l)));
      detail = h('div', null,
        h('div', { class: 'grid cols-2' }, field('Type', typeSel, 'Web apps get a PORT and a public URL.'), field('Runtime', rtSel)),
        field('Entry file', h('input', { class: 'input mono', id: 'ns-entry', placeholder: 'index.js / main.py / server.js' }), 'You can change this later in Settings.'),
        state.source === 'git' ? h('div', null,
          field('Repository URL', h('input', { class: 'input mono', id: 'ns-git-url', placeholder: 'https://github.com/you/your-bot' })),
          h('div', { class: 'grid cols-2' },
            field('Branch', h('input', { class: 'input mono', id: 'ns-git-branch', value: 'main' })),
            field('Access token (private repos)', h('input', { class: 'input mono', id: 'ns-git-token', type: 'password', placeholder: 'optional', autocomplete: 'off' }), 'A GitHub fine-grained token with read access to Contents.'))) : null,
        state.source === 'zip' ? field('ZIP archive', zipInput, 'Everything is unzipped into the main folder — wrapper folders like "my-bot-main/" are removed and the start file is detected.') : null);
    }
    mount(body, h('div', { class: 'label-text mb-sm' }, 'Source'), srcPicker, detail);
  }

  const create = btn('Create service', { variant: 'primary', icon: 'rocket' });
  create.addEventListener('click', busy(create, async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); throw new Error('Give the service a name'); }
    const payload = { name, source: state.source === 'zip' ? 'empty' : state.source };
    if (state.source === 'template') { payload.templateId = state.templateId; payload.features = [...state.features]; }
    else {
      payload.type = state.type;
      payload.runtime = state.runtime;
      payload.entry = (document.getElementById('ns-entry') || {}).value || undefined;
      if (state.source === 'git') {
        payload.gitUrl = document.getElementById('ns-git-url').value.trim();
        payload.gitBranch = document.getElementById('ns-git-branch').value.trim() || 'main';
        payload.gitToken = document.getElementById('ns-git-token').value.trim();
      }
    }
    if (state.source === 'zip' && !zipInput.files[0]) throw new Error('Choose a ZIP file');
    const svc = await api.post('/api/services', payload);
    if (state.source === 'zip') {
      const fd = new FormData();
      fd.append('files', zipInput.files[0]);
      await api.post(`/api/services/${encodeURIComponent(svc.id)}/files/upload`, fd);
    }
    store.upsertService(svc);
    if (svc.warning) toast(svc.warning, 'warning');
    else toast(`${svc.name} created`, 'success');
    navigate(`/services/${svc.id}/${svc.type === 'discord' ? 'env' : 'console'}`);
  }));

  renderBody();
  mount(el,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'New service'), h('p', null, 'Deploy a bot, site or worker. Everything stays editable afterwards.'))),
    h('div', { class: 'card', style: { maxWidth: '900px' } },
      field('Name', nameInput, 'Shown in the dashboard. The id is generated from it.'),
      body,
      h('div', { class: 'form-actions' }, btn('Cancel', { onClick: () => navigate('/services') }), create)));
}

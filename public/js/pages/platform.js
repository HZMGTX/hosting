// Platform pages: domains, shared variables, monitoring & alerts, data store, panel settings, API docs.
import { h, icon, mount, btn, toast, busy, field, confirmDialog, empty, timeAgo, badge, modal, copyField, loading, fmtDate, pct } from '../ui.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { page } from '../shell.js';
import { createEditor } from '../components/editor.js';

// ---------------- Domains ----------------
export async function domainsPage() {
  const el = page('Domains');
  const list = h('div');
  const svcSel = h('select', { class: 'select' }, Object.values(store.services).filter(s => ['web', 'static'].includes(s.type) && store.can('edit', s.id)).map(s => h('option', { value: s.id }, s.name)));
  const domainIn = h('input', { class: 'input mono', placeholder: 'bot.example.com' });
  const add = btn('Add domain', { variant: 'primary', icon: 'plus' });
  const panelHost = (store.info && store.info.publicUrl ? new URL(store.info.publicUrl).hostname : location.hostname);

  async function load() {
    const domains = await api.get('/api/system/domains');
    mount(list, domains.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Domain'), h('th', null, 'Service'), h('th', null, 'DNS'), h('th', null, ''))),
      h('tbody', null, domains.map(d => {
        const dns = h('span', { class: 'small muted' }, '—');
        const check = btn('Check DNS', { size: 'sm', icon: 'search' });
        check.addEventListener('click', busy(check, async () => {
          const r = await api.get(`/api/system/domains/${encodeURIComponent(d.name)}/check`);
          const ok = r.cname.some(c => c.toLowerCase() === panelHost.toLowerCase());
          mount(dns, r.cname.length ? badge(`CNAME → ${r.cname[0]}`, ok ? 'success' : 'warning') : r.a.length ? badge(`A → ${r.a.join(', ')}`, 'info') : badge('not found', 'danger'));
        }));
        return h('tr', null,
          h('td', null, h('a', { href: `https://${d.name}`, target: '_blank', rel: 'noopener', class: 'mono' }, d.name)),
          h('td', null, store.services[d.serviceId] ? h('a', { href: `#/services/${d.serviceId}` }, store.services[d.serviceId].name) : d.serviceId),
          h('td', null, dns),
          h('td', { class: 'actions' }, check, ' ', btn('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Remove', onClick: async () => { if (await confirmDialog(`Stop routing ${d.name}?`, { danger: true, okLabel: 'Remove' })) { await api.del(`/api/system/domains/${encodeURIComponent(d.name)}`); load(); } } })));
      })))) : empty('globe', 'No custom domains', 'Point your own domain at a web app or static site.'));
  }
  add.addEventListener('click', busy(add, async () => {
    if (!svcSel.value) throw new Error('Create a web app or static site first');
    const r = await api.post('/api/system/domains', { domain: domainIn.value, serviceId: svcSel.value });
    toast(`Mapped ${r.name}. Now create the DNS record.`, 'success');
    domainIn.value = '';
    load();
  }));

  mount(el,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Custom domains'), h('p', null, 'Serve a web app or static site on its own domain. Every app is also always reachable at /apps/<id>/.'))),
    h('div', { class: 'grid cols-2 mb' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, icon('plus', 18), 'Add a domain')),
        field('Domain', domainIn), field('Service', svcSel), h('div', { class: 'form-actions' }, add)),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, icon('info', 18), 'DNS setup')),
        h('p', { class: 'small' }, 'At your domain registrar, create a CNAME record:'),
        h('dl', { class: 'kv mb' }, h('dt', null, 'Name'), h('dd', { class: 'mono' }, 'bot  (for bot.example.com)'), h('dt', null, 'Target'), h('dd', null, copyField(panelHost))),
        h('p', { class: 'small muted' }, 'HTTPS: on Railway add the same domain under Settings → Networking → Custom Domain (free certificate). On a VPS, put Caddy in front (automatic certificates). Root domains (example.com) need an ALIAS/ANAME record or Cloudflare CNAME flattening.'))),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('globe', 18), 'Mapped domains')), list));
  load().catch(e => mount(list, h('p', { class: 'lvl-error' }, e.message)));
}

// ---------------- Shared variable groups ----------------
export async function envGroupsPage() {
  const el = page('Shared variables');
  const admin = store.can('admin');
  const list = h('div');

  function editGroup(g) {
    const nameIn = h('input', { class: 'input', value: g ? g.name : '', placeholder: 'e.g. Production database' });
    const descIn = h('input', { class: 'input', value: g ? g.description : '', placeholder: 'optional' });
    const text = g ? g.vars.map(v => `${v.key}=${v.value}`).join('\n') : 'DATABASE_URL=\n';
    const ed = createEditor({ value: text, path: '.env' });
    const svcBoxes = Object.values(store.services).map(s => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: s.id, checked: g ? g.services.includes(s.id) : false }), h('span', null, s.name)));
    const urlIn = h('input', { class: 'input mono', placeholder: 'postgres://user:pass@host:5432/db' });
    const testBtn = btn('Test', { icon: 'zap' });
    testBtn.addEventListener('click', busy(testBtn, async () => {
      const r = await api.post('/api/env-groups/test-connection', { url: urlIn.value.trim() });
      toast(r.message + (r.ms ? ` (${r.ms} ms)` : ''), r.ok ? 'success' : r.ok === null ? 'info' : 'error');
    }));
    const save = btn('Save group', { variant: 'primary' });
    const m = modal({
      title: g ? `Edit ${g.name}` : 'New shared group', size: 'wide',
      body: h('div', null,
        h('div', { class: 'grid cols-2' }, field('Name', nameIn), field('Description', descIn)),
        h('div', { class: 'field' }, h('label', null, 'Variables (KEY=value per line)'), h('div', { style: { height: '200px', display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } }, ed.el),
          g ? h('div', { class: 'hint' }, 'Masked values (with •) are kept unchanged. Remove a line to delete a variable.') : null),
        h('div', { class: 'field' }, h('label', null, 'Attached to'), svcBoxes.length ? h('div', { class: 'grid cols-2', style: { gap: 0 } }, svcBoxes) : h('p', { class: 'small muted' }, 'No services yet.')),
        h('div', { class: 'field' }, h('label', null, 'Test a connection string (TCP reachability only)'), h('div', { class: 'input-group' }, urlIn, testBtn))),
      footer: [btn('Cancel', { onClick: () => m.close() }), save]
    });
    save.addEventListener('click', busy(save, async () => {
      const vars = {};
      for (const line of ed.getValue().split(/\r?\n/)) {
        const mm = line.match(/^\s*([A-Za-z_][\w.-]*)\s*=(.*)$/);
        if (mm) vars[mm[1]] = mm[2].trim().replace(/^"(.*)"$/, '$1');
      }
      const services = svcBoxes.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value);
      if (g) {
        for (const v of g.vars) if (!(v.key in vars)) vars[v.key] = null;
        await api.patch(`/api/env-groups/${g.id}`, { name: nameIn.value, description: descIn.value, vars, services });
      } else {
        const created = await api.post('/api/env-groups', { name: nameIn.value, description: descIn.value, vars });
        await api.patch(`/api/env-groups/${created.id}`, { services });
      }
      m.close();
      toast('Group saved. Restart attached services to apply.', 'success');
      load();
    }));
  }

  async function load() {
    const groups = await api.get('/api/env-groups');
    mount(list, groups.length ? h('div', { class: 'grid auto' }, groups.map(g => h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h3', null, icon('layers', 16), g.name), g.description ? h('p', null, g.description) : null),
        admin ? h('div', { class: 'btn-group' },
          btn('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Edit', onClick: () => editGroup(g) }),
          btn('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Delete', onClick: async () => { if (await confirmDialog(`Delete group "${g.name}"? Attached services lose these variables on restart.`, { danger: true, okLabel: 'Delete' })) { await api.del(`/api/env-groups/${g.id}`); load(); } } })) : null),
      h('div', { class: 'list' }, g.vars.map(v => h('div', { class: 'list-item small' }, h('span', { class: 'mono grow' }, v.key), h('span', { class: 'mono faint ellipsis', style: { maxWidth: '50%' } }, v.value)))),
      h('div', { class: 'row wrap mt-sm' }, g.services.length ? g.services.map(id => badge(store.services[id] ? store.services[id].name : id, 'accent')) : h('span', { class: 'tiny faint' }, 'Not attached to any service'))))) :
      empty('key', 'No shared groups', 'Define variables once (database URLs, API keys) and attach them to many services.'));
  }

  mount(el,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Shared variables'), h('p', null, 'Variable groups injected into every attached service. A service\'s own .env wins on conflicts.')),
      admin ? btn('New group', { variant: 'primary', icon: 'plus', onClick: () => editGroup(null) }) : null),
    list);
  load().catch(e => mount(list, h('p', { class: 'lvl-error' }, e.message)));
}

// ---------------- Uptime monitors (external URLs / ports) ----------------
const MON_STATUS = { up: ['Up', 'success'], down: ['Down', 'danger'], pending: ['Checking', 'warning'], paused: ['Paused', ''] };

function monitorDialog(existing, onSaved) {
  const m = existing || { type: 'http', intervalSec: 60, timeoutSec: 10, expect: '200-399', failuresBeforeAlert: 2, enabled: true, statusPage: false };
  const name = h('input', { class: 'input', value: m.name || '', placeholder: 'My website' });
  const type = h('select', { class: 'select' }, [['http', 'HTTP(S) status'], ['keyword', 'Keyword on page'], ['tcp', 'TCP port']].map(([v, l]) => h('option', { value: v, selected: m.type === v }, l)));
  const url = h('input', { class: 'input mono', value: m.url || '', placeholder: 'https://example.com/health' });
  const keyword = h('input', { class: 'input', value: m.keyword || '', placeholder: 'Text that must appear, e.g. "All systems go"' });
  const host = h('input', { class: 'input mono', value: m.host || '', placeholder: 'play.example.com' });
  const port = h('input', { class: 'input mono', type: 'number', value: m.port || '', placeholder: '25565' });
  const expect = h('input', { class: 'input mono', value: m.expect, placeholder: '200-399' });
  const interval = h('input', { class: 'input', type: 'number', min: 30, value: m.intervalSec });
  const timeout = h('input', { class: 'input', type: 'number', min: 2, value: m.timeoutSec });
  const failures = h('input', { class: 'input', type: 'number', min: 1, max: 10, value: m.failuresBeforeAlert });
  const enabled = h('input', { type: 'checkbox', checked: m.enabled });
  const onStatus = h('input', { type: 'checkbox', checked: m.statusPage });
  const urlField = field('URL', url), kwField = field('Keyword', keyword), expectField = field('Expected status', expect, 'A code or range, e.g. 200 or 200-399.');
  const tcpFields = h('div', { class: 'grid cols-2' }, field('Host', host), field('Port', port));
  const sync = () => {
    const t = type.value;
    urlField.classList.toggle('hidden', t === 'tcp');
    expectField.classList.toggle('hidden', t === 'tcp');
    kwField.classList.toggle('hidden', t !== 'keyword');
    tcpFields.classList.toggle('hidden', t !== 'tcp');
  };
  type.addEventListener('change', sync);
  sync();
  const save = btn(existing ? 'Save' : 'Add monitor', { variant: 'primary' });
  const dlg = modal({
    title: existing ? `Edit ${existing.name}` : 'New uptime monitor', size: 'wide',
    body: h('div', null,
      h('div', { class: 'grid cols-2' }, field('Name', name), field('Check type', type)),
      urlField, kwField, tcpFields, expectField,
      h('div', { class: 'grid cols-3' }, field('Every (seconds)', interval), field('Timeout (seconds)', timeout), field('Alert after N failures', failures)),
      h('label', { class: 'check' }, enabled, h('span', null, 'Enabled')),
      h('label', { class: 'check' }, onStatus, h('span', null, 'Show on public status page'))),
    footer: [btn('Cancel', { onClick: () => dlg.close() }), save]
  });
  save.addEventListener('click', busy(save, async () => {
    const body = { name: name.value, type: type.value, url: url.value, keyword: keyword.value, host: host.value, port: port.value, expect: expect.value,
      intervalSec: interval.value, timeoutSec: timeout.value, failuresBeforeAlert: failures.value, enabled: enabled.checked, statusPage: onStatus.checked };
    if (existing) await api.patch(`/api/monitors/${existing.id}`, body);
    else await api.post('/api/monitors', body);
    dlg.close();
    toast('Monitor saved', 'success');
    onSaved();
  }));
}

function monitorsCard() {
  const admin = store.can('admin');
  const box = h('div', null, h('div', { class: 'skeleton', style: { height: '60px' } }));
  const rows = new Map();
  function row(m) {
    const [label, variant] = MON_STATUS[m.status] || MON_STATUS.pending;
    return h('div', { class: 'list-item', style: { alignItems: 'flex-start' } },
      h('div', { class: 'grow', style: { minWidth: 0 } },
        h('div', { class: 'row wrap' }, h('strong', null, m.name), badge(label, variant), h('span', { class: 'tiny faint mono ellipsis' }, m.type === 'tcp' ? `${m.host}:${m.port}` : m.url)),
        h('div', { class: 'bars mt-sm', style: { height: '18px', maxWidth: '520px' } }, m.bars.map(v => h('span', { class: v === null ? '' : v >= 99.5 ? 'up' : v >= 90 ? 'partial' : 'down', title: v === null ? 'No data' : `${v}% up` }))),
        h('div', { class: 'tiny muted mt-sm' }, `24h ${pct(m.uptime24h)} · 30d ${pct(m.uptime30d)} · ${m.latencyMs !== null ? m.latencyMs + ' ms' : '—'} · checked ${timeAgo(m.lastCheckAt)}${m.error ? ' · ' + m.error : ''}`)),
      h('div', { class: 'btn-group' },
        btn('', { size: 'sm', variant: 'ghost', icon: 'refresh', title: 'Check now', onClick: async () => { await api.post(`/api/monitors/${m.id}/check`); load(); } }),
        admin ? btn('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Edit', onClick: () => monitorDialog(m, load) }) : null,
        admin ? btn('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Delete', onClick: async () => { if (await confirmDialog(`Delete monitor "${m.name}"?`, { danger: true, okLabel: 'Delete' })) { await api.del(`/api/monitors/${m.id}`); load(); } } }) : null));
  }
  async function load() {
    const list = await api.get('/api/monitors');
    rows.clear();
    mount(box, list.length ? h('div', { class: 'list' }, list.map(m => { const r = row(m); rows.set(m.id, r); return r; }))
      : h('p', { class: 'small muted' }, 'Watch any website, API or game server port from here — you get an alert when it goes down and when it recovers.'));
  }
  load().catch(e => mount(box, h('p', { class: 'lvl-error' }, e.message)));
  const off = store.on('monitor', m => {
    const old = rows.get(m.id);
    if (!old) return;
    const fresh = row(m);
    old.replaceWith(fresh);
    rows.set(m.id, fresh);
  });
  const card = h('div', { class: 'card mb' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('activity', 18), 'Uptime monitors'), h('p', null, 'External checks for anything with a URL or port — not only services hosted here.')),
      admin ? btn('Add monitor', { variant: 'primary', icon: 'plus', onClick: () => monitorDialog(null, load) }) : null),
    box);
  card._cleanup = off;
  return card;
}

// ---------------- Monitoring & alerts ----------------
export async function monitoringPage() {
  const el = page('Monitoring & alerts');
  const admin = store.can('admin');
  const notifBox = h('div');
  const monCard = monitorsCard();
  const EVENTS = { crash: 'Service crashed', crashLoop: 'Crash loop (auto-restart paused)', recovered: 'Recovered after a crash', memory: 'High memory', healthCheck: 'Health check failed', monitor: 'Uptime monitor down / back up', deploy: 'Deploy finished / failed', backupFailed: 'Backup failed' };

  async function loadNotifs() {
    const items = await api.get('/api/system/notifications');
    mount(notifBox, items.length ? h('div', { class: 'list' }, items.map(n => h('div', { class: 'list-item' },
      h('span', { class: `lvl-${n.level}` }, icon(n.level === 'error' || n.level === 'warning' ? 'alert' : n.level === 'success' ? 'check' : 'info', 16)),
      h('div', { class: 'grow' },
        h('div', { class: 'small', style: { fontWeight: 600 } }, (n.serviceId && store.services[n.serviceId] ? store.services[n.serviceId].name + ' · ' : '') + n.title),
        n.message ? h('pre', { class: 'tiny muted', style: { maxHeight: '4.5em', overflow: 'hidden' } }, n.message) : null),
      h('span', { class: 'tiny faint nowrap', title: fmtDate(n.at) }, timeAgo(n.at))))) : h('p', { class: 'muted small' }, 'No notifications yet.'));
  }

  let settingsCard = null;
  if (admin) {
    const s = await api.get('/api/system/settings');
    const discordIn = h('input', { class: 'input mono', value: s.alerts.discordWebhook, placeholder: 'https://discord.com/api/webhooks/…' });
    const httpIn = h('input', { class: 'input mono', value: s.alerts.httpWebhook, placeholder: 'https://example.com/omnihost-alerts' });
    const events = { ...s.alerts.events };
    const spEnabled = h('input', { type: 'checkbox', checked: s.statusPage.enabled });
    const spTitle = h('input', { class: 'input', value: s.statusPage.title });
    const save = btn('Save', { variant: 'primary', icon: 'save' });
    save.addEventListener('click', busy(save, async () => {
      await api.patch('/api/system/settings', { alerts: { discordWebhook: discordIn.value.trim(), httpWebhook: httpIn.value.trim(), events }, statusPage: { enabled: spEnabled.checked, title: spTitle.value } });
      toast('Saved', 'success');
    }));
    const test = btn('Send test alert', { icon: 'bell' });
    test.addEventListener('click', busy(test, async () => { await api.post('/api/system/settings/test-alert'); toast('Test alert sent', 'success'); setTimeout(loadNotifs, 800); }));
    settingsCard = h('div', { class: 'col gap-lg' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('bell', 18), 'Alert channels'), h('p', null, 'Alerts always appear in the notification bell. Add channels to get them on your phone.'))),
        field('Discord webhook', discordIn, 'Server Settings → Integrations → Webhooks → New Webhook → Copy URL.'),
        field('HTTP webhook (JSON POST)', httpIn, 'For Slack-compatible relays, ntfy, Pushover bridges or your own endpoint.'),
        h('div', { class: 'label-text mb-sm' }, 'Send alerts for'),
        Object.entries(EVENTS).map(([k, l]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: events[k], onChange: e => { events[k] = e.target.checked; } }), h('span', null, l)))),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('activity', 18), 'Public status page'), h('p', null, 'A read-only page at /status showing uptime for the services you choose (Settings tab of each service).'))),
        h('label', { class: 'check' }, spEnabled, h('span', null, 'Enable /status')),
        field('Title', spTitle),
        h('a', { href: '/status', target: '_blank', rel: 'noopener', class: 'small' }, 'Open status page →')),
      h('div', { class: 'form-actions' }, test, save));
  }

  mount(el,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Monitoring & alerts'), h('p', null, 'Crash detection, recoveries, health checks and deploys — and where to be told about them.')),
      btn('Mark all read', { icon: 'check', onClick: async () => { await api.post('/api/system/notifications/read', {}); store.unread = 0; store.emit('notification-read'); loadNotifs(); } })),
    monCard,
    h('div', { class: 'grid', style: { gridTemplateColumns: admin ? 'minmax(0, 3fr) minmax(300px, 2fr)' : '1fr' } },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('list', 18), 'Notifications')), notifBox),
      settingsCard));
  loadNotifs().catch(e => mount(notifBox, h('p', { class: 'lvl-error' }, e.message)));
  return monCard._cleanup;
}

// ---------------- Data store (key-value JSON documents) ----------------
export async function dataPage() {
  const el = page('Data store');
  if (!store.can('admin')) return mount(el, empty('lock', 'Admins only', ''));
  let coll = null;
  const left = h('div');
  const right = h('div');

  async function loadCollections() {
    const list = await api.get('/api/system/kv');
    mount(left, h('div', { class: 'list' },
      list.map(c => h('div', { class: 'list-item', style: { cursor: 'pointer', fontWeight: c.name === coll ? 700 : 400 }, onClick: () => { coll = c.name; loadCollections(); loadDocs(); } },
        icon('database', 14), h('span', { class: 'grow mono small' }, c.name), h('span', { class: 'tiny muted' }, String(c.count)))),
      !list.length ? h('p', { class: 'small muted' }, 'No collections yet.') : null));
  }

  function editDoc(key, value) {
    const keyIn = h('input', { class: 'input mono', value: key || '', disabled: !!key, placeholder: 'document key' });
    const collIn = h('input', { class: 'input mono', value: coll || '', disabled: !!key, placeholder: 'collection' });
    const ed = createEditor({ value: JSON.stringify(value ?? { example: true }, null, 2), path: 'doc.json' });
    const save = btn('Save', { variant: 'primary' });
    const m = modal({
      title: key ? `Edit ${key}` : 'New document', size: 'wide',
      body: h('div', null, h('div', { class: 'grid cols-2' }, field('Collection', collIn), field('Key', keyIn)),
        h('div', { style: { height: '300px', display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } }, ed.el)),
      footer: [btn('Cancel', { onClick: () => m.close() }), save]
    });
    save.addEventListener('click', busy(save, async () => {
      let parsed;
      try { parsed = JSON.parse(ed.getValue()); } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
      const c = collIn.value.trim(), k = keyIn.value.trim();
      if (!c || !k) throw new Error('Collection and key are required');
      await api.put(`/api/system/kv/${encodeURIComponent(c)}/${encodeURIComponent(k)}`, { value: parsed });
      m.close();
      coll = c;
      loadCollections();
      loadDocs();
    }));
  }

  async function loadDocs() {
    if (!coll) return mount(right, empty('database', 'Pick a collection', 'Collections hold JSON documents you manage from here — handy for bot config, feature flags or notes.'));
    const docs = await api.get(`/api/system/kv/${encodeURIComponent(coll)}`);
    mount(right, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Key'), h('th', null, 'Value'), h('th', null, ''))),
      h('tbody', null, Object.entries(docs).map(([k, v]) => h('tr', null,
        h('td', { class: 'mono small' }, k),
        h('td', null, h('pre', { class: 'tiny muted', style: { maxHeight: '6em', overflow: 'hidden' } }, JSON.stringify(v, null, 1))),
        h('td', { class: 'actions' },
          btn('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Edit', onClick: () => editDoc(k, v) }),
          btn('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Delete', onClick: async () => { if (await confirmDialog(`Delete ${coll}/${k}?`, { danger: true, okLabel: 'Delete' })) { await api.del(`/api/system/kv/${encodeURIComponent(coll)}/${encodeURIComponent(k)}`); loadCollections(); loadDocs(); } } }))))))));
  }

  mount(el,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Data store'), h('p', null, 'JSON documents stored in the panel database. For app data, use each service\'s built-in SQLite database (Database tab).')),
      btn('New document', { variant: 'primary', icon: 'plus', onClick: () => editDoc(null, null) })),
    h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(200px, 1fr) minmax(0, 3fr)' } }, h('div', { class: 'card' }, left), h('div', { class: 'card' }, right)));
  loadCollections();
  loadDocs();
}

// ---------------- Panel export / import (moving to another server) ----------------
function transferCard() {
  const withBackups = h('input', { type: 'checkbox' });
  const fileIn = h('input', { type: 'file', accept: '.zip', class: 'input' });
  const result = h('div');
  const importBtn = btn('Import', { variant: 'primary', icon: 'upload' });
  importBtn.addEventListener('click', busy(importBtn, async () => {
    if (!fileIn.files[0]) throw new Error('Choose an export ZIP first');
    const fd = new FormData();
    fd.append('file', fileIn.files[0]);
    const r = await api.post('/api/system/import', fd);
    mount(result, h('div', { class: 'callout success mt' }, icon('check', 18), h('div', { class: 'callout-body' },
      h('strong', null, `Imported ${r.imported.length} service(s)`),
      h('p', null, [r.imported.length ? `New: ${r.imported.join(', ')}.` : '', r.skipped.length ? `Skipped (already exist): ${r.skipped.join(', ')}.` : '',
        `${r.envGroups} shared group(s), ${r.domains} domain(s), ${r.monitors} monitor(s).`].filter(Boolean).join(' ')))));
    const services = await api.get('/api/services');
    store.setServices(services);
  }));
  return h('div', { class: 'card mb' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('rocket', 18), 'Move to another server'),
      h('p', null, 'Export every service — code, .env secrets, settings, SQLite data — then import it on the new install (e.g. after deploying to Railway). Accounts are not included; create your owner account on the new server first.'))),
    h('div', { class: 'grid cols-2' },
      h('div', null,
        h('h3', { class: 'mb-sm' }, '1. Export from here'),
        h('label', { class: 'check' }, withBackups, h('span', null, 'Include backups', h('span', { class: 'desc' }, 'Bigger file, but keeps your rollback history.'))),
        h('button', { class: 'btn', onClick: () => { location.href = `/api/system/export${withBackups.checked ? '?backups=1' : ''}`; } }, icon('download', 15), 'Download export'),
        h('p', { class: 'tiny lvl-warning mt-sm' }, 'The file contains your bot tokens. Keep it private and delete it after importing.')),
      h('div', null,
        h('h3', { class: 'mb-sm' }, '2. Import on the new server'),
        field('Export ZIP', fileIn, 'Services whose id already exists here are skipped, never overwritten.'),
        importBtn)),
    result);
}

// ---------------- Panel settings ----------------
export async function panelSettingsPage() {
  const el = page('Panel settings');
  if (!store.can('admin')) return mount(el, empty('lock', 'Admins only', ''));
  mount(el, loading());
  const s = await api.get('/api/system/settings');
  const info = store.info || {};
  const retention = h('input', { class: 'input', type: 'number', min: 1, max: 200, value: s.backups.retention });
  const hour = h('input', { class: 'input', type: 'number', min: 0, max: 23, value: s.backups.dailyHour });
  const logSize = h('input', { class: 'input', type: 'number', min: 1, max: 500, value: s.logs.maxSizeMb });
  const logKeep = h('input', { class: 'input', type: 'number', min: 0, max: 20, value: s.logs.keepFiles });
  const save = btn('Save', { variant: 'primary', icon: 'save' });
  save.addEventListener('click', busy(save, async () => {
    await api.patch('/api/system/settings', { backups: { retention: retention.value, dailyHour: hour.value }, logs: { maxSizeMb: logSize.value, keepFiles: logKeep.value } });
    toast('Settings saved', 'success');
  }));
  mount(el,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Panel settings'), h('p', null, 'Retention and server information.'))),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, icon('archive', 18), 'Backups')),
        field('Keep this many unpinned backups per service', retention),
        field('Daily backups run at (server hour, 0-23)', hour)),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, icon('list', 18), 'Logs')),
        field('Rotate a log file at (MB)', logSize),
        field('Keep rotated files', logKeep, '0 = only the current file.'))),
    h('div', { class: 'form-actions mb' }, save),
    store.can('owner') ? transferCard() : null,
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, icon('server', 18), 'Server')),
      h('dl', { class: 'kv' },
        h('dt', null, 'Version'), h('dd', null, info.version || '—'),
        h('dt', null, 'Mode'), h('dd', null, info.production ? 'Production (public)' : 'Local (this computer only)'),
        h('dt', null, 'Public URL'), h('dd', null, info.publicUrl || location.origin),
        h('dt', null, 'AI assistant'), h('dd', null, info.ai ? `On (${info.aiModel})` : 'Off — set ANTHROPIC_API_KEY on the server to enable')),
      h('p', { class: 'small muted mt' }, 'Server options (port, data folder, AI key) are environment variables — see .env.example and README.md.')));
}

// ---------------- API docs ----------------
export async function docsPage() {
  const el = page('API reference');
  mount(el, loading());
  const groups = await api.get('/api/docs');
  const METHOD = { GET: 'info', POST: 'success', PUT: 'warning', PATCH: 'warning', DELETE: 'danger' };
  mount(el,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'API reference'), h('p', null, 'Automate OmniHost with personal API tokens.'))),
    h('div', { class: 'card mb' },
      h('h3', { class: 'mb-sm' }, 'Authentication'),
      h('p', { class: 'small' }, 'Create a token under My account → API tokens and send it as a header. Tokens act with your role\'s permissions.'),
      h('pre', { class: 'mono small', style: { background: 'var(--bg-input)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' } },
        `curl -H "Authorization: Bearer omni_…" ${location.origin}/api/services\n\ncurl -X POST -H "Authorization: Bearer omni_…" ${location.origin}/api/services/my-bot/restart`)),
    groups.map(g => h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, g.group), g.auth === 'none' ? badge('no auth', 'info') : null),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', null, g.items.map(([m, p, d]) => h('tr', null,
        h('td', { style: { width: '80px' } }, badge(m, METHOD[m])),
        h('td', { class: 'mono small' }, p),
        h('td', { class: 'small muted' }, d)))))))));
}

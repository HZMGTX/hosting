// Dependencies (npm / pip), outdated check, package.json scripts and one-off commands.
import { h, icon, mount, btn, toast, busy, confirmDialog, empty, badge } from '../../ui.js';
import { api, svcUrl } from '../../api.js';
import { store } from '../../store.js';

export async function packagesTab(root, svc) {
  const id = svc.id;
  const canEdit = store.can('edit', id);
  let data;
  let outdated = null;
  let auditResult = null;

  const watch = () => toast('Running… output is streaming to the Console tab', 'info', 2500);

  async function load() {
    data = await api.get(svcUrl(id, '/packages'));
    render();
  }

  function render() {
    const nameIn = h('input', { class: 'input mono', placeholder: data.manager === 'pip' ? 'requests  or  requests==2.32.0' : 'axios  or  axios@1.7.0', disabled: !canEdit });
    const addBtn = btn('Add', { variant: 'primary', icon: 'plus', disabled: !canEdit });
    const add = busy(addBtn, async () => {
      const name = nameIn.value.trim();
      if (!name) return;
      watch();
      const r = await api.post(svcUrl(id, '/packages'), { name });
      toast(r.ok ? `${name} installed` : `Install failed (exit ${r.code}) — see console`, r.ok ? 'success' : 'error');
      await load();
    });
    addBtn.addEventListener('click', add);
    nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });

    const installAll = btn(data.manager === 'pip' ? 'pip install -r requirements.txt' : 'npm install', { icon: 'download', disabled: !canEdit });
    installAll.addEventListener('click', busy(installAll, async () => {
      watch();
      const r = await api.post(svcUrl(id, '/install'));
      toast(r.ok ? 'Dependencies installed' : 'Install failed — see console', r.ok ? 'success' : 'error');
      await load();
    }));
    const upgradeAll = btn('Update all', { icon: 'refresh', disabled: !canEdit });
    upgradeAll.addEventListener('click', busy(upgradeAll, async () => {
      if (!(await confirmDialog('Update every dependency to the newest version allowed by its range?'))) return;
      watch();
      const r = await api.post(svcUrl(id, '/packages/upgrade'), {});
      toast(r.ok ? 'Updated' : 'Update failed — see console', r.ok ? 'success' : 'error');
      outdated = null;
      await load();
    }));
    const auditBtn = btn('Security audit', { icon: 'shield' });
    auditBtn.addEventListener('click', busy(auditBtn, async () => {
      auditResult = await api.post(svcUrl(id, '/packages/audit'));
      render();
    }));
    const auditBox = h('div');
    if (auditResult) {
      const r = auditResult;
      const variant = r.ok === true ? 'success' : r.ok === false ? 'error' : 'info';
      const fix = canEdit && r.manager === 'npm' && r.ok === false ? btn('Fix automatically', { size: 'sm', icon: 'wrench' }) : null;
      if (fix) fix.addEventListener('click', busy(fix, async () => {
        watch();
        const res = await api.post(svcUrl(id, '/packages/audit-fix'));
        toast(res.ok ? 'npm audit fix finished' : 'Some issues need manual upgrades — see console', res.ok ? 'success' : 'warning');
        auditResult = await api.post(svcUrl(id, '/packages/audit'));
        await load();
      }));
      mount(auditBox, h('div', { class: ['callout', variant] }, icon(r.ok ? 'shield' : 'alert', 18),
        h('div', { class: 'callout-body' },
          h('strong', null, r.message),
          r.counts ? h('p', null, ['critical', 'high', 'moderate', 'low'].filter(k => r.counts[k]).map(k => `${r.counts[k]} ${k}`).join(' · ')) : null,
          r.manager === 'pip' && r.ok === false ? h('pre', { class: 'tiny mono mt-sm' }, r.message) : null,
          (r.issues || []).length ? h('div', { class: 'list mt-sm' }, r.issues.slice(0, 20).map(i => h('div', { class: 'list-item small' },
            badge(i.severity, i.severity === 'critical' || i.severity === 'high' ? 'danger' : 'warning'),
            h('span', { class: 'mono' }, i.name), h('span', { class: 'grow muted ellipsis' }, i.title || i.range),
            i.fixAvailable ? badge('fix available', 'success') : null))) : null),
        fix));
    }
    const checkBtn = btn('Check for updates', { icon: 'search' });
    checkBtn.addEventListener('click', busy(checkBtn, async () => {
      outdated = await api.get(svcUrl(id, '/packages/outdated'));
      if (!outdated.length) toast('Everything is up to date', 'success');
      render();
    }));

    const outdatedMap = new Map((outdated || []).map(o => [o.name.toLowerCase(), o]));
    const scripts = Object.entries(data.scripts || {});

    mount(root,
      data.needsInstall ? h('div', { class: 'callout warning' }, icon('alert', 18), h('div', { class: 'callout-body' }, h('strong', null, 'Dependencies are not installed'), h('p', null, 'They are installed automatically on the next start, or install them now.')), canEdit ? installAll : null) : null,
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', null, h('h2', null, icon('package', 18), data.manager === 'pip' ? 'Python packages' : 'npm packages'), h('p', null, `From ${data.file}`)),
          h('div', { class: 'btn-group' }, checkBtn, auditBtn, canEdit ? upgradeAll : null, canEdit && !data.needsInstall ? installAll : null)),
        auditBox,
        canEdit ? h('div', { class: 'input-group mb' }, nameIn, addBtn) : null,
        data.packages.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, 'Package'), h('th', null, 'Wanted'), h('th', null, 'Installed'), h('th', null, 'Latest'), h('th', null, ''))),
          h('tbody', null, data.packages.map(p => {
            const o = outdatedMap.get(p.name.toLowerCase());
            const rm = btn('', { size: 'sm', variant: 'ghost', icon: 'trash', title: `Remove ${p.name}` });
            rm.addEventListener('click', busy(rm, async () => {
              if (!(await confirmDialog(`Uninstall ${p.name}?`, { okLabel: 'Uninstall', danger: true }))) return;
              watch();
              await api.del(svcUrl(id, `/packages/${encodeURIComponent(p.name)}`));
              await load();
            }));
            const up = o ? btn('Update', { size: 'sm', icon: 'refresh' }) : null;
            if (up) up.addEventListener('click', busy(up, async () => { watch(); await api.post(svcUrl(id, '/packages/upgrade'), { name: p.name }); outdated = null; await load(); }));
            return h('tr', null,
              h('td', null, h('span', { class: 'mono' }, p.name), p.dev ? h('span', null, ' ', badge('dev')) : null),
              h('td', { class: 'mono small muted' }, p.version || '—'),
              h('td', { class: 'mono small' }, p.installed === undefined ? '—' : p.installed || h('span', { class: 'lvl-warning' }, 'missing')),
              h('td', { class: 'mono small' }, o ? h('span', { class: 'lvl-warning' }, o.latest) : outdated ? h('span', { class: 'lvl-success' }, '✓') : '—'),
              h('td', { class: 'actions' }, canEdit ? [up, rm] : null));
          })))) : empty('package', 'No dependencies', data.manager === 'pip' ? 'Add packages above; they are written to requirements.txt.' : 'Add packages above; they are written to package.json.')),
      data.manager === 'npm' ? h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('terminal', 18), 'Scripts'), h('p', null, 'Run package.json scripts. Output goes to the console.'))),
        scripts.length ? h('div', { class: 'list' }, scripts.map(([name, cmd]) => {
          const run = btn('Run', { size: 'sm', icon: 'play', disabled: !canEdit });
          run.addEventListener('click', busy(run, async () => {
            watch();
            const r = await api.post(svcUrl(id, '/run-script'), { script: name });
            toast(`npm run ${name} ${r.ok ? 'finished' : `failed (exit ${r.code})`}`, r.ok ? 'success' : 'error');
          }));
          return h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('div', { class: 'mono', style: { fontWeight: 600 } }, name), h('div', { class: 'mono tiny muted ellipsis' }, cmd)), run);
        })) : h('p', { class: 'muted small' }, 'No scripts in package.json.')) : null,
      store.can('exec', id) ? commandCard(id, watch) : null);
  }

  try { await load(); } catch (e) { mount(root, empty('alert', 'Could not load packages', e.message)); }
}

function commandCard(id, watch) {
  const cmdIn = h('input', { class: 'input mono', placeholder: 'node scripts/migrate.js   ·   python manage.py check   ·   git status' });
  const run = btn('Run', { variant: 'primary', icon: 'play' });
  const exec = busy(run, async () => {
    const command = cmdIn.value.trim();
    if (!command) return;
    watch();
    const r = await api.post(svcUrl(id, '/exec'), { command });
    toast(`Exited with code ${r.code}`, r.ok ? 'success' : 'error');
  });
  run.addEventListener('click', exec);
  cmdIn.addEventListener('keydown', e => { if (e.key === 'Enter') exec(); });
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('zap', 18), 'Run a command'), h('p', null, 'One-off command in the service folder with its environment. No shell: pipes and && are not interpreted.'))),
    h('div', { class: 'input-group' }, cmdIn, run));
}

// Git deploys (clone/pull/webhook) + deploy history with one-click rollback.
import { h, icon, mount, btn, toast, busy, field, copyField, confirmDialog, timeAgo, fmtDate, badge } from '../../ui.js';
import { api, svcUrl } from '../../api.js';
import { store } from '../../store.js';

const SOURCE_LABEL = { git: 'Git deploy', webhook: 'GitHub push', upload: 'Upload', editor: 'Editor', template: 'Template', restore: 'Restore', rollback: 'Rollback', schedule: 'Scheduled' };

export async function deployTab(root, svc) {
  const id = svc.id;
  const canEdit = store.can('edit', id);
  const g = svc.git;
  const urlIn = h('input', { class: 'input mono', value: g.url, placeholder: 'https://github.com/you/your-bot', disabled: !canEdit });
  const branchIn = h('input', { class: 'input mono', value: g.branch, disabled: !canEdit });
  const tokenIn = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', value: g.hasToken ? '••••' : '', placeholder: 'only for private repos', disabled: !canEdit });
  let autoDeploy = g.autoDeploy;
  const history = h('div');

  async function saveConfig() {
    const res = await api.put(svcUrl(id, '/git'), { url: urlIn.value.trim(), branch: branchIn.value.trim() || 'main', token: tokenIn.value, autoDeploy });
    Object.assign(svc.git, res);
    toast('Repository settings saved', 'success');
  }

  const saveBtn = btn('Save', { icon: 'save' });
  saveBtn.addEventListener('click', busy(saveBtn, saveConfig));
  const deployBtn = btn(g.lastCommit ? 'Pull & redeploy' : 'Clone & deploy', { variant: 'primary', icon: 'rocket' });
  deployBtn.addEventListener('click', busy(deployBtn, async () => {
    await saveConfig();
    toast('Deploying… follow progress in the console', 'info');
    const r = await api.post(svcUrl(id, '/git/deploy'));
    toast(`Deployed ${r.commit.slice(0, 7)} — ${r.message}${r.restarted ? ' (restarted)' : ''}`, 'success');
    loadHistory();
  }));
  const detectBtn = btn('Detect from .git', { size: 'sm', variant: 'ghost', icon: 'search' });
  detectBtn.addEventListener('click', busy(detectBtn, async () => {
    const r = await api.get(svcUrl(id, '/git/detect'));
    if (!r) return toast('This folder is not a git checkout', 'info');
    if (r.url) urlIn.value = r.url;
    branchIn.value = r.branch;
    toast('Filled in from the existing checkout', 'success');
  }));

  const hookUrl = `${location.origin}/api/hooks/github/${encodeURIComponent(id)}`;

  async function loadHistory() {
    const list = await api.get(svcUrl(id, '/deploys'));
    mount(history, list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Source'), h('th', null, 'Change'), h('th', null, 'By'), h('th', null, ''))),
      h('tbody', null, list.map(d => h('tr', null,
        h('td', { class: 'nowrap', title: fmtDate(d.at) }, timeAgo(d.at)),
        h('td', null, badge(SOURCE_LABEL[d.source] || d.source, d.status === 'failed' ? 'danger' : d.source === 'rollback' ? 'warning' : 'accent')),
        h('td', null, d.commit ? h('span', { class: 'mono small' }, d.commit.slice(0, 7) + ' ') : null, h('span', { class: d.status === 'failed' ? 'lvl-error' : '' }, d.message)),
        h('td', { class: 'small muted' }, d.by),
        h('td', { class: 'actions' }, d.backupId && canEdit ? (() => {
          const b = btn('Roll back', { size: 'sm', icon: 'restart' });
          b.addEventListener('click', busy(b, async () => {
            if (!(await confirmDialog(`Restore the files exactly as they were after this ${SOURCE_LABEL[d.source] || d.source} (${timeAgo(d.at)})?`, { okLabel: 'Roll back', detail: 'Your current files are backed up first, and .env is kept. The service restarts if it is running.' }))) return;
            await api.post(svcUrl(id, `/deploys/${d.id}/rollback`));
            toast('Rolled back', 'success');
            loadHistory();
          }));
          return b;
        })() : d.source === 'editor' && !d.backupId ? h('span', { class: 'tiny faint' }, 'snapshot pending') : null)))))) : h('p', { class: 'muted small' }, 'No deploys yet. Every upload, git deploy and batch of editor saves is recorded here with a snapshot you can roll back to.'));
  }

  mount(root,
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('git', 18), 'Git repository'), h('p', null, 'Deploy from GitHub, GitLab or any https git host.')), detectBtn),
        field('Repository URL', urlIn),
        h('div', { class: 'grid cols-2' }, field('Branch', branchIn), field('Access token', tokenIn, 'Stored on the server, never sent to the bot.')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: autoDeploy, disabled: !canEdit, onChange: e => { autoDeploy = e.target.checked; } }),
          h('span', null, 'Deploy automatically on push', h('span', { class: 'desc' }, 'Requires the webhook below to be added in GitHub.'))),
        g.lastCommit ? h('p', { class: 'small muted' }, 'Current: ', h('span', { class: 'mono' }, g.lastCommit.slice(0, 7)), ` — ${g.lastMessage} (${timeAgo(g.lastDeployAt)})`) : null,
        canEdit ? h('div', { class: 'form-actions' }, saveBtn, deployBtn) : null),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('link', 18), 'GitHub webhook'), h('p', null, 'Repository → Settings → Webhooks → Add webhook.'))),
        field('Payload URL', copyField(hookUrl)),
        field('Content type', h('div', { class: 'mono small' }, 'application/json')),
        svc.git.webhookSecret ? field('Secret', copyField(svc.git.webhookSecret, { secret: true })) : h('p', { class: 'small muted' }, 'Only editors can see the webhook secret.'),
        h('p', { class: 'small muted' }, 'Choose "Just the push event". Pushes to other branches are ignored.'),
        location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? h('div', { class: 'callout warning' }, icon('alert', 16), h('div', { class: 'callout-body' }, h('p', null, 'GitHub cannot reach localhost. Webhooks work once OmniHost is deployed to a public URL.'))) : null,
        canEdit ? h('div', { class: 'form-actions' }, btn('New secret', { size: 'sm', icon: 'refresh', onClick: async () => { if (await confirmDialog('Generate a new webhook secret? You must update it in GitHub too.')) { await api.put(svcUrl(id, '/git'), { regenerateSecret: true }); toast('New secret generated — reload to see it', 'success'); } } })) : null)),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('rocket', 18), 'Deploy history')), history));
  loadHistory();
}

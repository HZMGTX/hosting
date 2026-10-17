// AI crash assistant dialog: explanation + reviewable search/replace patch.
import { h, icon, mount, btn, toast, busy, modal } from '../../ui.js';
import { api, svcUrl } from '../../api.js';

function diffView(edit) {
  return h('div', { class: 'diff mb-sm' },
    edit.search.split('\n').map(l => h('div', { class: 'del' }, '- ' + l)),
    edit.replace.split('\n').map(l => h('div', { class: 'add' }, '+ ' + l)));
}

export function openAiAssistant(svc) {
  const body = h('div', null, h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, 'Reading the recent errors and your code…')));
  const m = modal({ title: 'AI crash assistant', size: 'wide', body });
  api.post(svcUrl(svc.id, '/ai/analyze'), {}).then(r => {
    const applicable = r.edits.filter(e => e.applies);
    const apply = btn(`Apply ${applicable.length} change(s)`, { variant: 'primary', icon: 'check', disabled: !applicable.length });
    apply.addEventListener('click', busy(apply, async () => {
      await api.post(svcUrl(svc.id, '/ai/apply'), { file: r.file, edits: applicable.map(({ search, replace }) => ({ search, replace })) });
      toast(`Patched ${r.file}. A backup was taken first. Restart to try it.`, 'success');
      m.close();
    }));
    mount(body,
      h('div', { class: 'callout info' }, icon('sparkles', 18), h('div', { class: 'callout-body' }, h('p', { style: { whiteSpace: 'pre-wrap', color: 'var(--text)' } }, r.explanation))),
      r.edits.length ? h('div', null,
        h('h3', { class: 'mb-sm' }, `Proposed changes to ${r.file}`),
        r.edits.map(e => h('div', null, diffView(e), e.applies ? null : h('p', { class: 'tiny lvl-warning' }, 'This change does not match the file exactly and will be skipped.'))),
        h('div', { class: 'form-actions' }, btn('Close', { onClick: () => m.close() }), apply),
        h('p', { class: 'tiny faint' }, `Suggested by ${r.model}. Review before applying — AI can be wrong.`))
        : h('p', { class: 'small muted' }, 'No code change is needed — follow the steps above.'));
  }).catch(e => mount(body, h('div', { class: 'callout error' }, icon('alert', 18), h('div', { class: 'callout-body' }, h('p', null, e.message)))));
}

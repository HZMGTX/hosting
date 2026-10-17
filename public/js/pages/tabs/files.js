// File manager: folder tree, multi-tab editor, uploads (files, folders, ZIPs), search.
import { h, icon, mount, btn, toast, busy, menu, confirmDialog, promptDialog, modal, fmtBytes, debounce } from '../../ui.js';
import { api, svcUrl } from '../../api.js';
import { store } from '../../store.js';
import { setLeaveGuard } from '../../router.js';
import { createEditor } from '../../components/editor.js';

const FILE_ICON = { js: 'file', py: 'file', json: 'file', md: 'book', env: 'lock' };
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i;

export function filesTab(root, svc, q) {
  const id = svc.id;
  const canEdit = store.can('edit', id);
  let entries = [];
  const expanded = new Set(JSON.parse(sessionStorage.getItem(`omni-exp-${id}`) || '[]'));
  const open = new Map(); // path -> { content, original, mtime, readOnly, binary, editor }
  let active = null;
  let restartOnSave = (() => { try { return localStorage.getItem('omni-restart-on-save') !== '0'; } catch { return true; } })();

  const treeEl = h('div', { class: 'file-tree', role: 'tree', 'aria-label': 'Files' });
  const tabsEl = h('div', { class: 'editor-tabs', role: 'tablist' });
  const toolbar = h('div', { class: 'editor-toolbar' });
  const editorHost = h('div', { class: 'col', style: { flex: 1, minHeight: 0, gap: 0 } });
  const folderInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, class: 'hidden' });
  const fileInput = h('input', { type: 'file', multiple: true, class: 'hidden' });

  const isDirty = f => f && !f.binary && f.editor && f.editor.getValue() !== f.original;
  const anyDirty = () => [...open.values()].some(isDirty);

  setLeaveGuard(async () => !anyDirty() || confirmDialog('You have unsaved changes. Leave without saving?', { okLabel: 'Discard changes', danger: true }));
  const beforeUnload = e => { if (anyDirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  // ----- tree -----
  async function loadTree() {
    try {
      const res = await api.get(svcUrl(id, '/files/tree'));
      entries = res.entries;
      renderTree();
    } catch (e) { mount(treeEl, h('div', { class: 'tree-row dim' }, e.message)); }
  }

  function children(dir) {
    return entries.filter(e => {
      const parent = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
      return parent === dir;
    });
  }

  function renderTree() {
    const frag = document.createDocumentFragment();
    const walk = (dir, depth) => {
      for (const e of children(dir)) {
        const name = e.path.split('/').pop();
        const isDir = e.type === 'dir';
        const isOpen = expanded.has(e.path);
        const row = h('div', {
          class: ['tree-row', active === e.path ? 'active' : ''], role: 'treeitem', tabindex: '0',
          style: { paddingLeft: `${0.5 + depth * 0.9}rem` }, title: e.path,
          'aria-expanded': isDir ? String(isOpen) : undefined,
          onClick: () => isDir ? toggleDir(e.path) : openFile(e.path),
          onKeydown: ev => { if (ev.key === 'Enter') { ev.preventDefault(); isDir ? toggleDir(e.path) : openFile(e.path); } },
          onContextmenu: ev => { ev.preventDefault(); rowMenu(ev.currentTarget, e); }
        },
        isDir ? h('span', { class: ['chev', isOpen ? 'open' : ''] }, icon('chevron', 12)) : h('span', { class: 'chev' }),
        icon(isDir ? (isOpen ? 'folderOpen' : 'folder') : FILE_ICON[name.split('.').pop()] || (name.startsWith('.env') ? 'lock' : 'file'), 15),
        h('span', { class: ['name', e.collapsed ? 'dim' : ''] }, name),
        !isDir && e.size > 100 * 1024 ? h('span', { class: 'tiny faint' }, fmtBytes(e.size)) : null,
        canEdit ? h('button', { class: 'btn ghost sm icon more', title: 'Actions', 'aria-label': `Actions for ${name}`, onClick: ev => { ev.stopPropagation(); rowMenu(ev.currentTarget, e); } }, icon('more', 14)) : null);
        frag.appendChild(row);
        if (isDir && isOpen && !e.collapsed) walk(e.path, depth + 1);
        if (isDir && isOpen && e.collapsed) frag.appendChild(h('div', { class: 'tree-row dim', style: { paddingLeft: `${1.4 + depth * 0.9}rem` } }, 'Installed dependencies (not listed)'));
      }
    };
    walk('', 0);
    if (!entries.length) frag.appendChild(h('div', { class: 'tree-row dim' }, canEdit ? 'Empty — create or drop files here' : 'No files'));
    mount(treeEl, frag);
  }

  function toggleDir(p) {
    expanded.has(p) ? expanded.delete(p) : expanded.add(p);
    sessionStorage.setItem(`omni-exp-${id}`, JSON.stringify([...expanded]));
    renderTree();
  }

  function parentOf(p) { return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; }

  function rowMenu(anchor, e) {
    const isDir = e.type === 'dir';
    const base = isDir ? e.path : parentOf(e.path);
    menu(anchor, [
      !isDir ? { label: 'Open', icon: 'edit', onClick: () => openFile(e.path) } : null,
      { label: 'New file here', icon: 'filePlus', onClick: () => newFile(base) },
      { label: 'New folder here', icon: 'folderPlus', onClick: () => newFolder(base) },
      { label: 'Upload here', icon: 'upload', onClick: () => { uploadDir = base; fileInput.click(); } },
      '-',
      { label: 'Rename / move', icon: 'edit', onClick: () => rename(e.path) },
      { label: isDir ? 'Download as ZIP' : 'Download', icon: 'download', onClick: () => { location.href = svcUrl(id, `/files/download?path=${encodeURIComponent(e.path)}`); } },
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => remove(e.path, isDir) }
    ].filter(Boolean));
  }

  // ----- file ops -----
  async function newFile(dir = '') {
    const p = await promptDialog({ title: 'New file', label: 'Path', value: dir ? dir + '/' : '', placeholder: 'commands/hello.js', mono: true, okLabel: 'Create' });
    if (!p) return;
    if (entries.some(e => e.path === p)) return openFile(p);
    await api.put(svcUrl(id, '/files/content'), { path: p, content: '' });
    p.split('/').slice(0, -1).reduce((acc, seg) => { const d = acc ? `${acc}/${seg}` : seg; expanded.add(d); return d; }, '');
    await loadTree();
    openFile(p);
  }

  async function newFolder(dir = '') {
    const p = await promptDialog({ title: 'New folder', label: 'Path', value: dir ? dir + '/' : '', mono: true, okLabel: 'Create' });
    if (!p) return;
    await api.post(svcUrl(id, '/files/mkdir'), { path: p });
    expanded.add(p);
    loadTree();
  }

  async function rename(p) {
    const to = await promptDialog({ title: 'Rename or move', label: 'New path', value: p, mono: true, okLabel: 'Rename' });
    if (!to || to === p) return;
    try {
      const res = await api.post(svcUrl(id, '/files/rename'), { from: p, to });
      for (const [k, f] of [...open]) {
        if (k === p || k.startsWith(p + '/')) {
          const nk = res.path + k.slice(p.length);
          open.delete(k);
          open.set(nk, f);
          if (active === k) active = nk;
        }
      }
      await loadTree();
      renderTabs();
      showActive();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function remove(p, isDir) {
    if (!(await confirmDialog(`Delete ${isDir ? 'folder' : 'file'} "${p}"${isDir ? ' and everything inside it' : ''}?`, { okLabel: 'Delete', danger: true, detail: 'A backup is not created automatically — use Backups first if unsure.' }))) return;
    await api.del(svcUrl(id, `/files?path=${encodeURIComponent(p)}`));
    for (const k of [...open.keys()]) if (k === p || k.startsWith(p + '/')) closeTab(k, true);
    loadTree();
  }

  // ----- tabs & editor -----
  async function openFile(p, line) {
    if (!open.has(p)) {
      let data;
      try { data = await api.get(svcUrl(id, `/files/content?path=${encodeURIComponent(p)}`)); } catch (e) { return toast(e.message, 'error'); }
      const f = { content: data.content, original: data.content, mtime: data.mtime, readOnly: !canEdit || data.readOnly || data.tooLarge, binary: data.binary || data.tooLarge, size: data.size, editor: null };
      if (!f.binary) {
        f.editor = createEditor({ value: data.content, path: p, readOnly: f.readOnly, onChange: () => renderTabs(), onSave: () => save(p) });
      }
      open.set(p, f);
      // Expand parents so the file is visible in the tree.
      p.split('/').slice(0, -1).reduce((acc, seg) => { const d = acc ? `${acc}/${seg}` : seg; expanded.add(d); return d; }, '');
    }
    active = p;
    renderTabs();
    renderTree();
    showActive();
    if (line) setTimeout(() => open.get(p).editor && open.get(p).editor.gotoLine(line), 60);
  }

  async function closeTab(p, force) {
    const f = open.get(p);
    if (!force && isDirty(f) && !(await confirmDialog(`"${p}" has unsaved changes. Close anyway?`, { okLabel: 'Discard', danger: true }))) return;
    if (f && f.editor) f.editor.destroy();
    open.delete(p);
    if (active === p) active = [...open.keys()].pop() || null;
    renderTabs();
    renderTree();
    showActive();
  }

  function renderTabs() {
    mount(tabsEl, [...open.keys()].map(p => h('div', {
      class: ['editor-tab', p === active ? 'active' : ''], role: 'tab', 'aria-selected': String(p === active), title: p,
      onClick: () => { active = p; renderTabs(); renderTree(); showActive(); },
      onAuxclick: e => { if (e.button === 1) closeTab(p); }
    }, h('span', null, p.split('/').pop()),
    isDirty(open.get(p)) ? h('span', { class: 'dirty', title: 'Unsaved changes' }) : null,
    h('button', { class: 'close', 'aria-label': `Close ${p}`, onClick: e => { e.stopPropagation(); closeTab(p); } }, icon('x', 12)))));
  }

  function showActive() {
    const f = active && open.get(active);
    if (!f) {
      mount(toolbar);
      toolbar.classList.add('hidden');
      return mount(editorHost, h('div', { class: 'editor-empty' }, h('div', null, icon('file', 36), h('p', { class: 'mt-sm' }, 'Select a file to edit'), h('p', { class: 'small faint' }, 'Ctrl+S save · Ctrl+F find · Ctrl+H replace · Ctrl+G go to line · Ctrl+/ comment'))));
    }
    toolbar.classList.remove('hidden');
    const saveBtn = btn('Save', { size: 'sm', variant: 'primary', icon: 'save', disabled: f.readOnly || f.binary });
    saveBtn.addEventListener('click', busy(saveBtn, () => save(active)));
    const restartToggle = h('label', { class: 'row small', title: 'Restart the service after saving (if it is running)' },
      h('input', { type: 'checkbox', checked: restartOnSave, onChange: e => { restartOnSave = e.target.checked; try { localStorage.setItem('omni-restart-on-save', restartOnSave ? '1' : '0'); } catch {} } }), 'Restart on save');
    mount(toolbar,
      h('span', { class: 'path' }, active),
      f.readOnly && !f.binary ? h('span', { class: 'badge warning' }, canEdit ? 'Read-only (large file)' : 'Read-only') : null,
      f.editor ? btn('', { size: 'sm', variant: 'ghost', icon: 'search', title: 'Find (Ctrl+F)', onClick: () => f.editor.openFind(false) }) : null,
      btn('', { size: 'sm', variant: 'ghost', icon: 'download', title: 'Download', onClick: () => { location.href = svcUrl(id, `/files/download?path=${encodeURIComponent(active)}`); } }),
      canEdit && svc.type !== 'static' ? restartToggle : null,
      canEdit ? saveBtn : null);
    if (f.binary) {
      const url = svcUrl(id, `/files/download?path=${encodeURIComponent(active)}`);
      return mount(editorHost, h('div', { class: 'editor-binary' }, h('div', null,
        IMG_RE.test(active) ? h('img', { src: url, alt: active }) : icon('file', 40),
        h('p', null, `${f.size > 10 * 1024 * 1024 ? 'Large' : 'Binary'} file · ${fmtBytes(f.size)}`),
        h('a', { class: 'btn', href: url }, icon('download', 15), 'Download'))));
    }
    mount(editorHost, f.editor.el);
    setTimeout(() => f.editor.focus(), 20);
  }

  async function save(p, force = false) {
    const f = open.get(p);
    if (!f || f.readOnly || f.binary) return;
    const content = f.editor.getValue();
    try {
      const res = await api.put(svcUrl(id, '/files/content'), { path: p, content, expectedMtime: f.mtime, force, restart: restartOnSave });
      f.original = content;
      f.mtime = res.mtime;
      renderTabs();
      toast(res.restarted ? `Saved ${p.split('/').pop()} — restarting` : `Saved ${p.split('/').pop()}`, 'success', 2000);
      if (!entries.some(e => e.path === p)) loadTree();
    } catch (e) {
      if (e.status === 409 && (await confirmDialog('This file was changed on disk after you opened it (maybe by a deploy). Overwrite it with your version?', { okLabel: 'Overwrite', danger: true }))) return save(p, true);
      if (e.status !== 409) toast(e.message, 'error');
    }
  }

  // ----- uploads -----
  let uploadDir = '';
  async function upload(files, paths) {
    if (!files.length) return;
    const fd = new FormData();
    if (uploadDir) fd.append('dir', uploadDir);
    files.forEach((file, i) => {
      fd.append('files', file);
      if (paths) fd.append('paths', paths[i]);
    });
    toast(`Uploading ${files.length} file(s)…`, 'info', 2000);
    try {
      const res = await api.post(svcUrl(id, '/files/upload'), fd);
      toast(res.extracted ? `Unzipped ${res.written.length} file(s) into the main folder` : `Uploaded ${res.written.length} file(s)`, 'success');
      if (res.entry) {
        toast(`Start file set to ${res.entry}`, 'info');
        store.upsertService({ id, entry: res.entry });
      }
      for (const p of res.written) { const f = open.get(p); if (f && !isDirty(f)) { open.delete(p); if (active === p) openFile(p); } }
      loadTree();
    } catch (e) { toast(e.message, 'error'); }
    uploadDir = '';
  }
  fileInput.addEventListener('change', () => { upload([...fileInput.files]); fileInput.value = ''; });
  folderInput.addEventListener('change', () => { const fs = [...folderInput.files]; upload(fs, fs.map(f => f.webkitRelativePath.split('/').slice(1).join('/') || f.name)); folderInput.value = ''; });

  async function readEntry(entry, prefix, out) {
    if (entry.isFile) {
      await new Promise(res => entry.file(f => { out.push([f, prefix + f.name]); res(); }, res));
    } else if (entry.isDirectory) {
      if (['node_modules', '.git', '.venv'].includes(entry.name)) return;
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise(res => reader.readEntries(res, () => res([])));
        for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, out);
      } while (batch.length);
    }
  }

  if (canEdit) {
    treeEl.addEventListener('dragover', e => { e.preventDefault(); treeEl.classList.add('dragover'); });
    treeEl.addEventListener('dragleave', e => { if (!treeEl.contains(e.relatedTarget)) treeEl.classList.remove('dragover'); });
    treeEl.addEventListener('drop', async e => {
      e.preventDefault();
      treeEl.classList.remove('dragover');
      const items = [...(e.dataTransfer.items || [])];
      const out = [];
      if (items.length && items[0].webkitGetAsEntry) {
        for (const it of items) { const en = it.webkitGetAsEntry(); if (en) await readEntry(en, '', out); }
      } else {
        for (const f of e.dataTransfer.files) out.push([f, f.name]);
      }
      upload(out.map(x => x[0]), out.map(x => x[1]));
    });
  }

  // ----- project search -----
  function openSearch() {
    const inputEl = h('input', { class: 'input', placeholder: 'Search in all files…', autofocus: true });
    const results = h('div', { class: 'search-results mt-sm' });
    const m = modal({ title: 'Search files', size: 'wide', body: h('div', null, inputEl, results) });
    inputEl.addEventListener('input', debounce(async () => {
      const qv = inputEl.value.trim();
      if (qv.length < 2) return mount(results);
      try {
        const hits = await api.get(svcUrl(id, `/files/search?q=${encodeURIComponent(qv)}`));
        mount(results, hits.length ? hits.map(hit => h('div', { class: 'search-hit', onClick: () => { m.close(); openFile(hit.path, hit.line || undefined); } },
          h('span', { class: 'loc' }, `${hit.path}${hit.line ? ':' + hit.line : ''}`), h('span', { class: 'txt' }, hit.text))) : h('p', { class: 'muted small' }, 'No matches.'));
      } catch (e) { mount(results, h('p', { class: 'lvl-error small' }, e.message)); }
    }, 250));
  }

  const head = h('div', { class: 'file-pane-head' },
    h('span', { class: 'title' }, 'Files'),
    btn('', { size: 'sm', variant: 'ghost', icon: 'search', title: 'Search in files', onClick: openSearch }),
    canEdit ? btn('', { size: 'sm', variant: 'ghost', icon: 'filePlus', title: 'New file', onClick: () => newFile('') }) : null,
    canEdit ? btn('', { size: 'sm', variant: 'ghost', icon: 'folderPlus', title: 'New folder', onClick: () => newFolder('') }) : null,
    canEdit ? btn('', { size: 'sm', variant: 'ghost', icon: 'upload', title: 'Upload', onClick: e => menu(e.currentTarget, [
      { label: 'Upload files or a ZIP', icon: 'file', onClick: () => fileInput.click() },
      { label: 'Upload a folder', icon: 'folder', onClick: () => folderInput.click() }
    ]) }) : null,
    btn('', { size: 'sm', variant: 'ghost', icon: 'refresh', title: 'Refresh', onClick: loadTree }));

  mount(root, h('div', { class: 'files-layout' },
    h('div', { class: 'file-pane' }, head, treeEl, canEdit ? h('div', { class: 'file-drop-hint' }, 'Drop files or folders here · a .zip is unzipped into the main folder') : null, fileInput, folderInput),
    h('div', { class: 'editor-pane' }, tabsEl, toolbar, editorHost)));

  showActive();
  loadTree().then(() => {
    if (q.path) openFile(q.path, q.line ? +q.line : undefined);
    else if (!active) {
      const entry = entries.find(e => e.path === svc.entry);
      if (entry) openFile(entry.path);
    }
  });

  return () => {
    window.removeEventListener('beforeunload', beforeUnload);
    setLeaveGuard(null);
    for (const f of open.values()) if (f.editor) f.editor.destroy();
  };
}

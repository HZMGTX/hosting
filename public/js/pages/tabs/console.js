// Live console: streamed stdout/stderr/system lines with ANSI colours, search, filters, stdin.
import { h, icon, mount, btn, toast, debounce, copyText } from '../../ui.js';
import { api, svcUrl } from '../../api.js';
import { store } from '../../store.js';
import * as ws from '../../ws.js';

const MAX_LINES = 2000;

// Convert SGR escape codes into spans with CSS classes (text is set via textContent).
function ansiToNodes(text, highlight) {
  const out = [];
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, classes = [], m;
  const push = s => {
    if (!s) return;
    if (!classes.length && !highlight) { out.push(document.createTextNode(s)); return; }
    const span = h('span', { class: classes.join(' ') });
    appendHighlighted(span, s, highlight);
    out.push(span);
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] ? m[1].split(';').map(Number) : [0];
    for (const c of codes) {
      if (c === 0) classes = [];
      else if (c === 1) classes.push('a-b');
      else if (c === 2) classes.push('a-d');
      else if (c === 3) classes.push('a-i');
      else if (c === 4) classes.push('a-u');
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) { classes = classes.filter(x => !/^a-\d+$/.test(x)); classes.push(`a-${c}`); }
      else if (c === 39) classes = classes.filter(x => !/^a-\d+$/.test(x));
    }
  }
  // eslint-disable-next-line no-control-regex
  push(text.slice(last).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  return out;
}

function appendHighlighted(el, s, q) {
  if (!q) { el.appendChild(document.createTextNode(s)); return; }
  const lower = s.toLowerCase();
  let i = 0, idx;
  while ((idx = lower.indexOf(q, i)) >= 0) {
    if (idx > i) el.appendChild(document.createTextNode(s.slice(i, idx)));
    el.appendChild(h('mark', null, s.slice(idx, idx + q.length)));
    i = idx + q.length;
  }
  if (i < s.length) el.appendChild(document.createTextNode(s.slice(i)));
}

function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour12: false });
}

export function consoleTab(root, svc) {
  const id = svc.id;
  let entries = [];
  let filter = 'all';
  let search = '';
  let follow = true;
  let historyMode = false;

  const lines = h('div', { class: 'console-lines', role: 'log', 'aria-live': 'off' });
  const jump = btn('Jump to latest', { size: 'sm', icon: 'arrowDown', variant: 'primary' });
  jump.classList.add('jump-bottom', 'hidden');
  jump.addEventListener('click', () => { follow = true; lines.scrollTop = lines.scrollHeight; jump.classList.add('hidden'); });

  function matches(e) {
    if (filter !== 'all' && e.s !== filter) return false;
    if (search && !e.m.toLowerCase().includes(search)) return false;
    return true;
  }

  // Per-browser display preferences.
  const prefs = (() => { try { return { wrap: true, ts: true, ...JSON.parse(localStorage.getItem('omni-console-prefs') || '{}') }; } catch { return { wrap: true, ts: true }; } })();
  const savePrefs = () => { try { localStorage.setItem('omni-console-prefs', JSON.stringify(prefs)); } catch {} };
  const applyPrefs = () => { lines.classList.toggle('nowrap-lines', !prefs.wrap); lines.classList.toggle('no-ts', !prefs.ts); };
  applyPrefs();

  function lineEl(e) {
    return h('div', { class: ['console-line', e.s] }, h('span', { class: 'ts' }, fmtTime(e.t)), h('span', { class: 'msg' }, ansiToNodes(e.m, search)));
  }

  function renderAll() {
    const visible = entries.filter(matches);
    if (!visible.length) {
      mount(lines, h('div', { class: 'console-empty' }, search || filter !== 'all' ? 'No lines match.' : 'No output yet. Press Start to launch the service.'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const e of visible.slice(-MAX_LINES)) frag.appendChild(lineEl(e));
    mount(lines, frag);
    if (follow) lines.scrollTop = lines.scrollHeight;
  }

  function addEntry(e) {
    if (historyMode) return;
    entries.push(e);
    if (entries.length > MAX_LINES * 1.5) entries = entries.slice(-MAX_LINES);
    if (!matches(e)) return;
    const empty = lines.querySelector('.console-empty');
    if (empty) empty.remove();
    lines.appendChild(lineEl(e));
    while (lines.childElementCount > MAX_LINES) lines.firstChild.remove();
    if (follow) lines.scrollTop = lines.scrollHeight;
    else jump.classList.remove('hidden');
  }

  lines.addEventListener('scroll', () => {
    const atBottom = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 30;
    follow = atBottom;
    if (atBottom) jump.classList.add('hidden');
  });

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter output' },
    [['all', 'All'], ['out', 'Output'], ['err', 'Errors'], ['sys', 'System']].map(([v, l]) =>
      h('button', { class: v === filter ? 'active' : '', onClick: e => { filter = v; seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === e.currentTarget)); renderAll(); } }, l)));

  const searchInput = h('input', { class: 'input', placeholder: 'Search output…', 'aria-label': 'Search output' });
  searchInput.addEventListener('input', debounce(() => { search = searchInput.value.trim().toLowerCase(); renderAll(); }, 150));

  const histBtn = btn('Search history', { size: 'sm', icon: 'search', title: 'Search all saved log files on disk' });
  histBtn.addEventListener('click', async () => {
    const q = searchInput.value.trim();
    if (!q) return toast('Type something to search for first', 'info');
    const res = await api.get(svcUrl(id, `/logs?q=${encodeURIComponent(q)}${filter !== 'all' ? `&stream=${filter}` : ''}`));
    historyMode = true;
    entries = res.slice().reverse();
    search = q.toLowerCase();
    renderAll();
    toast(`${res.length} match(es) in saved logs. Press "Live" to return.`, 'info');
    liveBtn.classList.remove('hidden');
  });
  const liveBtn = btn('Live', { size: 'sm', icon: 'activity', variant: 'primary' });
  liveBtn.classList.add('hidden');
  liveBtn.addEventListener('click', () => { historyMode = false; liveBtn.classList.add('hidden'); ws.subscribe(id)(); reload(); });

  const input = h('input', { placeholder: store.can('operate', id) ? 'Send a line to the process stdin…' : 'Read-only', 'aria-label': 'Standard input', disabled: !store.can('operate', id) });
  const cmdHistory = [];
  let hIdx = -1;
  input.addEventListener('keydown', async e => {
    if (e.key === 'Enter' && input.value) {
      const text = input.value;
      cmdHistory.unshift(text);
      hIdx = -1;
      input.value = '';
      if (!ws.sendStdin(id, text)) {
        try { await api.post(svcUrl(id, '/stdin'), { text }); } catch (err) { toast(err.message, 'error'); }
      }
    } else if (e.key === 'ArrowUp' && cmdHistory.length) {
      hIdx = Math.min(cmdHistory.length - 1, hIdx + 1); input.value = cmdHistory[hIdx]; e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      hIdx = Math.max(-1, hIdx - 1); input.value = hIdx >= 0 ? cmdHistory[hIdx] : ''; e.preventDefault();
    }
  });

  mount(root, h('div', { class: 'console-wrap' },
    h('div', { class: 'console' },
      h('div', { class: 'console-toolbar' },
        seg, searchInput, histBtn, liveBtn,
        h('div', { class: 'grow' }),
        btn('', { size: 'sm', icon: 'menu', title: 'Toggle line wrapping', onClick: e => { prefs.wrap = !prefs.wrap; savePrefs(); applyPrefs(); e.currentTarget.classList.toggle('primary', prefs.wrap); } }),
        btn('', { size: 'sm', icon: 'clock', title: 'Toggle timestamps', onClick: e => { prefs.ts = !prefs.ts; savePrefs(); applyPrefs(); e.currentTarget.classList.toggle('primary', prefs.ts); } }),
        btn('', { size: 'sm', icon: 'copy', title: 'Copy visible output', onClick: () => copyText(entries.filter(matches).map(x => `${prefs.ts ? fmtTime(x.t) + ' ' : ''}${x.m.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')}`).join('\n'), 'Console copied') }),
        btn('', { size: 'sm', icon: 'download', title: 'Download logs', onClick: () => { location.href = svcUrl(id, '/logs/download'); } }),
        store.can('operate', id) ? btn('', { size: 'sm', icon: 'trash', title: 'Clear console', onClick: async () => { await api.del(svcUrl(id, '/logs')); entries = []; renderAll(); } }) : null),
      lines,
      h('div', { class: 'console-input' }, h('span', null, '›'), input)),
    jump));

  function reload() {
    // The server sends 'history' on subscribe; also fetch once in case the socket is down.
    api.get(svcUrl(id, '/logs')).then(list => { if (!historyMode) { entries = list; renderAll(); } }).catch(() => {});
  }
  reload();
  const offs = [
    store.on(`history:${id}`, list => { if (!historyMode) { entries = list.slice(); renderAll(); } }),
    store.on(`log:${id}`, addEntry)
  ];
  return () => offs.forEach(f => f());
}

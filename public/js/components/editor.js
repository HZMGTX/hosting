// Code editor: transparent <textarea> over a highlighted layer, with line numbers, find/replace,
// go-to-line, bracket matching, smart indent, comment toggle and Ctrl+S.
import { h, icon, mount, btn, promptDialog } from '../ui.js';
import { tokenize, languageFor, COMMENT_PREFIX } from './highlight.js';

const LINE_H = 20;
const PAD = 10;
const HIGHLIGHT_LIMIT = 300 * 1024;
const PAIRS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = { ')': '(', ']': '[', '}': '{' };
const AUTO_PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const CLOSE_CHARS = new Set([')', ']', '}', '"', "'", '`']);

function insertText(ta, text) {
  ta.focus();
  // execCommand keeps the native undo stack; fall back to setRangeText where unsupported.
  if (!document.execCommand('insertText', false, text)) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
  }
}

function findMatchingBracket(text, pos) {
  const ch = text[pos];
  if (PAIRS[ch]) {
    let depth = 0;
    for (let i = pos; i < text.length && i < pos + 200000; i++) {
      if (text[i] === ch) depth++;
      else if (text[i] === PAIRS[ch] && --depth === 0) return i;
    }
  } else if (CLOSERS[ch]) {
    let depth = 0;
    for (let i = pos; i >= 0 && i > pos - 200000; i--) {
      if (text[i] === ch) depth++;
      else if (text[i] === CLOSERS[ch] && --depth === 0) return i;
    }
  }
  return -1;
}

export function createEditor({ value = '', path = '', readOnly = false, onChange, onSave }) {
  let lang = languageFor(path);
  let find = { open: false, query: '', replace: '', caseSensitive: false, matches: [], index: -1 };
  let bracket = [];
  let renderQueued = false;

  const ta = h('textarea', { class: 'code-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': `Editing ${path}`, readOnly });
  ta.value = value;
  const layer = h('pre', { class: 'code-layer', 'aria-hidden': 'true' });
  const gutter = h('div', { class: 'code-gutter', 'aria-hidden': 'true' });
  const scroll = h('div', { class: 'code-scroll' }, layer, ta);
  const editorEl = h('div', { class: ['code-editor', readOnly ? 'readonly' : ''] }, gutter, scroll);

  const findInput = h('input', { class: 'input', placeholder: 'Find', 'aria-label': 'Find' });
  const replaceInput = h('input', { class: 'input', placeholder: 'Replace', 'aria-label': 'Replace' });
  const countEl = h('span', { class: 'count' });
  const caseBtn = btn('Aa', { size: 'sm', variant: 'ghost', title: 'Match case' });
  const findbar = h('div', { class: 'findbar hidden' },
    findInput, caseBtn,
    btn('', { size: 'sm', icon: 'chevronDown', title: 'Next (Enter)', onClick: () => step(1) }),
    btn('', { size: 'sm', icon: 'chevron', title: 'Previous (Shift+Enter)', onClick: () => step(-1) }),
    countEl,
    readOnly ? null : replaceInput,
    readOnly ? null : btn('Replace', { size: 'sm', onClick: replaceOne }),
    readOnly ? null : btn('All', { size: 'sm', onClick: replaceAll }),
    h('div', { class: 'grow' }),
    btn('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Close (Esc)', onClick: closeFind }));

  const root = h('div', { class: 'col', style: { flex: 1, minHeight: 0, gap: 0 } }, findbar, editorEl);

  function computeMatches() {
    find.matches = [];
    const q = find.query;
    if (!q) return;
    const text = find.caseSensitive ? ta.value : ta.value.toLowerCase();
    const needle = find.caseSensitive ? q : q.toLowerCase();
    let i = 0, idx;
    while ((idx = text.indexOf(needle, i)) >= 0 && find.matches.length < 5000) {
      find.matches.push([idx, idx + needle.length]);
      i = idx + Math.max(1, needle.length);
    }
  }

  function render() {
    renderQueued = false;
    const text = ta.value;
    const tokens = text.length <= HIGHLIGHT_LIMIT ? tokenize(text, lang) : [];
    const marks = [];
    if (find.open) find.matches.forEach((m, i) => marks.push([m[0], m[1], i === find.index ? 't-hl cur' : 't-hl']));
    for (const b of bracket) marks.push([b, b + 1, 't-br']);

    // Sweep over boundaries so tokens and marks can overlap.
    const points = new Set([0, text.length]);
    for (const t of tokens) { points.add(t[0]); points.add(t[1]); }
    for (const m of marks) { points.add(m[0]); points.add(m[1]); }
    const sorted = [...points].filter(p => p >= 0 && p <= text.length).sort((a, b) => a - b);
    const frag = document.createDocumentFragment();
    let ti = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (a === b) continue;
      while (ti < tokens.length && tokens[ti][1] <= a) ti++;
      const cls = [];
      if (ti < tokens.length && tokens[ti][0] <= a && tokens[ti][1] >= b) cls.push(tokens[ti][2]);
      for (const m of marks) if (m[0] <= a && m[1] >= b) cls.push(m[2]);
      const piece = text.slice(a, b);
      if (cls.length) { const s = document.createElement('span'); s.className = cls.join(' '); s.textContent = piece; frag.appendChild(s); }
      else frag.appendChild(document.createTextNode(piece));
    }
    frag.appendChild(document.createTextNode('\n'));
    mount(layer, frag);

    const lines = text.split('\n').length;
    if (gutter.childElementCount !== lines) {
      const g = document.createDocumentFragment();
      for (let i = 1; i <= lines; i++) { const d = document.createElement('div'); d.textContent = i; g.appendChild(d); }
      mount(gutter, g);
      gutter.style.minWidth = `${Math.max(48, String(lines).length * 9 + 24)}px`;
    }
    markCurrentLine();
    ta.style.height = Math.max(layer.offsetHeight, scroll.clientHeight) + 'px';
    ta.style.width = Math.max(layer.scrollWidth, scroll.clientWidth) + 'px';
    countEl.textContent = find.query ? `${find.matches.length ? find.index + 1 : 0} of ${find.matches.length}` : '';
  }

  function queueRender() {
    if (!renderQueued) { renderQueued = true; requestAnimationFrame(render); }
  }

  function currentLine() {
    return ta.value.slice(0, ta.selectionStart).split('\n').length;
  }

  let lastCur = null;
  function markCurrentLine() {
    const n = currentLine();
    if (lastCur && lastCur.parentNode === gutter) lastCur.classList.remove('cur');
    lastCur = gutter.children[n - 1] || null;
    if (lastCur) lastCur.classList.add('cur');
  }

  function updateBracket() {
    const pos = ta.selectionStart;
    const text = ta.value;
    let b = [];
    for (const p of [pos - 1, pos]) {
      if (p >= 0 && (PAIRS[text[p]] || CLOSERS[text[p]])) {
        const m = findMatchingBracket(text, p);
        if (m >= 0) { b = [p, m]; break; }
      }
    }
    if (b.join() !== bracket.join()) { bracket = b; queueRender(); }
    markCurrentLine();
  }

  function scrollToOffset(offset) {
    const line = ta.value.slice(0, offset).split('\n').length;
    const y = (line - 1) * LINE_H + PAD;
    if (y < scroll.scrollTop || y > scroll.scrollTop + scroll.clientHeight - LINE_H * 2) scroll.scrollTop = Math.max(0, y - scroll.clientHeight / 3);
  }

  function select(start, end) {
    ta.focus();
    ta.setSelectionRange(start, end);
    scrollToOffset(start);
    updateBracket();
  }

  // ----- find / replace -----
  function openFind(withReplace) {
    find.open = true;
    findbar.classList.remove('hidden');
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && !sel.includes('\n')) findInput.value = sel;
    find.query = findInput.value;
    computeMatches();
    find.index = find.matches.findIndex(m => m[0] >= ta.selectionStart);
    if (find.index < 0 && find.matches.length) find.index = 0;
    queueRender();
    (withReplace && !readOnly ? replaceInput : findInput).focus();
    findInput.select();
  }
  function closeFind() {
    find.open = false;
    findbar.classList.add('hidden');
    queueRender();
    ta.focus();
  }
  function step(dir) {
    if (!find.matches.length) return;
    find.index = (find.index + dir + find.matches.length) % find.matches.length;
    const [a, b] = find.matches[find.index];
    select(a, b);
    findInput.focus();
    queueRender();
  }
  function replaceOne() {
    if (readOnly || find.index < 0 || !find.matches[find.index]) return;
    const [a, b] = find.matches[find.index];
    ta.focus();
    ta.setSelectionRange(a, b);
    insertText(ta, replaceInput.value);
    computeMatches();
    if (find.index >= find.matches.length) find.index = 0;
    if (find.matches.length) select(...find.matches[find.index]);
    queueRender();
  }
  function replaceAll() {
    if (readOnly || !find.matches.length) return;
    const count = find.matches.length;
    let text = ta.value;
    for (let i = find.matches.length - 1; i >= 0; i--) {
      const [a, b] = find.matches[i];
      text = text.slice(0, a) + replaceInput.value + text.slice(b);
    }
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    insertText(ta, text);
    computeMatches();
    queueRender();
    countEl.textContent = `Replaced ${count}`;
  }
  findInput.addEventListener('input', () => {
    find.query = findInput.value;
    computeMatches();
    find.index = find.matches.length ? 0 : -1;
    if (find.matches.length) { const [a, b] = find.matches[0]; ta.setSelectionRange(a, b); scrollToOffset(a); }
    queueRender();
  });
  findInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
  });
  replaceInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
  });
  caseBtn.addEventListener('click', () => {
    find.caseSensitive = !find.caseSensitive;
    caseBtn.classList.toggle('primary', find.caseSensitive);
    computeMatches();
    queueRender();
  });

  async function gotoLinePrompt() {
    const total = ta.value.split('\n').length;
    const v = await promptDialog({ title: 'Go to line', label: `Line number (1-${total})`, value: String(currentLine()), validate: s => (/^\d+$/.test(s) && +s >= 1 ? null : 'Enter a line number') });
    if (v) gotoLine(+v);
  }

  function gotoLine(n) {
    const lines = ta.value.split('\n');
    const line = Math.max(1, Math.min(lines.length, n));
    let offset = 0;
    for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1;
    select(offset, offset + lines[line - 1].length);
    scroll.scrollTop = Math.max(0, (line - 1) * LINE_H - scroll.clientHeight / 3);
  }

  // ----- editing keys -----
  function selectedLineRange() {
    const v = ta.value;
    const start = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = v.indexOf('\n', ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? 1 : 0));
    if (end < 0) end = v.length;
    return [start, end];
  }

  function indentUnit() {
    const m = ta.value.match(/^( +|\t)\S/m);
    if (!m) return lang === 'py' ? '    ' : '  ';
    return m[1] === '\t' ? '\t' : m[1].length >= 4 && lang === 'py' ? '    ' : m[1].length === 4 ? '    ' : '  ';
  }

  function shiftLines(outdent) {
    const [s, e] = selectedLineRange();
    const unit = indentUnit();
    const block = ta.value.slice(s, e);
    const lines = block.split('\n');
    const next = lines.map(l => {
      if (!outdent) return unit + l;
      if (l.startsWith(unit)) return l.slice(unit.length);
      return l.replace(/^[ \t]{1,4}/, '');
    }).join('\n');
    ta.setSelectionRange(s, e);
    insertText(ta, next);
    ta.setSelectionRange(s, s + next.length);
  }

  function toggleComment() {
    const prefix = COMMENT_PREFIX[lang];
    if (!prefix) return;
    const [s, e] = selectedLineRange();
    const lines = ta.value.slice(s, e).split('\n');
    const all = lines.filter(l => l.trim()).every(l => l.trimStart().startsWith(prefix));
    const next = lines.map(l => {
      if (!l.trim()) return l;
      if (all) return l.replace(new RegExp(`^(\\s*)${prefix.replace(/[/]/g, '\\/')} ?`), '$1');
      const ind = l.match(/^\s*/)[0];
      return `${ind}${prefix} ${l.slice(ind.length)}`;
    }).join('\n');
    ta.setSelectionRange(s, e);
    insertText(ta, next);
    ta.setSelectionRange(s, s + next.length);
  }

  ta.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (onSave) onSave(); return; }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(false); return; }
    if (mod && e.key.toLowerCase() === 'h') { e.preventDefault(); openFind(true); return; }
    if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); gotoLinePrompt(); return; }
    if (e.key === 'Escape' && find.open) { e.preventDefault(); e.stopPropagation(); closeFind(); return; }
    if (readOnly) return;
    if (mod && e.key === '/') { e.preventDefault(); toggleComment(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (ta.selectionStart !== ta.selectionEnd && ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) shiftLines(e.shiftKey);
      else if (e.shiftKey) shiftLines(true);
      else insertText(ta, indentUnit());
      return;
    }
    if (e.key === 'Enter' && !mod && !e.altKey) {
      e.preventDefault();
      const v = ta.value;
      const lineStart = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const line = v.slice(lineStart, ta.selectionStart);
      let ind = line.match(/^[ \t]*/)[0];
      const trimmed = line.trimEnd();
      const opens = /[{[(]$/.test(trimmed) || (lang === 'py' && trimmed.endsWith(':'));
      const nextCh = v[ta.selectionStart];
      if (opens) {
        const inner = ind + indentUnit();
        if (CLOSERS[nextCh] && PAIRS[trimmed.slice(-1)] === nextCh) {
          insertText(ta, '\n' + inner + '\n' + ind);
          const pos = ta.selectionStart - ind.length - 1;
          ta.setSelectionRange(pos, pos);
          return;
        }
        ind = inner;
      }
      insertText(ta, '\n' + ind);
      return;
    }
    // Auto-close brackets and quotes; type over an existing closer; wrap a selection.
    if (!mod && !e.altKey && (AUTO_PAIRS[e.key] || CLOSE_CHARS.has(e.key))) {
      const v = ta.value;
      const s = ta.selectionStart, en = ta.selectionEnd;
      const next = v[en] || '';
      const prev = v[s - 1] || '';
      const isQuote = e.key === '"' || e.key === "'" || e.key === '`';
      if (s === en && CLOSE_CHARS.has(e.key) && next === e.key) {
        e.preventDefault();
        ta.setSelectionRange(s + 1, s + 1);
        updateBracket();
        return;
      }
      if (AUTO_PAIRS[e.key]) {
        if (s !== en) {
          e.preventDefault();
          const inner = v.slice(s, en);
          insertText(ta, e.key + inner + AUTO_PAIRS[e.key]);
          ta.setSelectionRange(s + 1, s + 1 + inner.length);
          return;
        }
        const nextOk = !next || /[\s)\]},;:]/.test(next);
        const prevOk = !isQuote || !/[\w$\\]/.test(prev);
        if (nextOk && prevOk) {
          e.preventDefault();
          insertText(ta, e.key + AUTO_PAIRS[e.key]);
          ta.setSelectionRange(s + 1, s + 1);
          return;
        }
      }
    }
    if (e.key === 'Backspace' && ta.selectionStart === ta.selectionEnd) {
      const v = ta.value;
      const p = ta.selectionStart;
      if (AUTO_PAIRS[v[p - 1]] && AUTO_PAIRS[v[p - 1]] === v[p]) {
        e.preventDefault();
        ta.setSelectionRange(p - 1, p + 1);
        insertText(ta, '');
        return;
      }
      const lineStart = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const before = v.slice(lineStart, ta.selectionStart);
      const unit = indentUnit();
      if (before.length && /^[ ]+$/.test(before) && unit !== '\t' && before.length % unit.length === 0) {
        e.preventDefault();
        ta.setSelectionRange(ta.selectionStart - unit.length, ta.selectionStart);
        insertText(ta, '');
      }
    }
  });

  ta.addEventListener('input', () => {
    if (find.open) computeMatches();
    queueRender();
    if (onChange) onChange(ta.value);
  });
  for (const ev of ['keyup', 'click', 'select']) ta.addEventListener(ev, updateBracket);
  scroll.addEventListener('scroll', () => { gutter.scrollTop = scroll.scrollTop; });
  const ro = new ResizeObserver(() => queueRender());
  ro.observe(scroll);
  queueRender();

  return {
    el: root,
    getValue: () => ta.value,
    setValue(v) { ta.value = v; queueRender(); },
    setPath(p) { lang = languageFor(p); queueRender(); },
    focus: () => ta.focus(),
    gotoLine,
    openFind,
    get readOnly() { return readOnly; },
    destroy() { ro.disconnect(); }
  };
}

export { icon };

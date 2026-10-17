// Small regex-based syntax highlighter. Produces [start, end, className] token ranges.
const JS_KW = 'await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|async|as|interface|type|enum|implements|private|public|protected|readonly|declare|namespace|module|require';
const PY_KW = 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case|self|print';

function rules(lang) {
  switch (lang) {
    case 'js':
      return [
        [/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/, 't-com'],
        [/`(?:\\[\s\S]|[^\\`])*`?|'(?:\\.|[^\\'\n])*'?|"(?:\\.|[^\\"\n])*"?/, 't-str'],
        [/\b(?:true|false|null|undefined|NaN|Infinity)\b/, 't-bool'],
        [new RegExp(`\\b(?:${JS_KW})\\b`), 't-kw'],
        [/\b(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?n?)\b/, 't-num'],
        [/\b[A-Z][A-Za-z0-9_$]*\b/, 't-type'],
        [/[A-Za-z_$][\w$]*(?=\s*\()/, 't-fn'],
        [/(?<=\.)[A-Za-z_$][\w$]*/, 't-prop'],
        [/=>|[=!]==?|[+\-*/%&|^<>]=?|\?\?|\?\.|&&|\|\|/, 't-op']
      ];
    case 'py':
      return [
        [/#[^\n]*/, 't-com'],
        [/[rRbBfFuU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^\\"\n])*"?|'(?:\\.|[^\\'\n])*'?)/, 't-str'],
        [/@[\w.]+/, 't-fn'],
        [/\b(?:True|False|None)\b/, 't-bool'],
        [new RegExp(`\\b(?:${PY_KW})\\b`), 't-kw'],
        [/\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?j?\b/, 't-num'],
        [/(?<=\bdef\s+)\w+|\w+(?=\s*\()/, 't-fn'],
        [/(?<=\bclass\s+)\w+|\b[A-Z][A-Za-z0-9_]*\b/, 't-type']
      ];
    case 'json':
      return [
        [/"(?:\\.|[^\\"\n])*"(?=\s*:)/, 't-key'],
        [/"(?:\\.|[^\\"\n])*"?/, 't-str'],
        [/\b(?:true|false|null)\b/, 't-bool'],
        [/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, 't-num']
      ];
    case 'html':
      return [
        [/<!--[\s\S]*?(?:-->|$)/, 't-com'],
        [/<\/?[A-Za-z][\w:-]*|\/?>/, 't-tag'],
        [/\b[\w:-]+(?==)/, 't-attr'],
        [/"[^"]*"?|'[^']*'?/, 't-str']
      ];
    case 'css':
      return [
        [/\/\*[\s\S]*?(?:\*\/|$)/, 't-com'],
        [/"[^"\n]*"?|'[^'\n]*'?/, 't-str'],
        [/@[\w-]+/, 't-kw'],
        [/#[\da-fA-F]{3,8}\b/, 't-num'],
        [/[\w-]+(?=\s*:[^:{])/, 't-prop'],
        [/-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b/, 't-num'],
        [/[.#][\w-]+/, 't-type']
      ];
    case 'env':
      return [
        [/^\s*#[^\n]*/m, 't-com'],
        [/^\s*(?:export\s+)?[A-Za-z_][\w.-]*(?=\s*=)/m, 't-key'],
        [/"(?:\\.|[^\\"\n])*"?|'[^'\n]*'?/, 't-str']
      ];
    case 'yaml':
      return [
        [/#[^\n]*/, 't-com'],
        [/^\s*-?\s*[\w.-]+(?=\s*:)/m, 't-key'],
        [/"(?:\\.|[^\\"\n])*"?|'[^'\n]*'?/, 't-str'],
        [/\b(?:true|false|null|yes|no|on|off)\b/, 't-bool'],
        [/\b\d+(?:\.\d+)?\b/, 't-num']
      ];
    case 'sh':
      return [
        [/#[^\n]*/, 't-com'],
        [/"(?:\\.|[^\\"])*"?|'[^']*'?/, 't-str'],
        [/\$\{?[\w@#?*!-]+\}?/, 't-prop'],
        [/\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|export|local|echo|cd|exit)\b/, 't-kw']
      ];
    case 'sql':
      return [
        [/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/, 't-com'],
        [/'(?:''|[^'])*'?|"(?:""|[^"])*"?/, 't-str'],
        [/\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|VIEW|DROP|ALTER|ADD|COLUMN|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|NOT|NULL|DEFAULT|AND|OR|IN|IS|LIKE|BETWEEN|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|DISTINCT|UNION|ALL|CASE|WHEN|THEN|ELSE|END|IF|EXISTS|INTEGER|TEXT|REAL|BLOB|BEGIN|COMMIT|ROLLBACK|PRAGMA|AUTOINCREMENT|ASC|DESC|RETURNING|WITH)\b/i, 't-kw'],
        [/\b(?:COUNT|SUM|AVG|MIN|MAX|COALESCE|IFNULL|LENGTH|LOWER|UPPER|DATE|DATETIME|STRFTIME|JSON_EXTRACT)(?=\s*\()/i, 't-fn'],
        [/\b\d+(?:\.\d+)?\b/, 't-num']
      ];
    case 'md':
      return [
        [/^#{1,6}[^\n]*/m, 't-kw'],
        [/```[\s\S]*?(?:```|$)|`[^`\n]*`/, 't-str'],
        [/\*\*[^*\n]+\*\*|__[^_\n]+__/, 't-type'],
        [/\[[^\]\n]*\]\([^)\n]*\)/, 't-fn']
      ];
    default:
      return [];
  }
}

const cache = new Map();
function compiled(lang) {
  if (!cache.has(lang)) {
    const r = rules(lang);
    const source = r.map(([re]) => `(${re.source})`).join('|');
    cache.set(lang, r.length ? { re: new RegExp(source, 'gm'), classes: r.map(x => x[1]), groups: r.map(([re]) => countGroups(re) + 1) } : null);
  }
  return cache.get(lang);
}

function countGroups(re) {
  return (new RegExp(re.source + '|')).exec('').length - 1;
}

export function languageFor(path) {
  const name = (path || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (name.endsWith('.env') || name.startsWith('.env') || name.split('/').pop().startsWith('.env')) return 'env';
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) return 'js';
  if (ext === 'py') return 'py';
  if (['json', 'jsonc', 'webmanifest'].includes(ext) || name.endsWith('.lock')) return 'json';
  if (['html', 'htm', 'xml', 'svg', 'vue'].includes(ext)) return 'html';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (['yml', 'yaml'].includes(ext)) return 'yaml';
  if (['sh', 'bash', 'zsh'].includes(ext) || name.endsWith('dockerfile')) return 'sh';
  if (['md', 'markdown'].includes(ext)) return 'md';
  if (ext === 'sql') return 'sql';
  if (['txt', 'cfg', 'ini', 'toml'].includes(ext) || name.endsWith('requirements.txt')) return name.endsWith('.toml') || name.endsWith('.ini') ? 'env' : 'plain';
  return 'plain';
}

export function tokenize(text, lang) {
  const c = compiled(lang);
  if (!c) return [];
  const tokens = [];
  c.re.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = c.re.exec(text)) && guard++ < 200000) {
    if (m[0] === '') { c.re.lastIndex++; continue; }
    let gi = 1;
    for (let r = 0; r < c.classes.length; r++) {
      if (m[gi] !== undefined) { tokens.push([m.index, m.index + m[0].length, c.classes[r]]); break; }
      gi += c.groups[r];
    }
  }
  return tokens;
}

export const COMMENT_PREFIX = { js: '//', py: '#', sh: '#', env: '#', yaml: '#', sql: '--', css: null, html: null, json: null, md: null, plain: null };

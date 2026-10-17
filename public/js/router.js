// Hash router: "#/services/my-bot/console" → route handler with params. Supports leave-guards.
const routes = [];
let current = null;
let guard = null;

export function route(pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '\\/?$');
  routes.push({ re, keys, handler, pattern });
}

export function navigate(path, { replace = false } = {}) {
  const target = '#' + path;
  if (replace) history.replaceState(null, '', target);
  else if (location.hash !== target) { location.hash = target; return; }
  resolve();
}

// A page can block navigation (e.g. unsaved editor changes) by returning false/promise<false>.
export function setLeaveGuard(fn) { guard = fn; }

export function currentPath() {
  return (location.hash || '#/').slice(1).split('?')[0] || '/';
}

export function query() {
  const q = (location.hash.split('?')[1]) || '';
  return Object.fromEntries(new URLSearchParams(q));
}

let lastHash = location.hash;
async function resolve() {
  if (guard && location.hash !== lastHash) {
    const ok = await guard();
    if (ok === false) { history.replaceState(null, '', lastHash); return; }
    guard = null;
  }
  lastHash = location.hash;
  const path = currentPath();
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      if (current && current.cleanup) { try { current.cleanup(); } catch {} }
      current = { pattern: r.pattern, params };
      const cleanup = await r.handler(params, query());
      if (current && current.params === params) current.cleanup = typeof cleanup === 'function' ? cleanup : null;
      window.dispatchEvent(new CustomEvent('routechange', { detail: { path, params } }));
      return;
    }
  }
  navigate('/', { replace: true });
}

export function startRouter() {
  window.addEventListener('hashchange', resolve);
  resolve();
}

// Public routing for hosted web apps & static sites:
//   https://panel/apps/<id>/...      (path-prefix routing, sandboxed by default)
//   https://custom-domain.com/...    (Host-header routing via db.domains)
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const services = require('./services');
const { isValidId } = require('./safePath');

let pm = null;
function init(processManager) { pm = processManager; }

// Without allow-same-origin the app runs in an opaque origin, so its JS can never call the panel API
// with the owner's cookies. Turn it off per service if the app needs its own cookies/localStorage.
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox';

function domainTarget(host) {
  if (!host) return null;
  const name = String(host).toLowerCase().replace(/:\d+$/, '');
  const rec = db.data.domains[name];
  return rec && db.data.services[rec.serviceId] ? rec.serviceId : null;
}

function sendError(res, status, title, detail) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${status}</title><body style="font-family:system-ui;background:#0b0f19;color:#e5e7eb;display:grid;place-items:center;min-height:90vh;margin:0"><div style="text-align:center"><h1 style="font-size:3rem;margin:0">${status}</h1><p>${title}</p><p style="color:#9ca3af">${detail || ''}</p></div>`);
}

// ----- static sites -----
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.xml': 'application/xml',
  '.map': 'application/json'
};

function serveStatic(svc, req, res, urlPath, extraHeaders) {
  const root = path.resolve(services.dir(svc.id), svc.staticRoot || '.');
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0]); } catch { return sendError(res, 400, 'Bad request'); }
  const segments = rel.split('/').filter(Boolean);
  // Hide dotfiles (.env!), dependencies and VCS data.
  if (segments.some(s => s.startsWith('.') || s === 'node_modules')) return sendError(res, 404, 'Not found');
  let file = path.resolve(root, ...segments);
  if (file !== root && !file.startsWith(root + path.sep)) return sendError(res, 404, 'Not found');
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch {}
  if (!fs.existsSync(file)) {
    const ext = path.extname(file);
    if (svc.spa && (!ext || ext === '.html')) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) return sendError(res, 404, 'Not found', 'This static site has no index.html yet.');
  }
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const headers = {
    ...extraHeaders,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'ETag': etag,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ----- reverse proxy -----
function forwardHeaders(req, prefix) {
  const headers = { ...req.headers };
  const remote = req.socket.remoteAddress || '';
  headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${remote}` : remote;
  headers['x-forwarded-proto'] = headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  headers['x-forwarded-host'] = headers['x-forwarded-host'] || headers.host || '';
  if (prefix) headers['x-forwarded-prefix'] = prefix;
  // Never forward panel credentials to hosted apps.
  if (headers.cookie) {
    headers.cookie = headers.cookie.split(';').filter(c => !c.trim().startsWith('omni_sid=')).join(';');
    if (!headers.cookie.trim()) delete headers.cookie;
  }
  return headers;
}

function proxyHttp(svc, req, res, targetPath, prefix, extraHeaders) {
  const upstream = http.request({
    host: '127.0.0.1', port: svc.port, method: req.method, path: targetPath || '/',
    headers: forwardHeaders(req, prefix)
  }, up => {
    const headers = { ...up.headers, ...extraHeaders };
    if (prefix && headers.location && headers.location.startsWith('/') && !headers.location.startsWith('//')) {
      headers.location = prefix + headers.location;
    }
    if (prefix && headers['set-cookie']) {
      headers['set-cookie'] = [].concat(headers['set-cookie']).map(c => c.replace(/;\s*path=\/(?=;|$)/i, `; Path=${prefix}/`));
    }
    res.writeHead(up.statusCode, up.statusMessage, headers);
    up.pipe(res);
  });
  upstream.setTimeout(120000, () => upstream.destroy(new Error('timeout')));
  upstream.on('error', e => {
    const booting = pm && pm.state(svc.id).status !== 'ONLINE';
    sendError(res, 502, booting ? 'This app is not running.' : 'The app did not answer.',
      booting ? 'Start it from the OmniHost dashboard.' : `Make sure it listens on process.env.PORT (${svc.port}). (${e.code || e.message})`);
  });
  req.pipe(upstream);
}

function handle(svc, req, res, rest, prefix) {
  const extraHeaders = prefix && svc.sandbox ? { 'Content-Security-Policy': SANDBOX_CSP } : {};
  if (svc.type === 'static') {
    if (pm && pm.state(svc.id).status !== 'ONLINE') return sendError(res, 503, 'This site is stopped.', 'Start it from the OmniHost dashboard.');
    return serveStatic(svc, req, res, rest, extraHeaders);
  }
  if (svc.type !== 'web') return sendError(res, 404, 'Not found', 'This service does not serve web traffic.');
  if (!svc.port) return sendError(res, 503, 'This app has not been started yet.');
  return proxyHttp(svc, req, res, rest, prefix, extraHeaders);
}

// Express middleware for /apps/<id>/...
function appsMiddleware(req, res) {
  const m = req.originalUrl.match(/^\/apps\/([^/?#]+)(\/[^#]*)?(\?.*)?$/);
  const id = m && m[1];
  if (!id || !isValidId(id) || !db.data.services[id]) return sendError(res, 404, 'App not found');
  if (!m[2]) { res.writeHead(301, { Location: `/apps/${id}/${m[3] || ''}` }); return res.end(); }
  handle(db.data.services[id], req, res, (m[2] || '/') + (m[3] || ''), `/apps/${id}`);
}

// Express middleware: requests whose Host is a mapped custom domain go straight to that service.
function domainMiddleware(req, res, next) {
  const id = domainTarget(req.headers.host);
  if (!id) return next();
  handle(db.data.services[id], req, res, req.originalUrl, '');
}

// WebSocket upgrades for hosted apps (returns true if handled).
function handleUpgrade(req, socket, head) {
  let id = domainTarget(req.headers.host);
  let targetPath = req.url;
  let prefix = '';
  if (!id) {
    const m = req.url.match(/^\/apps\/([^/?#]+)(\/[^#]*)?(\?.*)?$/);
    if (!m) return false;
    id = m[1];
    prefix = `/apps/${id}`;
    targetPath = (m[2] || '/') + (m[3] || '');
  }
  const svc = isValidId(id) && db.data.services[id];
  if (!svc || svc.type !== 'web' || !svc.port) { socket.destroy(); return true; }
  const upstream = http.request({ host: '127.0.0.1', port: svc.port, path: targetPath, method: req.method, headers: forwardHeaders(req, prefix) });
  upstream.on('upgrade', (up, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
    for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
  });
  upstream.on('response', r => { socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`); });
  upstream.on('error', () => socket.destroy());
  upstream.end();
  return true;
}

module.exports = { init, appsMiddleware, domainMiddleware, handleUpgrade, domainTarget };

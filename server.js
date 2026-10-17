// OmniHost — self-hosted panel for Discord bots, web apps, static sites and workers.
const http = require('http');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');

const config = require('./lib/config');
const db = require('./db');
db.load();

const auth = require('./lib/auth');
const bus = require('./lib/bus');
const pm = require('./lib/processManager');
const metrics = require('./lib/metrics');
const proxy = require('./lib/proxy');
const scheduler = require('./lib/scheduler');
const logStore = require('./lib/logStore');
const diagnostics = require('./lib/diagnostics');
const apiDocs = require('./lib/apiDocs');
const { isValidId } = require('./lib/safePath');

const { svcRouter: envRouter, groupRouter } = require('./routes/env');

metrics.init(pm);
proxy.init(pm);
scheduler.init();
const monitors = require('./lib/monitors');
monitors.init();

const app = express();
app.disable('x-powered-by');
// Railway/Render/Fly put a TLS-terminating proxy in front; trust it for req.secure and req.ip.
app.set('trust proxy', config.isProd ? 1 : 'loopback');

// 1) Custom domains and /apps/* go straight to hosted services (their own headers, no panel auth).
app.use(proxy.domainMiddleware);
app.use('/apps', proxy.appsMiddleware);

// 2) Panel security headers.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://cdn.discordapp.com", "connect-src 'self' ws: wss:",
    "font-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"
  ].join('; '));
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// 3) Public API (raw-body webhook must come before the JSON parser).
app.use('/api', require('./routes/public'));

app.use(express.json({ limit: '5mb' }));
// Express 5 leaves req.body undefined when no JSON was sent (e.g. curl -X POST); routes expect an object.
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

// 4) Auth endpoints, then everything else behind requireAuth.
app.use('/api/auth', require('./routes/auth'));
app.get('/api/docs', auth.requireAuth, (req, res) => res.json(apiDocs));
app.use('/api/account', auth.requireAuth, require('./routes/account'));
app.use('/api/users', auth.requireAuth, require('./routes/users'));
app.use('/api/system', auth.requireAuth, require('./routes/system'));
app.use('/api/env-groups', auth.requireAuth, groupRouter);
app.use('/api/monitors', auth.requireAuth, require('./routes/monitors'));
app.use('/api/services/:id/files', auth.requireAuth, require('./routes/files'));
app.use('/api/services/:id/env', auth.requireAuth, envRouter);
app.use('/api/services', auth.requireAuth, require('./routes/services'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

// 5) Dashboard (only the public/ folder is ever served).
app.use(express.static(config.PUBLIC_DIR, { index: 'index.html', dotfiles: 'ignore', maxAge: config.isProd ? '1h' : 0 }));
app.get('/status', (req, res) => res.sendFile(path.join(config.PUBLIC_DIR, 'status.html')));
// The dashboard uses #hash routes, so anything else is a plain 404.
app.use((req, res) => res.status(404).type('text').send('Not found'));

// Errors: thrown HttpErrors keep their status; anything else is a 500 without internals.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  const message = status >= 500 && config.isProd ? 'Internal server error' : err.message || 'Error';
  if (res.headersSent) return res.end();
  res.status(status).json({ error: message });
});

// ---------- WebSocket hub ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (proxy.handleUpgrade(req, socket, head)) return;
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const origin = req.headers.origin;
  if (origin) {
    try {
      const host = new URL(origin).host;
      if (host !== req.headers.host) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    } catch { return socket.destroy(); }
  }
  const ident = auth.identify(req);
  if (!ident) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.user = ident.user;
    ws.subscriptions = new Set();
    ws.isAlive = true;
    wss.emit('connection', ws, req);
  });
});

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

wss.on('connection', ws => {
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const id = msg.serviceId;
    if (id && (!isValidId(id) || !db.data.services[id] || !auth.can(ws.user, 'service.view', id))) return;
    if (msg.type === 'subscribe' && id) {
      ws.subscriptions.add(id);
      send(ws, { type: 'history', serviceId: id, entries: logStore.history(id), state: pm.state(id), diagnostics: diagnostics.list(id) });
    } else if (msg.type === 'unsubscribe' && id) {
      ws.subscriptions.delete(id);
    } else if (msg.type === 'stdin' && id) {
      if (!auth.can(ws.user, 'service.operate', id)) return send(ws, { type: 'error', message: 'Permission denied' });
      try { pm.writeStdin(id, String(msg.text || '').slice(0, 4000)); } catch (e) { send(ws, { type: 'error', serviceId: id, message: e.message }); }
    }
  });
});

// A user deleted or demoted while connected loses access on the next message.
function eachClient(fn) {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const fresh = db.data.users[ws.user.id];
    if (!fresh) { ws.close(4001, 'Account removed'); continue; }
    ws.user = fresh;
    fn(ws);
  }
}

bus.on('log', ({ serviceId, entry }) => eachClient(ws => { if (ws.subscriptions.has(serviceId)) send(ws, { type: 'log', serviceId, entry }); }));
bus.on('status', ({ serviceId, state }) => eachClient(ws => { if (auth.can(ws.user, 'service.view', serviceId)) send(ws, { type: 'status', serviceId, state }); }));
bus.on('diagnostic', ({ serviceId, diagnostic }) => eachClient(ws => { if (auth.can(ws.user, 'service.view', serviceId)) send(ws, { type: 'diagnostic', serviceId, diagnostic }); }));
bus.on('monitor', ({ id, state }) => eachClient(ws => send(ws, { type: 'monitor', id, state })));
bus.on('notification', n => eachClient(ws => { if (!n.serviceId || auth.can(ws.user, 'service.view', n.serviceId)) send(ws, { type: 'notification', notification: n }); }));
bus.on('stats', stats => eachClient(ws => {
  const visible = {};
  for (const [id, s] of Object.entries(stats)) if (auth.can(ws.user, 'service.view', id)) visible[id] = s;
  send(ws, { type: 'stats', stats: visible });
}));

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();

// ---------- start / stop ----------
server.listen(config.PORT, config.HOST, () => {
  const shown = config.HOST === '0.0.0.0' ? 'localhost' : config.HOST;
  console.log('=======================================================');
  console.log(` OmniHost is running → http://${shown}:${config.PORT}`);
  console.log(` Data folder: ${config.DATA_DIR}`);
  if (config.HOST === '127.0.0.1') console.log(' Only reachable from this computer (set HOST=0.0.0.0 to expose it).');
  if (!auth.hasUsers()) console.log(' First visit: create your owner account in the browser.');
  console.log('=======================================================');
  pm.restoreOnBoot();
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[omnihost] ${signal} received — stopping services…`);
  server.close();
  for (const ws of wss.clients) ws.close(1001, 'Server restarting');
  try { await Promise.race([pm.stopAll(), new Promise(r => setTimeout(r, 12000))]); } catch {}
  metrics.persist();
  monitors.persist();
  db.saveNow();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', err => console.error('[omnihost] unhandled rejection:', err));

module.exports = { app, server };

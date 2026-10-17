// Integration tests: boot the real server on a random port with a temp data folder and drive the API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-api-'));
let base, server, cookie = '';

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function call(method, url, body, { auth = true, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { ...headers } };
  if (auth && cookie) opts.headers.cookie = cookie;
  if (auth) opts.headers['x-omnihost'] = '1';
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(base + url, opts);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && setCookie.startsWith('omni_sid=')) cookie = setCookie.split(';')[0];
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text };
}

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, PORT: String(port), HOST: '127.0.0.1', APP_PORT_START: String(port + 1) }, stdio: 'pipe'
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  const ok = await waitFor(async () => { try { return (await fetch(base + '/healthz')).ok; } catch { return false; } });
  assert.ok(ok, 'server did not start:\n' + log);
});

after(async () => {
  if (server) {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1500));
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('static server never exposes data or source files', async () => {
  for (const p of ['/database.json', '/server.js', '/db.js', '/hosted_bots/', '/.omnihost/secret.key', '/lib/config.js', '/package.json']) {
    const r = await call('GET', p, undefined, { auth: false });
    assert.notEqual(r.status, 200, p);
  }
  const index = await call('GET', '/', undefined, { auth: false });
  assert.equal(index.status, 200);
  assert.match(index.text, /<div id="app">/);
});

test('API requires authentication', async () => {
  assert.equal((await call('GET', '/api/services', undefined, { auth: false })).status, 401);
  const status = await call('GET', '/api/auth/status', undefined, { auth: false });
  assert.equal(status.body.setupRequired, true);
});

test('owner setup, login, CSRF guard', async () => {
  const weak = await call('POST', '/api/auth/setup', { username: 'owner', password: 'short' });
  assert.equal(weak.status, 400);
  const setup = await call('POST', '/api/auth/setup', { username: 'owner', password: 'a-long-test-password' });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.user.role, 'owner');
  assert.equal((await call('POST', '/api/auth/setup', { username: 'x', password: 'a-long-test-password' })).status, 409);
  // A cookie-authenticated write without the custom header is rejected.
  const noHeader = await fetch(base + '/api/services', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const saved = cookie;
  cookie = '';
  assert.equal((await call('POST', '/api/auth/login', { username: 'owner', password: 'wrong-password!' })).status, 401);
  const login = await call('POST', '/api/auth/login', { username: 'owner', password: 'a-long-test-password' });
  assert.equal(login.status, 200);
  assert.ok(cookie && cookie !== saved);
});

test('static site from template is served at /apps/<id>/', async () => {
  const created = await call('POST', '/api/services', { name: 'Site', source: 'template', templateId: 'static-site' });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.type, 'static');
  await call('POST', '/api/services/Site/start');
  const page = await fetch(base + '/apps/Site/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Hello from a static site/);
  assert.match(page.headers.get('content-security-policy') || '', /sandbox/);
  // Dotfiles (.env) are never served.
  await call('PATCH', '/api/services/Site/env', { vars: { SECRET: 'nope' } });
  assert.equal((await fetch(base + '/apps/Site/.env')).status, 404);
});

test('file API blocks traversal and zip-slip, keeps binaries intact', async () => {
  const bad = await call('GET', '/api/services/Site/files/content?path=../../database.json');
  assert.equal(bad.status, 400);
  assert.equal((await call('PUT', '/api/services/Site/files/content', { path: '../evil.txt', content: 'x' })).status, 400);
  assert.equal((await call('GET', '/api/services/..%2F..%2Fx/files/tree')).status, 400);

  const zip = new AdmZip();
  zip.addFile('ok.txt', Buffer.from('ok'));
  zip.addFile('evil.txt', Buffer.from('evil'));
  zip.getEntry('evil.txt').entryName = '../../escaped.txt';
  const fd = new FormData();
  fd.append('files', new Blob([zip.toBuffer()]), 'slip.zip');
  const up = await call('POST', '/api/services/Site/files/upload', fd);
  assert.equal(up.status, 400);
  assert.ok(!fs.existsSync(path.join(DATA, 'escaped.txt')));
  assert.ok(!fs.existsSync(path.join(DATA, 'hosted_bots', 'Site', 'ok.txt')), 'a rejected archive must not partially apply');

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2, 3]);
  const fd2 = new FormData();
  fd2.append('files', new Blob([png]), 'logo.png');
  assert.equal((await call('POST', '/api/services/Site/files/upload', fd2)).status, 200);
  assert.equal((await call('PUT', '/api/services/Site/files/content', { path: 'index.html', content: '<h1>changed</h1>' })).status, 200);
  assert.deepEqual(fs.readFileSync(path.join(DATA, 'hosted_bots', 'Site', 'logo.png')), png);
  const meta = await call('GET', '/api/services/Site/files/content?path=logo.png');
  assert.equal(meta.body.binary, true);
});

test('project ZIPs unzip into the main folder and set the start file', async () => {
  await call('POST', '/api/services', { name: 'Zipped', source: 'empty', type: 'discord' });
  const zip = new AdmZip();
  // Two wrapper folders, junk files, and installed deps that must be skipped.
  zip.addFile('my-bot-main/my-bot/package.json', Buffer.from(JSON.stringify({ name: 'x', main: 'src/bot.js' })));
  zip.addFile('my-bot-main/my-bot/src/bot.js', Buffer.from('console.log("hi")'));
  zip.addFile('my-bot-main/my-bot/src/commands/ping.js', Buffer.from('module.exports = {}'));
  zip.addFile('my-bot-main/my-bot/node_modules/dep/index.js', Buffer.from(''));
  zip.addFile('my-bot-main/my-bot/.DS_Store', Buffer.from(''));
  zip.addFile('__MACOSX/my-bot-main/._x', Buffer.from(''));
  const fd = new FormData();
  fd.append('dir', 'some/subfolder');
  fd.append('files', new Blob([zip.toBuffer()]), 'my-bot.zip');
  const up = await call('POST', '/api/services/Zipped/files/upload', fd);
  assert.equal(up.status, 200, up.text);
  assert.equal(up.body.extracted, true);
  assert.deepEqual(up.body.written.sort(), ['package.json', 'src/bot.js', 'src/commands/ping.js']);
  assert.equal(up.body.entry, 'src/bot.js');
  const dir = path.join(DATA, 'hosted_bots', 'Zipped');
  assert.ok(!fs.existsSync(path.join(dir, 'my-bot.zip')));
  assert.ok(!fs.existsSync(path.join(dir, 'node_modules')));
  assert.ok(!fs.existsSync(path.join(dir, 'some')));
  assert.equal((await call('GET', '/api/services/Zipped')).body.entry, 'src/bot.js');
});

test('env values are masked unless revealed, and edits keep other keys', async () => {
  await call('PATCH', '/api/services/Site/env', { vars: { API_TOKEN: 'super-secret-value', PLAIN: 'hello' } });
  const masked = await call('GET', '/api/services/Site/env');
  const tok = masked.body.vars.find(v => v.key === 'API_TOKEN');
  assert.notEqual(tok.value, 'super-secret-value');
  // Sending the masked value back must not overwrite the real secret.
  await call('PATCH', '/api/services/Site/env', { vars: { API_TOKEN: tok.value, PLAIN: 'changed' } });
  const revealed = await call('GET', '/api/services/Site/env?reveal=1');
  assert.equal(revealed.body.vars.find(v => v.key === 'API_TOKEN').value, 'super-secret-value');
  assert.equal(revealed.body.vars.find(v => v.key === 'SECRET').value, 'nope');
  assert.equal(revealed.body.vars.find(v => v.key === 'PLAIN').value, 'changed');
});

test('crashing worker restarts with backoff, then stops in a crash loop', async () => {
  await call('POST', '/api/services', { name: 'Crash', source: 'empty', type: 'worker', entry: 'crash.js' });
  await call('PUT', '/api/services/Crash/files/content', { path: 'crash.js', content: "console.error(\"Error: Cannot find module 'left-pad'\"); process.exit(1);" });
  await call('POST', '/api/services/Crash/start');
  const looped = await waitFor(async () => (await call('GET', '/api/services/Crash')).body.state.status === 'CRASHED', 45000);
  assert.ok(looped, 'expected CRASHED after repeated crashes');
  const svc = (await call('GET', '/api/services/Crash')).body;
  assert.ok(svc.state.restarts >= 3);
  assert.equal(svc.diagnostics.at(-1).action.name, 'left-pad');
  const notes = await call('GET', '/api/system/notifications');
  assert.ok(notes.body.some(n => n.event === 'crashLoop' && n.serviceId === 'Crash'));
});

test('web app runs behind the /apps proxy with an assigned PORT', async () => {
  await call('POST', '/api/services', { name: 'Api', source: 'empty', type: 'web', entry: 'app.js' });
  await call('PUT', '/api/services/Api/files/content', {
    path: 'app.js',
    content: "require('http').createServer((q, s) => { s.setHeader('content-type','application/json'); s.end(JSON.stringify({ url: q.url, prefix: q.headers['x-forwarded-prefix'], cookie: q.headers.cookie || null })); }).listen(process.env.PORT);"
  });
  await call('POST', '/api/services/Api/start');
  const ok = await waitFor(async () => (await fetch(base + '/apps/Api/hello?x=1')).status === 200, 15000);
  assert.ok(ok);
  const res = await fetch(base + '/apps/Api/hello?x=1', { headers: { cookie: `${cookie}; theirs=1` } });
  const json = await res.json();
  assert.equal(json.url, '/hello?x=1');
  assert.equal(json.prefix, '/apps/Api');
  assert.equal(json.cookie, 'theirs=1', 'panel session cookie must not be forwarded to apps');
  await call('POST', '/api/services/Api/stop');
});

test('roles: viewers cannot write, developers only see assigned services', async () => {
  await call('POST', '/api/users', { username: 'viewer1', password: 'viewer-password-1', role: 'viewer' });
  await call('POST', '/api/users', { username: 'dev1', password: 'developer-password', role: 'developer', services: ['Site'] });
  const ownerCookie = cookie;

  cookie = '';
  await call('POST', '/api/auth/login', { username: 'viewer1', password: 'viewer-password-1' });
  assert.equal((await call('GET', '/api/services')).body.length >= 3, true);
  assert.equal((await call('POST', '/api/services/Site/stop')).status, 403);
  assert.equal((await call('GET', '/api/services/Site/env?reveal=1')).status, 403);
  assert.equal((await call('GET', '/api/services/Site/files/content?path=.env')).status, 403);
  assert.equal((await call('GET', '/api/services/Site/files/download?path=.env', undefined, { raw: false })).status, 403);
  assert.equal((await call('GET', '/api/users')).status, 403);

  cookie = '';
  await call('POST', '/api/auth/login', { username: 'dev1', password: 'developer-password' });
  const visible = (await call('GET', '/api/services')).body.map(s => s.id);
  assert.deepEqual(visible, ['Site']);
  assert.equal((await call('GET', '/api/services/Crash')).status, 403);
  assert.equal((await call('POST', '/api/services/Site/exec', { command: 'node -v' })).status, 403);

  cookie = ownerCookie;
});

test('API tokens authenticate without cookies', async () => {
  const t = await call('POST', '/api/account/tokens', { name: 'ci' });
  const res = await fetch(base + '/api/services', { headers: { authorization: `Bearer ${t.body.token}` } });
  assert.equal(res.status, 200);
  const bad = await fetch(base + '/api/services', { headers: { authorization: 'Bearer omni_wrong' } });
  assert.equal(bad.status, 401);
  // A bodyless POST (typical curl usage) must work, not 500.
  const backup = await fetch(base + '/api/services/Site/backups', { method: 'POST', headers: { authorization: `Bearer ${t.body.token}` } });
  assert.equal(backup.status, 200);
});

test('GitHub webhook rejects bad signatures', async () => {
  const r = await fetch(base + '/api/hooks/github/Site', { method: 'POST', headers: { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' }, body: '{}' });
  assert.equal(r.status, 401);
});

test('backups snapshot and restore files', async () => {
  const b = await call('POST', '/api/services/Site/backups', {});
  assert.equal(b.status, 200);
  await call('PUT', '/api/services/Site/files/content', { path: 'index.html', content: 'broken' });
  const restore = await call('POST', `/api/services/Site/backups/${b.body.id}/restore`);
  assert.equal(restore.status, 200, restore.text);
  assert.equal(fs.readFileSync(path.join(DATA, 'hosted_bots', 'Site', 'index.html'), 'utf8'), '<h1>changed</h1>');
});

test('built-in SQLite database', async () => {
  await call('POST', '/api/services/Site/sqlite/enable');
  const create = await call('POST', '/api/services/Site/sqlite/query', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)', readOnly: false });
  assert.equal(create.status, 200, create.text);
  await call('POST', '/api/services/Site/sqlite/query', { sql: "INSERT INTO t (name) VALUES ('a'), ('b')", readOnly: false });
  const sel = await call('POST', '/api/services/Site/sqlite/query', { sql: 'SELECT name FROM t ORDER BY id' });
  assert.deepEqual(sel.body.rows, [['a'], ['b']]);
  const ro = await call('POST', '/api/services/Site/sqlite/query', { sql: 'DELETE FROM t', readOnly: true });
  assert.equal(ro.status, 400);
});

test('build command runs on demand and before start', async () => {
  await call('POST', '/api/services', { name: 'Built', source: 'empty', type: 'static' });
  await call('PUT', '/api/services/Built/files/content', { path: 'build.js', content: "require('fs').mkdirSync('dist',{recursive:true}); require('fs').writeFileSync('dist/index.html','<h1>built</h1>'); console.log('built ok');" });
  await call('PATCH', '/api/services/Built', { buildCommand: 'node build.js', buildOnStart: true, staticRoot: 'dist' });
  const r = await call('POST', '/api/services/Built/build');
  assert.equal(r.body.ok, true, r.text);
  fs.rmSync(path.join(DATA, 'hosted_bots', 'Built', 'dist'), { recursive: true });
  await call('POST', '/api/services/Built/start');
  const online = await waitFor(async () => (await call('GET', '/api/services/Built')).body.state.status === 'ONLINE', 15000);
  assert.ok(online);
  assert.match(await (await fetch(base + '/apps/Built/')).text(), /built/);
});

test('duplicate and export/import a single service keep its settings', async () => {
  const dup = await call('POST', '/api/services/Built/duplicate', { name: 'Built Copy' });
  assert.equal(dup.status, 201, dup.text);
  assert.equal(dup.body.buildCommand, 'node build.js');
  assert.ok(fs.existsSync(path.join(DATA, 'hosted_bots', dup.body.id, 'build.js')));

  const res = await call('GET', '/api/services/Built/export', undefined, { raw: true });
  assert.equal(res.status, 200);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  assert.ok(zip.getEntry('omnihost-service.json'));
  assert.ok(!zip.getEntries().some(e => e.entryName.startsWith('.env')), 'exports must not contain secrets');
  await call('POST', '/api/services', { name: 'Imported', source: 'empty', type: 'discord' });
  const fd = new FormData();
  fd.append('files', new Blob([zip.toBuffer()]), 'Built.zip');
  const up = await call('POST', '/api/services/Imported/files/upload', fd);
  assert.equal(up.body.importedSettings, true, up.text);
  const imported = (await call('GET', '/api/services/Imported')).body;
  assert.equal(imported.type, 'static');
  assert.equal(imported.staticRoot, 'dist');
  assert.ok(!fs.existsSync(path.join(DATA, 'hosted_bots', 'Imported', 'omnihost-service.json')));
});

test('uptime monitors detect up and down targets', async () => {
  const port = Number(new URL(base).port);
  const up = await call('POST', '/api/monitors', { name: 'Panel', type: 'keyword', url: `${base}/healthz`, keyword: '"ok":true', intervalSec: 30 });
  assert.equal(up.status, 201, up.text);
  const checked = await call('POST', `/api/monitors/${up.body.id}/check`);
  assert.equal(checked.body.status, 'up');
  const down = await call('POST', '/api/monitors', { name: 'Closed port', type: 'tcp', host: '127.0.0.1', port: port === 1 ? 2 : 1, failuresBeforeAlert: 1, timeoutSec: 2 });
  const d = await call('POST', `/api/monitors/${down.body.id}/check`);
  assert.equal(d.body.status, 'down');
  assert.ok((await call('GET', '/api/system/notifications')).body.some(n => n.event === 'monitor' && n.title.includes('Closed port')));
  assert.equal((await call('POST', '/api/monitors', { name: 'bad', type: 'http', url: 'file:///etc/passwd' })).status, 400);
});

test('panel export/import moves services to another install', async () => {
  const res = await call('GET', '/api/system/export', undefined, { raw: true });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const manifest = JSON.parse(zip.getEntry('omnihost-export.json').getData().toString());
  assert.ok(manifest.services.Site);
  assert.equal(manifest.users, undefined, 'accounts must never be exported');
  assert.ok(zip.getEntry('databases/Site.sqlite'));
  // Importing into the same install skips everything that already exists.
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'export.zip');
  const r = await call('POST', '/api/system/import', fd);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.imported.length, 0);
  assert.ok(r.body.skipped.includes('Site'));
  // A crafted export with a path escape is rejected before anything is written.
  const evil = new AdmZip();
  evil.addFile('omnihost-export.json', Buffer.from(JSON.stringify({ format: 'omnihost-panel-export', services: { Evil: { id: 'Evil', name: 'Evil' } } })));
  evil.addFile('services/Evil/ok.txt', Buffer.from('x'));
  evil.addFile('services/Evil/x.txt', Buffer.from('x'));
  evil.getEntry('services/Evil/x.txt').entryName = 'services/Evil/../../../escaped.txt';
  const fd2 = new FormData();
  fd2.append('file', new Blob([evil.toBuffer()]), 'evil.zip');
  assert.equal((await call('POST', '/api/system/import', fd2)).status, 400);
  assert.ok(!fs.existsSync(path.join(DATA, 'escaped.txt')));
});

test('WebSocket requires a session', async () => {
  const WebSocket = require('ws');
  const anon = await new Promise(resolve => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    ws.on('open', () => resolve('open'));
    ws.on('error', () => resolve('rejected'));
  });
  assert.equal(anon, 'rejected');
  const authed = await new Promise(resolve => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('rejected'));
  });
  assert.equal(authed, 'open');
});

// Unit tests for the security-critical helpers. Run with `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Point the panel at a throwaway data folder before anything loads config.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-unit-'));

const { resolveInside, isValidId, slugify } = require('../lib/safePath');
const envFile = require('../lib/envFile');
const totp = require('../lib/totp');
const cron = require('../lib/cron');
const exec = require('../lib/exec');
const diagnostics = require('../lib/diagnostics');
const auth = require('../lib/auth');

test('resolveInside keeps paths inside the base folder', () => {
  const base = path.join(os.tmpdir(), 'svc');
  assert.equal(resolveInside(base, 'src/index.js'), path.join(base, 'src', 'index.js'));
  assert.equal(resolveInside(base, '/leading/slash.js'), path.join(base, 'leading', 'slash.js'));
  for (const bad of ['../x', '..\\x', 'a/../../x', 'C:/Windows/win.ini', '\0']) {
    assert.throws(() => resolveInside(base, bad), /escapes|Invalid|required/, bad);
  }
  assert.throws(() => resolveInside(base, ''), /required/);
});

test('service ids are restricted', () => {
  assert.ok(isValidId('My-Bot_2'));
  for (const bad of ['', '..', 'a/b', 'a b', 'x'.repeat(41), '<script>']) assert.ok(!isValidId(bad), bad);
  assert.equal(slugify('My Cool Bot!'), 'My-Cool-Bot');
});

test('.env updates preserve comments, order and unknown keys', () => {
  const src = '# header\nA=1\n\n# keep me\nB="two words"\nexport C=3 # trailing\n';
  const vars = envFile.parse(src);
  assert.deepEqual(vars, { A: '1', B: 'two words', C: '3' });
  const out = envFile.update(src, { B: 'new value', A: null, D: 'x=y' });
  assert.match(out, /# header/);
  assert.match(out, /# keep me/);
  assert.doesNotMatch(out, /^A=/m);
  assert.match(out, /^B="new value"$/m);
  assert.match(out, /^export C=3 # trailing$/m);
  assert.match(out, /^D="x=y"$/m);
  assert.deepEqual(envFile.parse(out), { B: 'new value', C: '3', D: 'x=y' });
  assert.equal(envFile.mask('MTUabcdefghijkl'), 'MTU••••••••••kl');
});

test('TOTP codes verify within the drift window only', () => {
  const secret = totp.generateSecret();
  const now = Date.now();
  assert.ok(totp.verify(secret, totp.totp(secret, now), now));
  assert.ok(totp.verify(secret, totp.totp(secret, now - 30000), now));
  assert.ok(!totp.verify(secret, totp.totp(secret, now - 120000), now));
  assert.ok(!totp.verify(secret, 'abcdef', now));
  // RFC 6238 test vector (SHA1, T=59s)
  const rfcSecret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.totp(rfcSecret, 59000), '287082');
});

test('passwords hash with scrypt and verify', () => {
  const hash = auth.hashPassword('correct horse battery');
  assert.ok(hash.startsWith('scrypt$'));
  assert.ok(auth.verifyPassword('correct horse battery', hash));
  assert.ok(!auth.verifyPassword('wrong', hash));
});

test('cron parser matches and finds next runs', () => {
  const p = cron.parse('*/15 9-17 * * 1-5');
  assert.ok(cron.matches(p, new Date(2026, 9, 16, 9, 30)));   // Friday 09:30
  assert.ok(!cron.matches(p, new Date(2026, 9, 17, 9, 30)));  // Saturday
  assert.ok(!cron.matches(p, new Date(2026, 9, 16, 9, 31)));
  const next = cron.nextRun('@daily', new Date(2026, 9, 16, 12, 0));
  assert.equal(next.getHours(), 0);
  assert.equal(next.getDate(), 17);
  assert.ok(cron.validate('61 * * * *'));
  assert.ok(cron.validate('* * *'));
  assert.equal(cron.validate('0 4 * * *'), null);
});

test('splitArgs never interprets shell syntax', () => {
  assert.deepEqual(exec.splitArgs('node "my script.js" --flag=\'a b\''), ['node', 'my script.js', '--flag=a b']);
  assert.deepEqual(exec.splitArgs('echo hi && rm -rf /'), ['echo', 'hi', '&&', 'rm', '-rf', '/']);
});

test('diagnostics recognise common failures', () => {
  const pkg = diagnostics.scan('unit-a', "Error: Cannot find module '@discordjs/voice/dist/x'");
  assert.equal(pkg.action.type, 'install-package');
  assert.equal(pkg.action.name, '@discordjs/voice');
  const local = diagnostics.scan('unit-b', "Error: Cannot find module './commands/ping'");
  assert.equal(local.action, undefined);
  assert.equal(diagnostics.scan('unit-c', 'Error [TokenInvalid]: An invalid token was provided.').id, 'token-invalid');
  assert.equal(diagnostics.scan('unit-d', 'Error: Used disallowed intents').id, 'disallowed-intents');
  assert.equal(diagnostics.scan('unit-e', "ModuleNotFoundError: No module named 'discord'").action.name, 'discord.py');
  assert.equal(diagnostics.scan('unit-f', 'just a normal log line'), null);
});

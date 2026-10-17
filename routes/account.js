// The signed-in user's own account: password, 2FA, sessions, API tokens.
const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../db');
const auth = require('../lib/auth');
const totp = require('../lib/totp');
const audit = require('../lib/audit');
const { httpError } = require('../lib/errors');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ user: auth.publicUser(req.user), recoveryCodesLeft: (req.user.totp.recoveryCodes || []).length });
});

router.post('/password', (req, res) => {
  auth.rateLimit(`pw:${req.user.id}`, 10, 15 * 60000);
  const { currentPassword, newPassword } = req.body || {};
  if (!auth.verifyPassword(currentPassword || '', req.user.passwordHash)) throw httpError(400, 'Current password is wrong');
  auth.validatePassword(newPassword);
  req.user.passwordHash = auth.hashPassword(newPassword);
  // Sign out every other device.
  auth.destroySessionsFor(req.user.id, req.auth.sessionKey);
  db.save();
  audit.record(req, 'account.password_changed', req.user.username);
  res.json({ ok: true });
});

// ----- two-factor -----
router.post('/2fa/setup', async (req, res) => {
  if (req.user.totp.enabled) throw httpError(409, 'Two-factor login is already on');
  const secret = totp.generateSecret();
  req.user.totp.pendingSecret = secret;
  db.save();
  const url = totp.otpauthUrl(secret, req.user.username);
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 200 });
  res.json({ secret, url, qrSvg });
});

router.post('/2fa/enable', (req, res) => {
  const secret = req.user.totp.pendingSecret;
  if (!secret) throw httpError(400, 'Start two-factor setup first');
  if (!totp.verify(secret, req.body.code)) throw httpError(400, 'That code is not valid — check the time on your phone and try again');
  const codes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex'));
  req.user.totp = { enabled: true, secret, pendingSecret: '', recoveryCodes: codes.map(c => auth.sha256(c)) };
  db.save();
  audit.record(req, 'account.2fa_enabled', req.user.username);
  res.json({ ok: true, recoveryCodes: codes.map(c => `${c.slice(0, 4)}-${c.slice(4)}`) });
});

router.post('/2fa/disable', (req, res) => {
  if (!auth.verifyPassword(req.body.password || '', req.user.passwordHash)) throw httpError(400, 'Password is wrong');
  req.user.totp = { enabled: false, secret: '', pendingSecret: '', recoveryCodes: [] };
  db.save();
  audit.record(req, 'account.2fa_disabled', req.user.username);
  res.json({ ok: true });
});

// ----- sessions -----
router.get('/sessions', (req, res) => {
  const list = Object.entries(db.data.sessions)
    .filter(([, s]) => s.userId === req.user.id)
    .map(([key, s]) => ({ id: s.id, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, userAgent: s.userAgent, current: key === req.auth.sessionKey }));
  res.json(list);
});

router.delete('/sessions/:sid', (req, res) => {
  const entry = Object.entries(db.data.sessions).find(([, s]) => s.id === req.params.sid && s.userId === req.user.id);
  if (!entry) throw httpError(404, 'Session not found');
  delete db.data.sessions[entry[0]];
  db.save();
  audit.record(req, 'account.session_revoked', req.user.username);
  res.json({ ok: true });
});

router.post('/sessions/revoke-others', (req, res) => {
  auth.destroySessionsFor(req.user.id, req.auth.sessionKey);
  audit.record(req, 'account.sessions_revoked', req.user.username);
  res.json({ ok: true });
});

// ----- API tokens -----
router.get('/tokens', (req, res) => {
  res.json(Object.values(db.data.apiTokens).filter(t => t.userId === req.user.id)
    .map(({ id, name, prefix, createdAt, lastUsedAt }) => ({ id, name, prefix, createdAt, lastUsedAt })));
});

router.post('/tokens', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60) || 'API token';
  const token = 'omni_' + auth.randomToken(30);
  const rec = { id: crypto.randomBytes(6).toString('hex'), userId: req.user.id, name, prefix: token.slice(0, 10), createdAt: new Date().toISOString(), lastUsedAt: null };
  db.data.apiTokens[auth.sha256(token)] = rec;
  db.save();
  audit.record(req, 'account.token_created', name);
  res.json({ ...rec, token });
});

router.delete('/tokens/:tid', (req, res) => {
  const entry = Object.entries(db.data.apiTokens).find(([, t]) => t.id === req.params.tid && t.userId === req.user.id);
  if (!entry) throw httpError(404, 'Token not found');
  delete db.data.apiTokens[entry[0]];
  db.save();
  audit.record(req, 'account.token_deleted', entry[1].name);
  res.json({ ok: true });
});

module.exports = router;

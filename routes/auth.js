// Sign-in, first-run setup, invites and 2FA login.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../lib/auth');
const totp = require('../lib/totp');
const audit = require('../lib/audit');
const { httpError } = require('../lib/errors');

const router = express.Router();
const pendingMfa = new Map(); // token -> { userId, expires }

function finishLogin(req, res, user) {
  const token = auth.createSession(user, req);
  auth.setSessionCookie(req, res, token);
  audit.record({ user, ip: req.ip }, 'auth.login', user.username);
  res.json({ ok: true, user: auth.publicUser(user) });
}

router.get('/status', (req, res) => {
  const ident = auth.identify(req);
  res.json({
    setupRequired: !auth.hasUsers(),
    user: ident ? auth.publicUser(ident.user) : null
  });
});

// First visit only: create the owner account.
router.post('/setup', (req, res) => {
  if (auth.hasUsers()) throw httpError(409, 'Setup is already complete');
  auth.rateLimit(`setup:${req.ip}`, 10, 15 * 60000);
  const user = auth.createUser({ username: req.body.username, password: req.body.password, role: 'owner' });
  audit.record({ user, ip: req.ip }, 'auth.setup', user.username);
  finishLogin(req, res, user);
});

router.post('/login', (req, res) => {
  auth.rateLimit(`login:${req.ip}`, 10, 15 * 60000);
  const { username, password } = req.body || {};
  const user = auth.findUserByName(username);
  // Always run a hash comparison so response time doesn't reveal which usernames exist.
  const ok = user ? auth.verifyPassword(password || '', user.passwordHash) : (auth.verifyPassword('x', auth.hashPassword('y')), false);
  if (!ok) {
    audit.record({ user: username ? String(username).slice(0, 40) : 'unknown', ip: req.ip }, 'auth.login_failed', String(username || '').slice(0, 40));
    throw httpError(401, 'Wrong username or password');
  }
  if (user.totp && user.totp.enabled) {
    const mfaToken = auth.randomToken(24);
    pendingMfa.set(mfaToken, { userId: user.id, expires: Date.now() + 5 * 60000, attempts: 0 });
    return res.json({ mfaRequired: true, mfaToken });
  }
  finishLogin(req, res, user);
});

router.post('/login/mfa', (req, res) => {
  auth.rateLimit(`mfa:${req.ip}`, 20, 15 * 60000);
  const { mfaToken, code } = req.body || {};
  const pending = pendingMfa.get(mfaToken);
  if (!pending || pending.expires < Date.now()) { pendingMfa.delete(mfaToken); throw httpError(401, 'Sign-in expired — enter your password again'); }
  const user = db.data.users[pending.userId];
  if (!user) throw httpError(401, 'Account no longer exists');
  const clean = String(code || '').trim();
  let ok = totp.verify(user.totp.secret, clean);
  if (!ok && /^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(clean)) {
    // Recovery codes are single-use.
    const hash = auth.sha256(clean.replace('-', '').toLowerCase());
    const idx = user.totp.recoveryCodes.indexOf(hash);
    if (idx >= 0) { user.totp.recoveryCodes.splice(idx, 1); db.save(); ok = true; audit.record({ user, ip: req.ip }, 'auth.recovery_code_used', user.username); }
  }
  if (!ok) {
    if (++pending.attempts >= 5) pendingMfa.delete(mfaToken);
    throw httpError(401, 'That code is not valid');
  }
  pendingMfa.delete(mfaToken);
  finishLogin(req, res, user);
});

router.post('/logout', (req, res) => {
  const ident = auth.identify(req);
  if (ident && ident.sessionKey) {
    delete db.data.sessions[ident.sessionKey];
    db.save();
    audit.record({ user: ident.user, ip: req.ip }, 'auth.logout', ident.user.username);
  }
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// Invites: an admin creates a one-time link; the invitee picks a username + password.
router.get('/invite/:code', (req, res) => {
  const inv = db.data.invites[auth.sha256(req.params.code)];
  if (!inv || inv.expiresAt < Date.now() || inv.usedAt) throw httpError(404, 'This invite link is invalid or has expired');
  res.json({ role: inv.role, invitedBy: inv.createdBy, expiresAt: inv.expiresAt });
});

router.post('/invite/:code', (req, res) => {
  auth.rateLimit(`invite:${req.ip}`, 10, 15 * 60000);
  const key = auth.sha256(req.params.code);
  const inv = db.data.invites[key];
  if (!inv || inv.expiresAt < Date.now() || inv.usedAt) throw httpError(404, 'This invite link is invalid or has expired');
  const user = auth.createUser({ username: req.body.username, password: req.body.password, role: inv.role, services: inv.services || [] });
  inv.usedAt = new Date().toISOString();
  inv.usedBy = user.username;
  db.save();
  audit.record({ user, ip: req.ip }, 'auth.invite_accepted', user.username, `role ${inv.role}`);
  finishLogin(req, res, user);
});

setInterval(() => {
  for (const [k, v] of pendingMfa) if (v.expires < Date.now()) pendingMfa.delete(k);
}, 60000).unref();

module.exports = router;
module.exports._newInviteCode = () => crypto.randomBytes(18).toString('base64url');

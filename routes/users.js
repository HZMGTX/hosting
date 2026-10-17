// User management (admins) and invites.
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const { httpError } = require('../lib/errors');
const { _newInviteCode } = require('./auth');

const router = express.Router();
router.use(auth.requirePerm('admin'));

function cleanServices(list) {
  return Array.isArray(list) ? list.filter(id => typeof id === 'string' && db.data.services[id]) : [];
}

// Admins may manage everyone except owners; only an owner can create/promote owners.
function assertCanManage(req, target, newRole) {
  if (target && target.role === 'owner' && req.user.role !== 'owner') throw httpError(403, 'Only an owner can change another owner');
  if (newRole === 'owner' && req.user.role !== 'owner') throw httpError(403, 'Only an owner can grant the owner role');
  if (newRole && !auth.ROLES.includes(newRole)) throw httpError(400, 'Invalid role');
}

router.get('/', (req, res) => {
  res.json(Object.values(db.data.users).map(auth.publicUser));
});

router.post('/', (req, res) => {
  const role = req.body.role || 'viewer';
  assertCanManage(req, null, role);
  const user = auth.createUser({ username: req.body.username, password: req.body.password, role, services: cleanServices(req.body.services) });
  audit.record(req, 'user.created', user.username, `role ${role}`);
  res.json(auth.publicUser(user));
});

router.patch('/:uid', (req, res) => {
  const user = db.data.users[req.params.uid];
  if (!user) throw httpError(404, 'User not found');
  const role = req.body.role;
  assertCanManage(req, user, role);
  if (role && user.role === 'owner' && role !== 'owner' && Object.values(db.data.users).filter(u => u.role === 'owner').length === 1) {
    throw httpError(400, 'There must always be at least one owner');
  }
  if (role) user.role = role;
  if (req.body.services !== undefined) user.services = cleanServices(req.body.services);
  if (req.body.password) {
    auth.validatePassword(req.body.password);
    user.passwordHash = auth.hashPassword(req.body.password);
    auth.destroySessionsFor(user.id);
  }
  if (req.body.resetTwoFactor) user.totp = { enabled: false, secret: '', pendingSecret: '', recoveryCodes: [] };
  db.save();
  audit.record(req, 'user.updated', user.username, JSON.stringify({ role, services: req.body.services, passwordReset: !!req.body.password, twoFactorReset: !!req.body.resetTwoFactor }));
  res.json(auth.publicUser(user));
});

router.delete('/:uid', (req, res) => {
  const user = db.data.users[req.params.uid];
  if (!user) throw httpError(404, 'User not found');
  assertCanManage(req, user);
  if (user.id === req.user.id) throw httpError(400, 'You cannot delete your own account');
  if (user.role === 'owner' && Object.values(db.data.users).filter(u => u.role === 'owner').length === 1) throw httpError(400, 'Cannot delete the last owner');
  delete db.data.users[user.id];
  auth.destroySessionsFor(user.id);
  for (const [k, t] of Object.entries(db.data.apiTokens)) if (t.userId === user.id) delete db.data.apiTokens[k];
  db.save();
  audit.record(req, 'user.deleted', user.username);
  res.json({ ok: true });
});

// ----- invites -----
router.get('/invites', (req, res) => {
  res.json(Object.values(db.data.invites).filter(i => !i.usedAt && i.expiresAt > Date.now())
    .map(({ id, role, services, createdBy, createdAt, expiresAt }) => ({ id, role, services, createdBy, createdAt, expiresAt })));
});

router.post('/invites', (req, res) => {
  const role = req.body.role || 'developer';
  assertCanManage(req, null, role);
  const code = _newInviteCode();
  const days = Math.min(30, Math.max(1, parseInt(req.body.days, 10) || 7));
  const inv = {
    id: auth.randomToken(6), role, services: cleanServices(req.body.services),
    createdBy: req.user.username, createdAt: new Date().toISOString(), expiresAt: Date.now() + days * 86400000
  };
  db.data.invites[auth.sha256(code)] = inv;
  db.save();
  audit.record(req, 'user.invited', role);
  res.json({ ...inv, code });
});

router.delete('/invites/:iid', (req, res) => {
  const entry = Object.entries(db.data.invites).find(([, i]) => i.id === req.params.iid);
  if (!entry) throw httpError(404, 'Invite not found');
  delete db.data.invites[entry[0]];
  db.save();
  res.json({ ok: true });
});

module.exports = router;

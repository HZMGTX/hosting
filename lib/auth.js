// Accounts, sessions, API tokens, roles and the auth middleware.
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('./errors');

const COOKIE = 'omni_sid';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const ROLE_RANK = { viewer: 1, developer: 2, admin: 3, owner: 4 };
const ROLES = Object.keys(ROLE_RANK);

// ---------- hashing ----------
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, n, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, { N: parseInt(n, 10), r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw httpError(400, 'Password must be at least 10 characters');
  if (pw.length > 200) throw httpError(400, 'Password is too long');
}

function validateUsername(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(name)) {
    throw httpError(400, 'Username must be 3-32 letters, numbers, ".", "-" or "_"');
  }
}

// ---------- rate limiting ----------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (b.count > max) throw httpError(429, `Too many attempts. Try again in ${Math.ceil((b.resetAt - now) / 60000)} min.`);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
}, 60000).unref();

// ---------- users ----------
function findUserByName(username) {
  const lower = String(username || '').toLowerCase();
  return Object.values(db.data.users).find(u => u.username.toLowerCase() === lower) || null;
}

function hasUsers() {
  return Object.keys(db.data.users).length > 0;
}

function createUser({ username, password, role = 'viewer', services = [] }) {
  validateUsername(username);
  validatePassword(password);
  if (!ROLES.includes(role)) throw httpError(400, 'Invalid role');
  if (findUserByName(username)) throw httpError(409, 'That username is taken');
  const id = 'u_' + crypto.randomBytes(8).toString('hex');
  db.data.users[id] = {
    id, username, role, services,
    passwordHash: hashPassword(password),
    totp: { enabled: false, secret: '', pendingSecret: '', recoveryCodes: [] },
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  };
  db.save();
  return db.data.users[id];
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, role: u.role, services: u.services || [],
    twoFactor: !!(u.totp && u.totp.enabled), createdAt: u.createdAt, lastLoginAt: u.lastLoginAt
  };
}

// ---------- sessions ----------
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function createSession(user, req) {
  const token = randomToken();
  db.data.sessions[sha256(token)] = {
    id: randomToken(9),
    userId: user.id,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    ip: req.ip,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 200)
  };
  user.lastLoginAt = new Date().toISOString();
  db.save();
  return token;
}

function setSessionCookie(req, res, token) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

// Resolve the caller from a session cookie or a "Bearer omni_..." API token.
function identify(req) {
  const authz = String(req.headers.authorization || '');
  if (authz.startsWith('Bearer ')) {
    const rec = db.data.apiTokens[sha256(authz.slice(7).trim())];
    if (!rec) return null;
    const user = db.data.users[rec.userId];
    if (!user) return null;
    rec.lastUsedAt = new Date().toISOString();
    db.save();
    return { user, via: 'token', tokenId: rec.id };
  }
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const key = sha256(token);
  const session = db.data.sessions[key];
  if (!session) return null;
  if (session.expiresAt < Date.now()) { delete db.data.sessions[key]; db.save(); return null; }
  const user = db.data.users[session.userId];
  if (!user) return null;
  // Only touch lastSeen once a minute to avoid constant writes.
  if (Date.now() - Date.parse(session.lastSeenAt) > 60000) { session.lastSeenAt = new Date().toISOString(); db.save(); }
  return { user, via: 'cookie', sessionKey: key, session };
}

function destroySessionsFor(userId, exceptKey) {
  for (const [k, s] of Object.entries(db.data.sessions)) {
    if (s.userId === userId && k !== exceptKey) delete db.data.sessions[k];
  }
  db.save();
}

setInterval(() => {
  let changed = false;
  for (const [k, s] of Object.entries(db.data.sessions)) {
    if (s.expiresAt < Date.now()) { delete db.data.sessions[k]; changed = true; }
  }
  if (changed) db.save();
}, 3600 * 1000).unref();

// ---------- permissions ----------
function rank(user) {
  return ROLE_RANK[user && user.role] || 0;
}

function canAccessService(user, serviceId) {
  if (!user) return false;
  if (rank(user) >= ROLE_RANK.admin || user.role === 'viewer') return true;
  return (user.services || []).includes(serviceId);
}

function can(user, perm, serviceId) {
  if (!user) return false;
  switch (perm) {
    case 'service.view': return canAccessService(user, serviceId);
    case 'service.operate':
    case 'service.edit': return user.role !== 'viewer' && canAccessService(user, serviceId);
    case 'service.delete': return rank(user) >= ROLE_RANK.admin || (user.role === 'developer' && canAccessService(user, serviceId));
    case 'service.create': return rank(user) >= ROLE_RANK.developer;
    case 'service.exec': return rank(user) >= ROLE_RANK.admin;
    case 'admin': return rank(user) >= ROLE_RANK.admin;
    case 'owner': return user.role === 'owner';
    default: return false;
  }
}

// ---------- middleware ----------
function requireAuth(req, res, next) {
  const ident = identify(req);
  if (!ident) return next(httpError(401, 'Please sign in'));
  // CSRF guard: cookie-authenticated writes must carry the custom header that only our own JS sets.
  if (ident.via === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-omnihost'] !== '1') {
    return next(httpError(403, 'Missing request header'));
  }
  req.user = ident.user;
  req.auth = ident;
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!can(req.user, perm, req.params && req.params.id)) return next(httpError(403, 'You do not have permission to do that'));
    next();
  };
}

module.exports = {
  COOKIE, ROLES, ROLE_RANK,
  sha256, randomToken, hashPassword, verifyPassword, validatePassword, validateUsername,
  rateLimit, findUserByName, hasUsers, createUser, publicUser,
  parseCookies, createSession, setSessionCookie, clearSessionCookie, identify, destroySessionsFor,
  can, canAccessService, rank, requireAuth, requirePerm
};

// Audit trail: who did what, when, from where.
const crypto = require('crypto');
const db = require('../db');

const MAX_ENTRIES = 5000;

function record(reqOrUser, action, target = '', details = '') {
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    at: new Date().toISOString(),
    user: actorName(reqOrUser),
    action,
    target: String(target || ''),
    details: typeof details === 'string' ? details.slice(0, 500) : JSON.stringify(details).slice(0, 500),
    ip: reqOrUser && reqOrUser.ip ? reqOrUser.ip : ''
  };
  db.data.audit.push(entry);
  if (db.data.audit.length > MAX_ENTRIES) db.data.audit.splice(0, db.data.audit.length - MAX_ENTRIES);
  db.save();
  return entry;
}

// Display name for whoever triggered something: a request, a user record, or a plain string.
function actorName(by) {
  if (!by) return 'system';
  if (by.user && by.user.username) return by.user.username;
  if (by.username) return by.username;
  return typeof by === 'string' ? by : 'system';
}

function query({ user, action, target, q, limit = 200, before } = {}) {
  let list = db.data.audit;
  if (user) list = list.filter(e => e.user === user);
  if (action) list = list.filter(e => e.action.startsWith(action));
  if (target) list = list.filter(e => e.target === target);
  if (q) {
    const needle = q.toLowerCase();
    list = list.filter(e => `${e.user} ${e.action} ${e.target} ${e.details}`.toLowerCase().includes(needle));
  }
  if (before) list = list.filter(e => e.at < before);
  return list.slice(-Math.min(1000, limit)).reverse();
}

module.exports = { record, query, actorName };

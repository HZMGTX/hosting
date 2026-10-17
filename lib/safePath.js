// Path & identifier validation. Every user-supplied service id or file path goes through here.
const path = require('path');
const { httpError } = require('./errors');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function assertId(id, what = 'id') {
  if (!isValidId(id)) throw httpError(400, `Invalid ${what}: use 1-40 letters, numbers, "-" or "_"`);
  return id;
}

// Turn any display name into a valid id ("My Cool Bot!" -> "My-Cool-Bot").
function slugify(name) {
  const slug = String(name || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'service-' + Date.now().toString(36);
}

// Normalise a relative path coming from the browser: forward slashes, no leading slash.
function cleanRel(rel) {
  if (typeof rel !== 'string') throw httpError(400, 'Invalid path');
  if (rel.includes('\0')) throw httpError(400, 'Invalid path');
  return rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

// Resolve `rel` inside `base`, refusing anything that would escape it (../, absolute paths, drive letters).
function resolveInside(base, rel, { allowBase = false } = {}) {
  const cleaned = cleanRel(rel);
  const baseResolved = path.resolve(base);
  const full = path.resolve(baseResolved, cleaned);
  if (full === baseResolved) {
    if (allowBase) return full;
    throw httpError(400, 'Path is required');
  }
  if (!full.startsWith(baseResolved + path.sep)) throw httpError(400, 'Path escapes the service folder');
  return full;
}

function toRel(base, full) {
  return path.relative(base, full).split(path.sep).join('/');
}

module.exports = { isValidId, assertId, slugify, cleanRel, resolveInside, toRel, ID_RE };

// Shared route helpers.
const db = require('../db');
const auth = require('../lib/auth');
const { httpError } = require('../lib/errors');
const { isValidId } = require('../lib/safePath');

// Load req.svc for /:id routes and enforce a permission on it.
function service(perm = 'service.view') {
  return (req, res, next) => {
    const id = req.params.id;
    if (!isValidId(id)) return next(httpError(400, 'Invalid service id'));
    const svc = db.data.services[id];
    if (!svc) return next(httpError(404, 'Service not found'));
    if (!auth.can(req.user, perm, id)) return next(httpError(403, 'You do not have permission to do that'));
    req.svc = svc;
    next();
  };
}

function bool(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
}

function str(v, max = 500) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

module.exports = { service, bool, str, httpError };

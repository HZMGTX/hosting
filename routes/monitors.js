// External uptime monitors (admins create, everyone can view).
const express = require('express');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const monitors = require('../lib/monitors');

const router = express.Router();

router.get('/', (req, res) => res.json(monitors.list()));

router.post('/', auth.requirePerm('admin'), (req, res) => {
  const m = monitors.create(req.body, req.user.username);
  audit.record(req, 'monitor.created', m.id, m.name);
  res.status(201).json(m);
});

router.patch('/:mid', auth.requirePerm('admin'), (req, res) => {
  const m = monitors.update(req.params.mid, req.body);
  audit.record(req, 'monitor.updated', m.id, m.name);
  res.json(m);
});

router.post('/:mid/check', async (req, res) => {
  const m = await monitors.check(req.params.mid);
  if (!m) return res.status(404).json({ error: 'Monitor not found' });
  res.json(m);
});

router.delete('/:mid', auth.requirePerm('admin'), (req, res) => {
  monitors.remove(req.params.mid);
  audit.record(req, 'monitor.deleted', req.params.mid);
  res.json({ ok: true });
});

module.exports = router;

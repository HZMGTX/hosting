// Unauthenticated endpoints: health, public status page data, GitHub webhooks.
const express = require('express');
const db = require('../db');
const pm = require('../lib/processManager');
const metrics = require('../lib/metrics');
const gitLib = require('../lib/git');
const pipeline = require('../lib/pipeline');
const logStore = require('../lib/logStore');
const auth = require('../lib/auth');
const { isValidId } = require('../lib/safePath');

const router = express.Router();

router.get('/public/status', (req, res) => {
  const sp = db.data.settings.statusPage;
  if (!sp.enabled) return res.status(404).json({ error: 'The status page is turned off' });
  const list = Object.values(db.data.services).filter(s => s.statusPage).map(s => {
    const st = pm.state(s.id).status;
    return {
      name: s.name,
      type: s.type,
      status: st === 'ONLINE' ? 'operational' : (st === 'RESTARTING' || st === 'STARTING' || st === 'INSTALLING' || st === 'BUILDING') ? 'degraded' : 'down',
      uptime24h: metrics.uptime(s.id, '24h'),
      uptime30d: metrics.uptime(s.id, '30d'),
      bars: metrics.uptimeBars(s.id)
    };
  });
  for (const m of require('../lib/monitors').list().filter(x => x.statusPage && x.enabled)) {
    list.push({
      name: m.name, type: 'monitor',
      status: m.status === 'up' ? 'operational' : m.status === 'down' ? 'down' : 'degraded',
      uptime24h: m.uptime24h, uptime30d: m.uptime30d, bars: m.bars
    });
  }
  res.set('Cache-Control', 'public, max-age=15');
  res.json({ title: sp.title, updatedAt: new Date().toISOString(), services: list });
});

// GitHub push webhook. Body must be the raw bytes for signature verification.
router.post('/hooks/github/:id', express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
  const id = req.params.id;
  auth.rateLimit(`hook:${req.ip}`, 60, 60000);
  const svc = isValidId(id) && db.data.services[id];
  if (!svc) return res.status(404).json({ error: 'Unknown service' });
  if (!gitLib.verifySignature(svc.git.webhookSecret, req.body, req.headers['x-hub-signature-256'])) {
    return res.status(401).json({ error: 'Bad signature' });
  }
  const event = req.headers['x-github-event'];
  if (event === 'ping') return res.json({ ok: true, pong: true });
  if (event !== 'push') return res.status(202).json({ ignored: `event ${event}` });
  let payload = {};
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  if (payload.ref !== `refs/heads/${svc.git.branch}`) return res.status(202).json({ ignored: `push to ${payload.ref}` });
  if (!svc.git.autoDeploy) return res.status(202).json({ ignored: 'auto-deploy is off' });
  logStore.append(id, 'sys', `GitHub push received (${(payload.head_commit && payload.head_commit.id || '').slice(0, 7)}) — deploying…`);
  pipeline.deployGit(id, { by: `github:${(payload.pusher && payload.pusher.name) || 'webhook'}`, source: 'webhook' })
    .catch(e => logStore.append(id, 'sys', `Webhook deploy failed: ${e.message}`));
  res.status(202).json({ ok: true, deploying: true });
});

module.exports = router;

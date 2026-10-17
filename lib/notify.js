// Notification center + outbound alerts (Discord webhook / generic HTTP webhook).
const crypto = require('crypto');
const db = require('../db');
const bus = require('./bus');

const MAX_NOTIFICATIONS = 500;
const COLORS = { info: 0x38bdf8, success: 0x10b981, warning: 0xf59e0b, error: 0xef4444 };
const throttle = new Map();

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'OmniHost-Alerts' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) console.warn(`[alerts] ${new URL(url).host} answered ${res.status}`);
  } catch (e) {
    console.warn('[alerts] delivery failed:', e.message);
  }
}

// event: crash | crashLoop | recovered | memory | deploy | backupFailed | healthCheck | info
function notify({ level = 'info', event = 'info', title, message = '', serviceId = null, throttleKey = null, throttleMs = 0 }) {
  if (throttleKey) {
    const last = throttle.get(throttleKey) || 0;
    if (Date.now() - last < throttleMs) return null;
    throttle.set(throttleKey, Date.now());
  }
  const n = {
    id: crypto.randomBytes(6).toString('hex'),
    at: new Date().toISOString(),
    level, event, title, message: String(message).slice(0, 1000), serviceId, read: false
  };
  db.data.notifications.push(n);
  if (db.data.notifications.length > MAX_NOTIFICATIONS) db.data.notifications.splice(0, db.data.notifications.length - MAX_NOTIFICATIONS);
  db.save();
  bus.emit('notification', n);

  const alerts = db.data.settings.alerts || {};
  const enabled = event === 'info' || event === 'test' || (alerts.events && alerts.events[event]);
  if (enabled) {
    const svc = serviceId && db.data.services[serviceId];
    const label = svc ? `${svc.name} — ${title}` : title;
    if (alerts.discordWebhook) {
      postJson(alerts.discordWebhook, {
        username: 'OmniHost',
        embeds: [{ title: label.slice(0, 250), description: n.message.slice(0, 2000) || undefined, color: COLORS[level] || COLORS.info, timestamp: n.at }]
      });
    }
    if (alerts.httpWebhook) postJson(alerts.httpWebhook, { ...n, serviceName: svc ? svc.name : null });
  }
  return n;
}

module.exports = { notify };

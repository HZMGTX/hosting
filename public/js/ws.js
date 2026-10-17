// Realtime connection: logs, status, stats, diagnostics and notifications. Reconnects with backoff.
import { store } from './store.js';

let socket = null;
let retry = 0;
let stopped = false;
const subs = new Map(); // serviceId -> count

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

export function connect() {
  stopped = false;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  socket = new WebSocket(url);
  socket.addEventListener('open', () => {
    retry = 0;
    store.connected = true;
    store.emit('connection', true);
    for (const id of subs.keys()) send({ type: 'subscribe', serviceId: id });
  });
  socket.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'log': store.emit(`log:${msg.serviceId}`, msg.entry); break;
      case 'history':
        store.emit(`history:${msg.serviceId}`, msg.entries);
        if (msg.state) store.updateState(msg.serviceId, msg.state);
        if (msg.diagnostics && store.services[msg.serviceId]) { store.services[msg.serviceId].diagnostics = msg.diagnostics; store.emit(`diagnostics:${msg.serviceId}`, msg.diagnostics); }
        break;
      case 'status': store.updateState(msg.serviceId, msg.state); break;
      case 'stats':
        for (const [id, s] of Object.entries(msg.stats)) store.updateState(id, { cpu: s.cpu, memory: s.memory, uptimeMs: s.uptimeMs });
        store.emit('stats', msg.stats);
        break;
      case 'diagnostic': {
        const svc = store.services[msg.serviceId];
        if (svc) {
          svc.diagnostics = (svc.diagnostics || []).filter(d => d.id !== msg.diagnostic.id).concat(msg.diagnostic);
          store.emit(`diagnostics:${msg.serviceId}`, svc.diagnostics);
        }
        break;
      }
      case 'notification':
        store.notifications.unshift(msg.notification);
        store.unread++;
        store.emit('notification', msg.notification);
        break;
      case 'monitor': store.emit('monitor', msg.state); break;
      case 'error': store.emit('ws-error', msg); break;
    }
  });
  socket.addEventListener('close', ev => {
    store.connected = false;
    store.emit('connection', false);
    if (stopped || ev.code === 4001) return;
    const delay = Math.min(15000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  });
}

export function disconnect() {
  stopped = true;
  if (socket) socket.close();
}

export function subscribe(id) {
  subs.set(id, (subs.get(id) || 0) + 1);
  if (subs.get(id) === 1) send({ type: 'subscribe', serviceId: id });
  else send({ type: 'subscribe', serviceId: id }); // re-request history for a fresh view
  return () => {
    const n = (subs.get(id) || 1) - 1;
    if (n <= 0) { subs.delete(id); send({ type: 'unsubscribe', serviceId: id }); } else subs.set(id, n);
  };
}

export function sendStdin(id, text) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  send({ type: 'stdin', serviceId: id, text });
  return true;
}

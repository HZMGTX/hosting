// Global client state with a tiny pub/sub.
const listeners = new Map();

export const store = {
  user: null,
  info: null,
  services: {},        // id -> service view (incl. state)
  notifications: [],
  unread: 0,
  connected: false,

  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
  emit(event, payload) {
    for (const fn of listeners.get(event) || []) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  },

  setServices(list) {
    this.services = {};
    for (const s of list) this.services[s.id] = s;
    this.emit('services');
  },
  upsertService(s) {
    this.services[s.id] = { ...(this.services[s.id] || {}), ...s };
    this.emit('services');
    this.emit(`service:${s.id}`, this.services[s.id]);
  },
  removeService(id) {
    delete this.services[id];
    this.emit('services');
  },
  updateState(id, state) {
    const s = this.services[id];
    if (!s) return;
    s.state = { ...s.state, ...state };
    this.emit('state', { id, state: s.state });
    this.emit(`state:${id}`, s.state);
  },

  can(perm, serviceId) {
    const u = this.user;
    if (!u) return false;
    const rank = { viewer: 1, developer: 2, admin: 3, owner: 4 }[u.role] || 0;
    const access = rank >= 3 || u.role === 'viewer' || (u.services || []).includes(serviceId);
    switch (perm) {
      case 'view': return access;
      case 'operate': case 'edit': return u.role !== 'viewer' && access;
      case 'delete': return rank >= 3 || (u.role === 'developer' && access);
      case 'create': return rank >= 2;
      case 'exec': case 'admin': return rank >= 3;
      case 'owner': return u.role === 'owner';
      default: return false;
    }
  }
};

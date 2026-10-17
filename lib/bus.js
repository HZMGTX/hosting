// In-process event bus: backend modules emit, the WebSocket hub fans out to browsers.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100);

module.exports = bus;

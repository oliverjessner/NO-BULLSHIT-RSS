import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();

export function publish(event, data = {}) {
  emitter.emit('event', { event, data });
}

export function subscribe(handler) {
  emitter.on('event', handler);
  return () => emitter.off('event', handler);
}

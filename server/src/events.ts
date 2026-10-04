import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@lld/shared';

/** In-process fan-out of server events to SSE subscribers. */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}

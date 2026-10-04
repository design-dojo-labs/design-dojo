import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ServerEvent } from '@lld/shared';

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;
const connListeners = new Set<() => void>();

function setConnected(v: boolean) {
  if (connected === v) return;
  connected = v;
  connListeners.forEach((l) => l());
}

function ensure() {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false); // EventSource reconnects automatically
  source.onmessage = (m) => {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(m.data);
    } catch {
      return;
    }
    listeners.forEach((l) => l(ev));
  };
}

export function subscribe(l: Listener): () => void {
  ensure();
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Subscribes to server events for the lifetime of the component; the latest handler is always used. */
export function useServerEvents(handler: Listener): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((e) => ref.current(e)), []);
}

export function useEventsConnected(): boolean {
  return useSyncExternalStore(
    (cb) => {
      ensure();
      connListeners.add(cb);
      return () => connListeners.delete(cb);
    },
    () => connected,
  );
}

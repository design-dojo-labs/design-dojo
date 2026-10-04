import { useEffect, useRef, useState } from 'react';
import { CLIENT_ID } from './api';

/**
 * Same-browser coordination between studio tabs over BroadcastChannel.
 *
 * The server's change events (`fs-changed`, `hld-doc-saved`) are the source of truth and also cover
 * other browsers and out-of-band writes. This channel is a fast path for tabs of the same browser
 * (it keeps working while the event stream reconnects) and powers the "also open in another tab"
 * notice. Every function is a no-op where BroadcastChannel is unavailable.
 */

type Message =
  | { type: 'hello' | 'here' | 'bye'; tabId: string; scope: string }
  | { type: 'saved'; tabId: string; scope: string; detail: SavedDetail };

/** What a tab saved: a workspace file (path + new hash) or the HLD design document (hash). */
export type SavedDetail = { path: string; hash: string } | { hash: string };

const CHANNEL = 'lld-studio-tabs';
const HEARTBEAT_MS = 10_000;
const PEER_TTL_MS = 25_000;

let channel: BroadcastChannel | null | undefined;
const handlers = new Set<(m: Message) => void>();

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof BroadcastChannel === 'undefined') return (channel = null);
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e: MessageEvent<Message>) => {
      const m = e.data;
      if (!m || typeof m !== 'object' || m.tabId === CLIENT_ID) return;
      handlers.forEach((h) => h(m));
    };
  } catch {
    channel = null;
  }
  return channel;
}

function post(m: Message): void {
  try {
    getChannel()?.postMessage(m);
  } catch {
    /* a closed channel only loses the fast path */
  }
}

function listen(h: (m: Message) => void): () => void {
  getChannel();
  handlers.add(h);
  return () => handlers.delete(h);
}

/** Session scopes so LLD and HLD sessions never collide. */
export const lldScope = (sessionId: string) => `lld:${sessionId}`;
export const hldScope = (sessionId: string) => `hld:${sessionId}`;

/** Tells other tabs of this browser that this tab just saved something in `scope`. */
export function broadcastSaved(scope: string, detail: SavedDetail): void {
  post({ type: 'saved', tabId: CLIENT_ID, scope, detail });
}

/** Calls `cb` when another tab of this browser saves something in `scope`. */
export function onPeerSaved(scope: string, cb: (detail: SavedDetail) => void): () => void {
  return listen((m) => {
    if (m.type === 'saved' && m.scope === scope) cb(m.detail);
  });
}

/** Number of other tabs of this browser that currently have the same session (`scope`) open. */
export function usePeerTabs(scope: string): number {
  const [count, setCount] = useState(0);
  const peers = useRef(new Map<string, number>());
  useEffect(() => {
    const seen = peers.current;
    seen.clear();
    const refresh = () => {
      const now = Date.now();
      for (const [id, at] of seen) if (now - at > PEER_TTL_MS) seen.delete(id);
      setCount(seen.size);
    };
    const off = listen((m) => {
      if (m.scope !== scope) return;
      if (m.type === 'bye') seen.delete(m.tabId);
      else seen.set(m.tabId, Date.now());
      // Answer a newcomer so it learns about this tab immediately instead of at the next heartbeat.
      if (m.type === 'hello') post({ type: 'here', tabId: CLIENT_ID, scope });
      refresh();
    });
    post({ type: 'hello', tabId: CLIENT_ID, scope });
    const beat = setInterval(() => {
      post({ type: 'here', tabId: CLIENT_ID, scope });
      refresh();
    }, HEARTBEAT_MS);
    const bye = () => post({ type: 'bye', tabId: CLIENT_ID, scope });
    window.addEventListener('pagehide', bye);
    return () => {
      off();
      clearInterval(beat);
      window.removeEventListener('pagehide', bye);
      bye();
      seen.clear();
    };
  }, [scope]);
  return count;
}

export type RemoteChangeAction = 'ignore' | 'reload' | 'conflict';

/**
 * What a tab should do when it learns that its document was saved elsewhere.
 * - its own change (same client id, or the hash it already has) → ignore
 * - no unsaved edits here → reload silently and adopt the new hash
 * - unsaved edits here → conflict, so the user decides which version wins
 */
export function decideRemoteChange(input: {
  eventClientId: string | null;
  ownClientId: string;
  eventHash: string | null;
  baseHash: string;
  hasUnsavedEdits: boolean;
}): RemoteChangeAction {
  if (input.eventClientId && input.eventClientId === input.ownClientId) return 'ignore';
  if (input.eventHash && input.eventHash === input.baseHash) return 'ignore';
  return input.hasUnsavedEdits ? 'conflict' : 'reload';
}

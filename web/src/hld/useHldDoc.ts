import { useCallback, useEffect, useRef, useState } from 'react';
import type { HldDocument, HldSession } from '@lld/shared';
import { ApiError, CLIENT_ID, errorMessage, get, put } from '../lib/api';
import { useEventsConnected, useServerEvents } from '../lib/events';
import { broadcastSaved, decideRemoteChange, hldScope, onPeerSaved, usePeerTabs } from '../lib/tabsync';
import { useToast } from '../components/ui';

export type DocSaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

/**
 * The HLD design document with debounced autosave. Saves are serialized and carry the hash of the
 * version they were based on; the server answers 409 if it changed elsewhere (e.g. another tab),
 * and the user decides which version wins.
 *
 * Saves made elsewhere are also picked up proactively (server `hld-doc-saved` events, plus a
 * same-browser BroadcastChannel fast path): with no unsaved edits the newer version is loaded
 * silently; with unsaved edits the conflict prompt appears at once instead of on the next save.
 * `docRevision` increases whenever the document is replaced from outside, so components that only
 * read the document on mount (the canvas) can be re-keyed.
 */
export function useHldDoc(session: HldSession, delayMs = 1000) {
  const [doc, setDoc] = useState<HldDocument>(session.doc);
  const [state, setStateRaw] = useState<DocSaveState>('saved');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentDoc: HldDocument | null; currentHash: string } | null>(null);
  const [docRevision, setDocRevision] = useState(0);
  const toast = useToast();
  const latest = useRef(session.doc);
  const savedJson = useRef(JSON.stringify(session.doc));
  const baseHash = useRef(session.docHash);
  const inflight = useRef<Promise<void> | null>(null);
  const resave = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflictRef = useRef(false);
  const stateRef = useRef<DocSaveState>('saved');
  const setState = useCallback((s: DocSaveState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);

  const save = useCallback(
    async (force = false): Promise<void> => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (inflight.current) {
        resave.current = true;
        return inflight.current;
      }
      if (conflictRef.current && !force) return;
      const toSave = latest.current;
      const json = JSON.stringify(toSave);
      if (!force && json === savedJson.current) {
        setState('saved');
        return;
      }
      setState('saving');
      inflight.current = (async () => {
        try {
          const res = await put<{ hash: string }>(`/api/hld/sessions/${session.id}/doc`, { doc: toSave, baseHash: baseHash.current, force });
          baseHash.current = res.hash;
          savedJson.current = json;
          conflictRef.current = false;
          setConflict(null);
          setError(null);
          setState(JSON.stringify(latest.current) === json ? 'saved' : 'dirty');
          broadcastSaved(hldScope(session.id), { hash: res.hash });
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            const currentDoc = (e.body.currentDoc as HldDocument | null) ?? null;
            const currentHash = String(e.body.currentHash ?? '');
            if (currentDoc && currentHash && JSON.stringify(currentDoc) === json) {
              // The other version is identical to ours (e.g. the same change in two tabs): nothing to decide.
              baseHash.current = currentHash;
              savedJson.current = json;
              conflictRef.current = false;
              setConflict(null);
              setError(null);
              setState(JSON.stringify(latest.current) === json ? 'saved' : 'dirty');
            } else {
              conflictRef.current = true;
              setConflict({ currentDoc, currentHash });
              setState('conflict');
            }
          } else {
            setError(errorMessage(e));
            setState('error');
          }
        } finally {
          inflight.current = null;
        }
        if (resave.current) {
          resave.current = false;
          if (JSON.stringify(latest.current) !== savedJson.current) await save();
        }
      })();
      return inflight.current;
    },
    [session.id, setState],
  );

  const update = useCallback(
    (fn: (d: HldDocument) => HldDocument) => {
      // Computed synchronously so a flush right after an update always sees it.
      const next = fn(latest.current);
      latest.current = next;
      setDoc(next);
      if (!conflictRef.current) setState('dirty');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), delayMs);
    },
    [save, delayMs, setState],
  );

  /** Saves pending edits; resolves true when everything is on the server. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (JSON.stringify(latest.current) !== savedJson.current || inflight.current) await save();
    if (inflight.current) await inflight.current;
    return !conflictRef.current && JSON.stringify(latest.current) === savedJson.current;
  }, [save]);

  const keepMine = useCallback(() => save(true), [save]);
  /** Marks unsaved work that has not reached the document yet (e.g. a canvas edit being debounced). */
  const markDirty = useCallback(() => {
    if (!conflictRef.current) setState('dirty');
  }, [setState]);

  /** Replaces the local document with a version saved elsewhere. */
  const adopt = useCallback(
    (next: HldDocument, hash: string) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      latest.current = next;
      savedJson.current = JSON.stringify(next);
      baseHash.current = hash;
      conflictRef.current = false;
      setDoc(next);
      setConflict(null);
      setError(null);
      setState('saved');
      setDocRevision((r) => r + 1);
    },
    [setState],
  );

  const useTheirs = useCallback(() => {
    if (!conflict?.currentDoc) return;
    adopt(conflict.currentDoc, conflict.currentHash);
  }, [conflict, adopt]);

  const hasUnsavedEdits = () =>
    !!inflight.current || !!timer.current || stateRef.current === 'dirty' || stateRef.current === 'saving' || JSON.stringify(latest.current) !== savedJson.current;

  // Serializes remote-change handling: events from the server and from sibling tabs can arrive together.
  const remoteChain = useRef<Promise<void>>(Promise.resolve());
  const onRemoteSave = useCallback(
    (eventClientId: string | null, eventHash: string | null) => {
      remoteChain.current = remoteChain.current
        .then(async () => {
          if (conflictRef.current) return; // the user is already deciding; the prompt shows the newest version on "Load"
          const first = decideRemoteChange({ eventClientId, ownClientId: CLIENT_ID, eventHash, baseHash: baseHash.current, hasUnsavedEdits: hasUnsavedEdits() });
          if (first === 'ignore') return;
          const s = await get<HldSession>(`/api/hld/sessions/${session.id}`);
          // Decide again: the user may have typed (or our own save may have landed) while fetching.
          const action = decideRemoteChange({ eventClientId: null, ownClientId: CLIENT_ID, eventHash: s.docHash, baseHash: baseHash.current, hasUnsavedEdits: hasUnsavedEdits() });
          if (action === 'ignore' || conflictRef.current) return;
          if (action === 'reload') {
            adopt(s.doc, s.docHash);
            toast('info', 'This design was updated in another tab or window; showing the latest version.');
          } else {
            if (timer.current) {
              clearTimeout(timer.current);
              timer.current = null;
            }
            conflictRef.current = true;
            setConflict({ currentDoc: s.doc, currentHash: s.docHash });
            setState('conflict');
          }
        })
        .catch(() => {
          /* a failed check is retried by the next event, reconnect or save (which returns 409) */
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id, adopt, toast, setState],
  );

  useServerEvents((ev) => {
    if (ev.type === 'hld-doc-saved' && ev.sessionId === session.id) onRemoteSave(ev.clientId, ev.hash);
  });
  useEffect(() => onPeerSaved(hldScope(session.id), (d) => onRemoteSave(null, d.hash)), [session.id, onRemoteSave]);
  // Saves made while the event stream was disconnected are only noticed by asking again.
  const connected = useEventsConnected();
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) onRemoteSave(null, null);
    wasConnected.current = connected;
  }, [connected, onRemoteSave]);

  const otherTabs = usePeerTabs(hldScope(session.id));

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (JSON.stringify(latest.current) !== savedJson.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => {
      window.removeEventListener('beforeunload', h);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return { doc, update, state, error, conflict, flush, save, keepMine, useTheirs, markDirty, docRevision, otherTabs };
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Session } from '@lld/shared';
import { patch } from '../lib/api';
import { WorkspaceFiles } from './buffers';

export type Tab =
  | { id: string; kind: 'ws'; path: string }
  | { id: string; kind: 'snap'; path: string; submissionId: string; seq: number }
  | { id: string; kind: 'ref'; path: string; referenceId: string };

export interface Reveal {
  tabId: string;
  lineStart: number;
  lineEnd: number;
  nonce: number;
}

export type LeftView = 'problem' | 'files' | 'search' | 'hints';
export type BottomView = 'output' | 'problems' | 'tests' | 'config';

interface Ctx {
  session: Session;
  files: WorkspaceFiles;
  tabs: Tab[];
  activeTabId: string | null;
  reveal: Reveal | null;
  openFile: (path: string, line?: number, lineEnd?: number) => Promise<void>;
  openSnapshot: (submissionId: string, seq: number, path: string, line?: number | null, lineEnd?: number | null) => void;
  openReference: (referenceId: string, path: string) => void;
  activate: (id: string) => void;
  closeTab: (id: string) => void;
  renameTabs: (from: string, to: string) => void;
  closeUnder: (path: string) => void;
  leftView: LeftView;
  setLeftView: (v: LeftView) => void;
  bottomView: BottomView;
  setBottomView: (v: BottomView) => void;
  selectedSubmission: string | null;
  selectSubmission: (id: string | null) => void;
}

const WorkspaceCtx = createContext<Ctx | null>(null);
export function useWorkspace(): Ctx {
  const c = useContext(WorkspaceCtx);
  if (!c) throw new Error('useWorkspace outside provider');
  return c;
}

export function useFilesVersion(files: WorkspaceFiles): number {
  return useSyncExternalStore(files.subscribe, files.getVersion);
}

export const wsTabId = (path: string) => `ws:${path}`;

export function WorkspaceProvider({
  session,
  files,
  initialSubmission,
  children,
}: {
  session: Session;
  files: WorkspaceFiles;
  initialSubmission: string | null;
  children: ReactNode;
}) {
  const [tabs, setTabs] = useState<Tab[]>(() => session.editorState.openTabs.map((p) => ({ id: wsTabId(p), kind: 'ws' as const, path: p })));
  const [activeTabId, setActive] = useState<string | null>(session.editorState.activeTab ? wsTabId(session.editorState.activeTab) : null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [leftView, setLeftView] = useState<LeftView>(() => (localStorage.getItem('lld.ws.left') as LeftView) || 'problem');
  const [bottomView, setBottomView] = useState<BottomView>('output');
  const [selectedSubmission, selectSubmission] = useState<string | null>(initialSubmission);
  const nonce = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem('lld.ws.left', leftView);
    } catch {
      /* ignore */
    }
  }, [leftView]);

  // Persist open workspace tabs so a refresh or restart restores them.
  useEffect(() => {
    const openTabs = tabs.filter((t) => t.kind === 'ws').map((t) => t.path);
    const active = tabs.find((t) => t.id === activeTabId);
    const handle = setTimeout(() => {
      void patch(`/api/sessions/${session.id}`, { editorState: { openTabs, activeTab: active?.kind === 'ws' ? active.path : (openTabs[0] ?? null) } }).catch(() => {});
    }, 800);
    return () => clearTimeout(handle);
  }, [tabs, activeTabId, session.id]);

  const addTab = useCallback((t: Tab) => {
    setTabs((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
    setActive(t.id);
  }, []);

  const openFile = useCallback(
    async (path: string, line?: number, lineEnd?: number) => {
      await files.open(path);
      addTab({ id: wsTabId(path), kind: 'ws', path });
      if (line) setReveal({ tabId: wsTabId(path), lineStart: line, lineEnd: lineEnd ?? line, nonce: ++nonce.current });
    },
    [files, addTab],
  );

  const openSnapshot = useCallback(
    (submissionId: string, seq: number, path: string, line?: number | null, lineEnd?: number | null) => {
      const id = `snap:${submissionId}:${path}`;
      addTab({ id, kind: 'snap', path, submissionId, seq });
      if (line) setReveal({ tabId: id, lineStart: line, lineEnd: lineEnd ?? line, nonce: ++nonce.current });
    },
    [addTab],
  );

  const openReference = useCallback((referenceId: string, path: string) => addTab({ id: `ref:${referenceId}:${path}`, kind: 'ref', path, referenceId }), [addTab]);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((ts) => {
        const i = ts.findIndex((t) => t.id === id);
        const next = ts.filter((t) => t.id !== id);
        setActive((cur) => (cur === id ? (next[Math.min(i, next.length - 1)]?.id ?? null) : cur));
        return next;
      });
      if (id.startsWith('ws:')) {
        const path = id.slice(3);
        void files.save(path).then(() => {
          const b = files.get(path);
          if (b && b.state === 'saved') files.close(path);
        });
      }
    },
    [files],
  );

  const renameTabs = useCallback((from: string, to: string) => {
    setTabs((ts) =>
      ts.map((t) => {
        if (t.kind !== 'ws') return t;
        if (t.path === from || t.path.startsWith(from + '/')) {
          const p = to + t.path.slice(from.length);
          return { id: wsTabId(p), kind: 'ws', path: p };
        }
        return t;
      }),
    );
    setActive((cur) => (cur && cur.startsWith('ws:') && (cur.slice(3) === from || cur.slice(3).startsWith(from + '/')) ? wsTabId(to + cur.slice(3 + from.length)) : cur));
  }, []);

  const closeUnder = useCallback((path: string) => {
    setTabs((ts) => {
      const next = ts.filter((t) => !(t.kind === 'ws' && (t.path === path || t.path.startsWith(path + '/'))));
      setActive((cur) => (cur && !next.some((t) => t.id === cur) ? (next[0]?.id ?? null) : cur));
      return next;
    });
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      session,
      files,
      tabs,
      activeTabId,
      reveal,
      openFile,
      openSnapshot,
      openReference,
      activate: setActive,
      closeTab,
      renameTabs,
      closeUnder,
      leftView,
      setLeftView,
      bottomView,
      setBottomView,
      selectedSubmission,
      selectSubmission,
    }),
    [session, files, tabs, activeTabId, reveal, openFile, openSnapshot, openReference, closeTab, renameTabs, closeUnder, leftView, bottomView, selectedSubmission],
  );
  return <WorkspaceCtx.Provider value={value}>{children}</WorkspaceCtx.Provider>;
}

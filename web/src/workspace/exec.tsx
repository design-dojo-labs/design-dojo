import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ExecKind, ExecRun } from '@lld/shared';
import { errorMessage, get, post } from '../lib/api';
import { useServerEvents } from '../lib/events';
import { monaco } from './monaco';
import { wsUri } from './buffers';

export interface Chunk {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

interface ExecCtx {
  runs: Record<ExecKind, ExecRun | null>;
  shown: ExecKind | null;
  setShown: (k: ExecKind) => void;
  chunks: (runId: string) => Chunk[];
  running: ExecRun | null;
  start: (kind: ExecKind, opts: { mainClass?: string | null; args?: string; stdin?: string }) => Promise<ExecRun>;
  stop: () => Promise<void>;
  tick: number;
}

const Ctx = createContext<ExecCtx | null>(null);
export const useExec = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useExec outside provider');
  return c;
};

const MAX_CHUNKS = 4000;

/** Live compile/run/test state for a session, fed by server-sent events and restored on reload. */
export function ExecProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const [runs, setRuns] = useState<Record<ExecKind, ExecRun | null>>({ compile: null, run: null, test: null });
  const [shown, setShown] = useState<ExecKind | null>(null);
  const [tick, force] = useState(0);
  const chunkMap = useRef(new Map<string, Chunk[]>());
  const rerender = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bump = () => {
    if (rerender.current) return;
    rerender.current = setTimeout(() => {
      rerender.current = null;
      force((x) => x + 1);
    }, 50);
  };

  useEffect(() => {
    let cancelled = false;
    get<ExecRun[]>(`/api/sessions/${sessionId}/exec`)
      .then((list) => {
        if (cancelled) return;
        const next: Record<ExecKind, ExecRun | null> = { compile: null, run: null, test: null };
        let latest: ExecRun | null = null;
        for (const r of list) {
          next[r.kind] = r;
          if (!chunkMap.current.has(r.id)) {
            const c: Chunk[] = [];
            if (r.stdout) c.push({ stream: 'stdout', text: r.stdout });
            if (r.stderr) c.push({ stream: 'stderr', text: r.stderr });
            chunkMap.current.set(r.id, c);
          }
          if (!latest || r.startedAt > latest.startedAt) latest = r;
        }
        setRuns(next);
        if (latest) {
          setShown(latest.kind);
          // Only the most recent build reflects the current code; older diagnostics would be stale.
          applyMarkers(sessionId, latest);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useServerEvents((ev) => {
    if (ev.type === 'exec-output' && ev.sessionId === sessionId) {
      const list = chunkMap.current.get(ev.runId) ?? [];
      const last = list[list.length - 1];
      if (last && last.stream === ev.stream) last.text += ev.chunk;
      else list.push({ stream: ev.stream, text: ev.chunk });
      if (list.length > MAX_CHUNKS) list.splice(0, list.length - MAX_CHUNKS);
      chunkMap.current.set(ev.runId, list);
      bump();
    } else if (ev.type === 'exec-state' && ev.run.sessionId === sessionId && !ev.run.submissionId) {
      setRuns((r) => ({ ...r, [ev.run.kind]: ev.run }));
      if (ev.run.state !== 'running') {
        clearMarkers(sessionId);
        applyMarkers(sessionId, ev.run);
      }
    }
  });

  const running = (['compile', 'run', 'test'] as const).map((k) => runs[k]).find((r) => r?.state === 'running') ?? null;

  const start = useCallback(
    async (kind: ExecKind, opts: { mainClass?: string | null; args?: string; stdin?: string }) => {
      clearMarkers(sessionId);
      const run = await post<ExecRun>(`/api/sessions/${sessionId}/exec`, { kind, ...opts });
      if (!chunkMap.current.has(run.id)) chunkMap.current.set(run.id, []);
      setRuns((r) => ({ ...r, [kind]: run }));
      setShown(kind);
      return run;
    },
    [sessionId],
  );

  const stop = useCallback(async () => {
    if (!running) return;
    try {
      await post(`/api/exec/${running.id}/stop`);
    } catch (e) {
      throw new Error(errorMessage(e));
    }
  }, [running]);

  const value = useMemo<ExecCtx>(
    // `tick` changes whenever streamed output arrives so consumers re-render with the new chunks.
    () => ({ runs, shown, setShown, chunks: (id) => [...(chunkMap.current.get(id) ?? [])], running, start, stop, tick }),
    [runs, shown, running, start, stop, tick],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Shows compiler diagnostics as squiggles in open editor models. */
function applyMarkers(sessionId: string, run: ExecRun) {
  const byFile = new Map<string, monaco.editor.IMarkerData[]>();
  for (const d of run.diagnostics) {
    if (!d.file || !d.line) continue;
    const list = byFile.get(d.file) ?? [];
    list.push({
      severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      message: d.message,
      startLineNumber: d.line,
      startColumn: d.column ?? 1,
      endLineNumber: d.line,
      endColumn: (d.column ?? 1) + 200,
      source: 'javac',
    });
    byFile.set(d.file, list);
  }
  for (const [file, markers] of byFile) {
    const model = monaco.editor.getModel(wsUri(sessionId, file));
    if (model) monaco.editor.setModelMarkers(model, 'javac', markers);
  }
}

function clearMarkers(sessionId: string) {
  for (const m of monaco.editor.getModels()) {
    if (m.uri.path.startsWith(`/ws/${sessionId}/`)) monaco.editor.setModelMarkers(m, 'javac', []);
  }
}

import { useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, CircleAlert, Info, ListChecks } from 'lucide-react';
import { lintLldWorkspace, type FileContent, type LldCheck, type LldLintFile } from '@lld/shared';
import { get } from '../lib/api';
import { useTree } from './FileTree';
import { useFilesVersion, useWorkspace } from './context';

const OPEN_KEY = 'lld.ws.checks.open';
const LINTED = (path: string) => path.endsWith('.java') || path === 'DESIGN_NOTES.md';

/**
 * Instant local checks over the workspace: saved files from the tree (fetched once per content hash)
 * overlaid with unsaved editor buffers, recomputed shortly after typing stops.
 */
export function useLldChecks(delayMs = 600): LldCheck[] {
  const { session, files } = useWorkspace();
  const tree = useTree(session.id);
  const version = useFilesVersion(files);
  const entries = (tree.data?.entries ?? []).filter((e) => e.type === 'file' && LINTED(e.path));
  const contents = useQueries({
    queries: entries.map((e) => ({
      queryKey: ['lint-file', session.id, e.path, e.hash],
      queryFn: () => get<FileContent>(`/api/sessions/${session.id}/file?path=${encodeURIComponent(e.path)}`),
      staleTime: Infinity,
      gcTime: 5 * 60_000,
    })),
  });
  const saved = contents.map((q) => q.data).filter((f): f is FileContent => !!f);
  const savedKey = saved.map((f) => `${f.path}:${f.hash}`).join('|');

  const [snapshot, setSnapshot] = useState<LldLintFile[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      const byPath = new Map(saved.map((f) => [f.path, f.content]));
      for (const b of files.all()) if (LINTED(b.path)) byPath.set(b.path, b.model.getValue());
      setSnapshot([...byPath].map(([path, content]) => ({ path, content })));
    }, delayMs);
    return () => clearTimeout(t);
    // `saved` is derived from savedKey; buffers are tracked by the files version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey, version, files, delayMs]);

  const requirementIds = useMemo(() => session.problem.content.requirements.map((r) => r.id), [session.problem.content.requirements]);
  return useMemo(() => lintLldWorkspace(snapshot, { requirementIds }), [snapshot, requirementIds]);
}

/** Collapsible "Checks" section: local heuristics only, no AI. Clicking a check opens the file at the line. */
export function ChecksSection() {
  const ws = useWorkspace();
  const checks = useLldChecks();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? '0' : '1');
    } catch {
      /* ignore */
    }
  };
  const warn = checks.filter((c) => c.severity === 'warn').length;
  return (
    <section className="mb-3 rounded-[5px] border border-line bg-canvas" data-testid="lld-checks">
      <button onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[12.5px]">
        {open ? <ChevronDown className="size-3.5 text-faint" /> : <ChevronRight className="size-3.5 text-faint" />}
        <ListChecks className="size-3.5 text-muted" />
        <span className="font-medium">Instant checks</span>
        {warn > 0 && <span className="tabular rounded-full bg-warn/15 px-1.5 text-[11px] font-medium text-warn">{warn}</span>}
        {checks.length - warn > 0 && <span className="tabular text-[11px] text-faint">{checks.length - warn}</span>}
        {!checks.length && <span className="text-[11.5px] text-ok">all clear</span>}
        <span className="ml-auto text-[11px] text-faint">local, no AI</span>
      </button>
      {open && checks.length > 0 && (
        <ul className="flex max-h-[240px] flex-col gap-0.5 overflow-auto border-t border-line px-2 py-1.5 text-[12px]">
          {checks.map((c) => (
            <li key={c.id}>
              <button
                className={clsx('flex w-full items-start gap-1.5 rounded-[3px] px-1 py-0.5 text-left', c.path ? 'hover:bg-sunken' : 'cursor-default')}
                onClick={() => c.path && void ws.openFile(c.path, c.line)}
                disabled={!c.path}
              >
                {c.severity === 'warn' ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-label="warning" /> : <Info className="mt-0.5 size-3.5 shrink-0 text-faint" aria-label="suggestion" />}
                <span className="min-w-0">
                  <span className={c.severity === 'warn' ? 'text-ink' : 'text-muted'}>{c.message}</span>
                  {c.path && (
                    <span className="block truncate font-mono text-[11px] text-faint">
                      {c.path.split('/').pop()}
                      {c.line ? `:${c.line}` : ''}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

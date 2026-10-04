import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { CircleAlert, Info, ListChecks, X } from 'lucide-react';
import { lintHldDocument, type HldCheck, type HldDocument, type HldLintStage } from '@lld/shared';

const OPEN_KEY = 'lld.hld.checks.open';

/** Instant checks for the design, recomputed shortly after the user stops typing or drawing. */
export function useHldChecks(doc: HldDocument, delayMs = 400): HldCheck[] {
  const [settled, setSettled] = useState(doc);
  useEffect(() => {
    const t = setTimeout(() => setSettled(doc), delayMs);
    return () => clearTimeout(t);
  }, [doc, delayMs]);
  return useMemo(() => lintHldDocument(settled), [settled]);
}

export function useChecksOpen(defaultOpen: boolean): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(OPEN_KEY);
      return v === null ? defaultOpen : v === '1';
    } catch {
      return defaultOpen;
    }
  });
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  return [open, set];
}

/** Toggle button for the stage tab bar: shows how many checks are open. */
export function ChecksToggle({ checks, open, onToggle }: { checks: HldCheck[]; open: boolean; onToggle: () => void }) {
  const warn = checks.filter((c) => c.severity === 'warn').length;
  return (
    <button
      onClick={onToggle}
      aria-pressed={open}
      aria-label={`Instant checks: ${warn} warning(s), ${checks.length - warn} suggestion(s)`}
      title="Instant checks on your design (local, no AI)"
      className={clsx('ml-auto flex shrink-0 items-center gap-1.5 self-center rounded-[4px] border px-2 py-0.5 text-[12px]', open ? 'border-line-strong bg-select text-ink' : 'border-line text-muted hover:text-ink')}
      data-testid="hld-checks-toggle"
    >
      <ListChecks className="size-3.5" />
      Checks
      {warn > 0 && <span className="tabular rounded-full bg-warn/15 px-1.5 text-[11px] font-medium text-warn">{warn}</span>}
      {checks.length - warn > 0 && <span className="tabular text-[11px] text-faint">{checks.length - warn}</span>}
    </button>
  );
}

const STAGE_LABEL: Record<HldLintStage, string> = {
  requirements: 'Requirements',
  estimates: 'Estimates',
  api: 'API',
  entities: 'Data model',
  diagram: 'Architecture',
  notes: 'Deep dives',
};

/** The list of checks, current stage first; clicking one jumps to its stage or its components. */
export function ChecksPanel({
  checks,
  stage,
  onGoToStage,
  onShowOnCanvas,
  onClose,
}: {
  checks: HldCheck[];
  stage: HldLintStage;
  onGoToStage: (s: HldLintStage) => void;
  onShowOnCanvas: (labels: string[]) => void;
  onClose: () => void;
}) {
  const [all, setAll] = useState(false);
  const here = checks.filter((c) => c.stage === stage);
  const shown = all ? [...here, ...checks.filter((c) => c.stage !== stage)] : here;
  return (
    <div className="max-h-[200px] shrink-0 overflow-auto border-b border-line bg-canvas px-3 py-2 text-[12.5px]" data-testid="hld-checks-panel">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium">Instant checks</span>
        <span className="text-faint">Local and generic: they spot gaps, not design quality.</span>
        <label className="ml-auto flex items-center gap-1 text-muted">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All stages ({checks.length})
        </label>
        <button onClick={onClose} aria-label="Close checks" className="text-faint hover:text-ink">
          <X className="size-3.5" />
        </button>
      </div>
      {!shown.length && <p className="text-faint">{here.length || !checks.length ? 'Nothing to flag in this stage.' : 'Nothing to flag in this stage. Tick “All stages” to see the rest.'}</p>}
      <ul className="flex flex-col gap-0.5">
        {shown.map((c) => {
          const labels = (c.componentLabels ?? []).filter((l) => !l.startsWith('(unlabeled'));
          return (
            <li key={c.id} className="flex items-start gap-1.5">
              {c.severity === 'warn' ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-label="warning" /> : <Info className="mt-0.5 size-3.5 shrink-0 text-faint" aria-label="suggestion" />}
              <span className={clsx(c.severity === 'warn' ? 'text-ink' : 'text-muted')}>
                {c.stage !== stage && <span className="mr-1 text-faint">{STAGE_LABEL[c.stage]}:</span>}
                {c.message}
              </span>
              <span className="ml-auto flex shrink-0 gap-2">
                {c.stage !== stage && (
                  <button className="text-focus hover:underline" onClick={() => onGoToStage(c.stage)}>
                    Go
                  </button>
                )}
                {labels.length > 0 && (
                  <button className="text-focus hover:underline" onClick={() => onShowOnCanvas(labels)}>
                    Show
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Small per-tab marker: number of warnings in that stage. */
export function StageWarnBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="tabular rounded-full bg-warn/15 px-1 text-[10.5px] font-medium text-warn" title={`${count} check(s) to look at`}>
      {count}
    </span>
  );
}

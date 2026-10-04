import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ReviewDetailState } from '@lld/shared';
import { useServerEvents } from '../lib/events';
import { Badge, Button, Spinner } from './ui';

type Partials = Partial<Record<'score' | 'detail' | 'full', Record<string, unknown>>>;

/**
 * Latest streamed (partial, unvalidated) structured output of a running job, per pass. Each event
 * is a cumulative snapshot, so a tab that opens mid-review catches up on the next event.
 */
export function useJobPartials(jobId: string | null | undefined): Partials {
  const [state, setState] = useState<{ jobId: string | null; data: Partials }>({ jobId: null, data: {} });
  useEffect(() => setState({ jobId: jobId ?? null, data: {} }), [jobId]);
  useServerEvents((e) => {
    if (e.type !== 'job-partial' || !jobId || e.jobId !== jobId) return;
    if (!e.data || typeof e.data !== 'object') return;
    setState((s) => ({ jobId, data: { ...(s.jobId === jobId ? s.data : {}), [e.phase]: e.data as Record<string, unknown> } }));
  });
  return state.jobId === jobId ? state.data : {};
}

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What the reviewer has written so far — clearly marked as provisional until it is validated. */
export function LivePreview({ data, maxByKey }: { data: Record<string, unknown> | undefined; maxByKey?: Record<string, { label: string; max: number }> }) {
  if (!data) return null;
  const categories = arr(data.categories).filter((c) => typeof c.score === 'number' && typeof c.key === 'string');
  const items = arr(data.findings).length ? arr(data.findings) : arr(data.improvements);
  const summary = str(data.summary);
  if (!categories.length && !items.length && !summary) return null;
  const sum = categories.reduce((s, c) => s + (c.score as number), 0);
  const maxSum = categories.reduce((s, c) => s + (maxByKey?.[c.key as string]?.max ?? 0), 0);
  return (
    <div className="mt-3 rounded-[5px] border border-dashed border-line bg-sunken px-3 py-2.5 text-[12.5px]" aria-live="polite" data-testid="live-preview">
      <div className="flex items-center gap-2 text-[11.5px] text-faint">
        <Spinner className="size-3" />
        Live preview — the reviewer is still writing; scores are checked before they are saved.
      </div>
      {categories.length > 0 && (
        <div className="mt-2">
          <div className="tabular text-[20px] font-semibold">
            {sum}
            {maxSum > 0 && <span className="text-[13px] font-normal text-faint">/{maxSum} so far</span>}
          </div>
          <ul className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
            {categories.map((c) => (
              <li key={c.key as string} className="contents">
                <span className="text-muted">{maxByKey?.[c.key as string]?.label ?? (c.key as string)}</span>
                <span className="tabular">
                  {c.score as number}
                  {maxByKey?.[c.key as string] ? `/${maxByKey[c.key as string].max}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary && <p className="mt-2 text-muted">{summary}</p>}
      {items.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {items.map((f, i) => {
            const level = str(f.severity) || str(f.priority);
            return (
              <li key={i} className="flex items-baseline gap-1.5">
                {level && <Badge tone={level === 'critical' || level === 'major' || level === 'high' ? 'err' : level === 'minor' || level === 'medium' ? 'warn' : 'neutral'}>{level}</Badge>}
                <span>{str(f.title) || '…'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Placeholder for the detail pass of a fast-mode review: still running, or failed with a retry. */
export function DetailStatus({
  detail,
  what,
  partialCount,
  onRetry,
  retrying,
}: {
  detail: ReviewDetailState | undefined;
  what: string;
  /** How many detail items have streamed in so far (shown while pending). */
  partialCount?: number;
  onRetry: () => void;
  retrying: boolean;
}) {
  if (!detail || detail.status === 'completed') return null;
  if (detail.status === 'pending') {
    return (
      <div className="mt-5 flex items-center gap-2 rounded-[5px] border border-line bg-sunken px-3 py-2 text-[12.5px] text-muted" data-testid="detail-pending">
        <Spinner className="size-3.5" />
        <span>
          The {what} is still being written{partialCount ? ` (${partialCount} item${partialCount === 1 ? '' : 's'} so far)` : ''}. The score above is final.
        </span>
      </div>
    );
  }
  return (
    <div className="mt-5 rounded-[5px] border border-line bg-sunken px-3 py-2 text-[12.5px]" data-testid="detail-failed">
      <div className="text-muted">
        The {what} did not complete{detail.error ? `: ${detail.error.message}` : '.'} The score above is unaffected.
      </div>
      <Button className="mt-2" size="sm" icon={<RotateCcw className="size-3.5" />} busy={retrying} onClick={onRetry}>
        Retry the {what}
      </Button>
    </div>
  );
}

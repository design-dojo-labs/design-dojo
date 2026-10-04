import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { Job } from '@lld/shared';
import { formatDuration } from '../lib/format';
import { estimateFor, etaView, useJobDurations } from '../lib/jobEta';

/**
 * Slim progress bar for a queued or running AI job: elapsed time plus an estimate from past runs of
 * the same kind (and provider when known). Renders nothing once the job has finished.
 */
export function JobEta({ job, className }: { job: Pick<Job, 'kind' | 'state' | 'provider' | 'startedAt' | 'createdAt'>; className?: string }) {
  const durations = useJobDurations();
  const active = job.state === 'queued' || job.state === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!active) return null;

  if (job.state === 'queued') {
    return (
      <div className={clsx('text-[11.5px] text-faint', className)} role="status">
        Queued — waiting for another AI job to finish…
      </div>
    );
  }

  const started = Date.parse(job.startedAt ?? job.createdAt);
  const elapsed = Number.isFinite(started) ? now - started : 0;
  const est = estimateFor(durations.data, job.kind, job.provider);
  const view = etaView(elapsed, est);
  const pct = view.fraction == null ? null : Math.round(view.fraction * 100);
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      <div
        className="relative h-1 overflow-hidden rounded-full bg-sunken"
        role="progressbar"
        aria-label="Estimated progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={view.label || `${formatDuration(elapsed)} elapsed`}
      >
        {pct == null ? (
          <div className="absolute inset-y-0 w-1/3 animate-pulse rounded-full bg-accent/60" />
        ) : (
          <div className={clsx('h-full rounded-full transition-[width] duration-1000 ease-linear', view.overdue ? 'animate-pulse bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
        )}
      </div>
      <div className="flex items-center gap-2 text-[11.5px] text-faint">
        <span className="tabular">{formatDuration(elapsed)} elapsed</span>
        {view.label && <span className={clsx('ml-auto', view.overdue && 'text-warn')}>{view.label}</span>}
        {est && !view.overdue && (
          <span className="sr-only">
            Based on {est.samples} earlier run{est.samples === 1 ? '' : 's'}
            {est.basis === 'kind' ? ' with any provider' : ''}.
          </span>
        )}
      </div>
    </div>
  );
}

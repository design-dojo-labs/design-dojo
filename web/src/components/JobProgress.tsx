import type { Job } from '@lld/shared';
import { useState } from 'react';
import { post, errorMessage } from '../lib/api';
import { isActiveJob, useJob } from '../lib/queries';
import { Button, Spinner, useToast } from './ui';
import { JobEta } from './JobEta';
import { formatDuration } from '../lib/format';

const ERROR_HELP: Partial<Record<string, string>> = {
  'auth-failed': 'Open Settings to reconnect the provider, then retry.',
  'auth-blocked': 'Subscription mode refused an API-key login. Reconnect with your subscription or switch to API-key mode in Settings.',
  'rate-limited': 'Your plan’s usage limit was reached. Wait for it to reset, then retry.',
  timeout: 'You can raise the request timeout in Settings.',
  'not-installed': 'Install the CLI or set its path in Settings.',
  'provider-disabled': 'Select a provider in Settings.',
  'malformed-output': 'The provider answered in an unexpected format. Retrying usually helps.',
  'validation-failed': 'The answer failed validation, so nothing was saved. Retrying usually helps.',
  interrupted: 'The server stopped during this job.',
};

/** Live status of a background job with cancel, and an explicit error state (never a fake result). */
export function JobProgress({ jobId, title, onRetry, compact }: { jobId: string; title: string; onRetry?: () => void; compact?: boolean }) {
  const job = useJob(jobId).data;
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  if (!job) return null;
  const active = isActiveJob(job);
  const generation = job.kind === 'generate' || job.kind === 'hld-generate';
  const last = job.progress.slice(compact ? -1 : -4);
  return (
    <div className="rounded-[6px] border border-line bg-panel px-3 py-2 text-[13px]" aria-live="polite">
      <div className="flex items-center gap-2">
        {active && <Spinner className="size-3.5" />}
        <span className="font-medium">{title}</span>
        <JobStateText job={job} />
        <span className="ml-auto" />
        {active && (
          <Button
            size="sm"
            variant="ghost"
            busy={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await post(`/api/jobs/${job.id}/cancel`);
              } catch (e) {
                toast('err', errorMessage(e));
              } finally {
                setCancelling(false);
              }
            }}
          >
            Cancel
          </Button>
        )}
        {!active && job.state !== 'completed' && onRetry && (
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
      {active && last.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 text-[12px] text-muted">
          {last.map((p, i) => (
            <li key={i} className={generation ? 'break-words' : 'truncate'}>
              {p.message}
            </li>
          ))}
        </ul>
      )}
      {generation && active && <JobEta job={job} className="mt-2" />}
      {generation && !active && job.finishedAt && (
        <p className="mt-1 text-[12px] text-muted">
          Total time: {formatDuration(Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.createdAt)))}
        </p>
      )}
      {generation && job.progress.length > 0 && (
        <details className="mt-2 text-[12px] text-muted">
          <summary className="cursor-pointer">Timing and validation details</summary>
          <ol className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
            {job.progress.map((p, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="tabular shrink-0 text-faint">{formatDuration(Math.max(0, Date.parse(p.at) - Date.parse(job.createdAt)))}</span>
                <span className="min-w-0 break-words">{p.message}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {job.error && job.state !== 'cancelled' && (
        <div className="mt-1.5 text-[12.5px]">
          <div className="text-err">{job.error.message}</div>
          {job.error.details?.length ? (
            <ul className="mt-1 list-disc pl-4 text-[12px] text-muted">
              {job.error.details.slice(0, 8).map((d, i) => (
                <li key={i} className="break-words">
                  {d}
                </li>
              ))}
            </ul>
          ) : null}
          {ERROR_HELP[job.error.code] && <div className="mt-1 text-muted">{ERROR_HELP[job.error.code]}</div>}
        </div>
      )}
    </div>
  );
}

export function JobStateText({ job }: { job: Job }) {
  const map: Record<Job['state'], [string, string]> = {
    queued: ['Queued', 'text-muted'],
    running: ['Running', 'text-accent'],
    completed: ['Done', 'text-ok'],
    failed: ['Failed', 'text-err'],
    cancelled: ['Cancelled', 'text-muted'],
    interrupted: ['Interrupted', 'text-err'],
  };
  const [t, c] = map[job.state];
  return <span className={`text-[12px] ${c}`}>{t}</span>;
}

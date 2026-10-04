import { useQuery } from '@tanstack/react-query';
import type { JobDurationStats, JobKind } from '@lld/shared';
import { get } from './api';

/** Historical durations of completed jobs (median/p90 per kind and provider), refreshed about once a minute. */
export function useJobDurations() {
  return useQuery({
    queryKey: ['job-durations'],
    queryFn: () => get<JobDurationStats[]>('/api/jobs/durations'),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
  });
}

export interface DurationEstimate {
  medianMs: number;
  p90Ms: number;
  samples: number;
  /** Whether the estimate comes from the same provider or from any provider for this kind. */
  basis: 'provider' | 'kind';
}

/**
 * Best available estimate for a job: the same kind and provider first; otherwise the kind across
 * providers (the group with the most samples). Null when this kind never completed before.
 */
export function estimateFor(stats: readonly JobDurationStats[] | undefined, kind: JobKind, provider: string | null): DurationEstimate | null {
  if (!stats?.length) return null;
  const exact = stats.find((s) => s.kind === kind && s.provider === provider && s.samples > 0);
  if (exact) return { medianMs: exact.medianMs, p90Ms: Math.max(exact.p90Ms, exact.medianMs), samples: exact.samples, basis: 'provider' };
  const sameKind = stats.filter((s) => s.kind === kind && s.samples > 0).sort((a, b) => b.samples - a.samples);
  if (!sameKind.length) return null;
  const best = sameKind[0];
  return { medianMs: best.medianMs, p90Ms: Math.max(best.p90Ms, best.medianMs), samples: best.samples, basis: 'kind' };
}

export interface EtaView {
  /** 0..1 for the bar, or null when there is no estimate (indeterminate bar). */
  fraction: number | null;
  /** Short status text such as "~40s left". Empty when there is no estimate. */
  label: string;
  overdue: boolean;
}

/** Formats a remaining duration roughly: seconds below 90 s, then minutes. */
export function formatRemaining(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `~${s}s left`;
  return `~${Math.round(s / 60)} min left`;
}

/**
 * Progress shown for a running job. The bar never claims to be finished: it fills to 90% at the
 * median, creeps towards 97% until p90, and past p90 says the run is taking longer than usual.
 */
export function etaView(elapsedMs: number, est: DurationEstimate | null): EtaView {
  if (!est || est.medianMs <= 0) return { fraction: null, label: '', overdue: false };
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed < est.medianMs) {
    return { fraction: Math.min(0.9, (elapsed / est.medianMs) * 0.9), label: formatRemaining(est.medianMs - elapsed), overdue: false };
  }
  if (elapsed < est.p90Ms) {
    const span = Math.max(1, est.p90Ms - est.medianMs);
    return { fraction: 0.9 + 0.07 * ((elapsed - est.medianMs) / span), label: 'almost done', overdue: false };
  }
  return { fraction: 0.97, label: 'taking longer than usual', overdue: true };
}

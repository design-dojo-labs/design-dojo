import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { InterviewSession, Job, ReviewInteractive, ReviewThread, ReviewTrack } from '@lld/shared';
import { get, post, put } from './api';
import { useServerEvents } from './events';
import { useJobPartials } from '../components/LiveReview';

const INTERACTIVE_KINDS = new Set(['chat', 'fix-suggestion', 'interview']);
const base = (track: ReviewTrack, submissionId: string) => (track === 'lld' ? `/api/submissions/${submissionId}` : `/api/hld/submissions/${submissionId}`);
export const interactiveKey = (track: ReviewTrack, submissionId: string) => ['interactive', track, submissionId] as const;

/**
 * Follow-up threads, fix suggestions, "I fixed this" marks and the mock interview for the latest
 * review of one submission. Refreshes itself when one of its jobs changes state or the review changes.
 */
export function useReviewInteractive(track: ReviewTrack, submissionId: string | null | undefined) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: interactiveKey(track, submissionId ?? ''),
    queryFn: () => get<ReviewInteractive>(`${base(track, submissionId!)}/interactive`),
    enabled: !!submissionId,
  });
  useServerEvents((e) => {
    if (!submissionId) return;
    const mine =
      (e.type === 'job' && e.job.submissionId === submissionId && (INTERACTIVE_KINDS.has(e.job.kind) || e.job.state !== 'running')) ||
      (e.type === 'submission' && e.submission.id === submissionId) ||
      (e.type === 'hld-submission' && e.submissionId === submissionId);
    if (mine) void qc.invalidateQueries({ queryKey: interactiveKey(track, submissionId) });
  });
  const refresh = () => qc.invalidateQueries({ queryKey: interactiveKey(track, submissionId ?? '') });
  return { ...q, refresh };
}

export function askAbout(track: ReviewTrack, submissionId: string, itemKey: string, message: string) {
  return post<{ thread: ReviewThread; job: Job }>(`${base(track, submissionId)}/threads`, { itemKey, message });
}

export function setMark(track: ReviewTrack, submissionId: string, itemKey: string, resolved: boolean) {
  return put<Record<string, boolean>>(`${base(track, submissionId)}/marks`, { itemKey, resolved });
}

export function requestFix(submissionId: string, findingId: string) {
  return post<Job>(`/api/submissions/${submissionId}/findings/${encodeURIComponent(findingId)}/fix`);
}

export function startInterview(track: ReviewTrack, submissionId: string, restart = false) {
  return post<InterviewSession>(`${base(track, submissionId)}/interview`, { restart });
}

export function answerInterview(interviewId: string, answer: string) {
  return post<{ interview: InterviewSession; job: Job }>(`/api/interviews/${interviewId}/answer`, { answer });
}

export function endInterview(interviewId: string) {
  return post<InterviewSession>(`/api/interviews/${interviewId}/end`);
}

/** Streamed (partial, unvalidated) structured answer of a running chat / fix / interview job. */
export function useAnswerPartial(jobId: string | null | undefined): Record<string, unknown> | undefined {
  return (useJobPartials(jobId) as Record<string, Record<string, unknown> | undefined>).answer;
}

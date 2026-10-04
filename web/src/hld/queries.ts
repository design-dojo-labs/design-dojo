import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { HldProblemPublic, HldProblemSummary, HldSession, HldSessionSummary, HldSubmission, ServerEvent } from '@lld/shared';
import { get, qs } from '../lib/api';

export const hk = {
  problems: (f: object) => ['hld-problems', f] as const,
  problem: (id: string) => ['hld-problem', id] as const,
  sessions: ['hld-sessions'] as const,
  session: (id: string) => ['hld-session', id] as const,
  submissions: (sid: string) => ['hld-submissions', sid] as const,
  stats: ['hld-stats'] as const,
};

export const useHldProblems = (f: { difficulty?: string; target?: string; domain?: string }) =>
  useQuery({ queryKey: hk.problems(f), queryFn: () => get<HldProblemSummary[]>(`/api/hld/problems${qs(f)}`) });
export const useHldProblem = (id: string) => useQuery({ queryKey: hk.problem(id), queryFn: () => get<HldProblemPublic>(`/api/hld/problems/${encodeURIComponent(id)}`) });
export const useHldSessions = () => useQuery({ queryKey: hk.sessions, queryFn: () => get<HldSessionSummary[]>('/api/hld/sessions') });
export const useHldSession = (id: string) => useQuery({ queryKey: hk.session(id), queryFn: () => get<HldSession>(`/api/hld/sessions/${id}`), staleTime: Infinity });
export const useHldSubmissions = (sid: string) => useQuery({ queryKey: hk.submissions(sid), queryFn: () => get<HldSubmission[]>(`/api/hld/sessions/${sid}/submissions`) });
export const useHldStats = () => useQuery({ queryKey: hk.stats, queryFn: () => get<{ recent: { at: string; score: number; title: string; sessionId: string }[] }>('/api/hld/stats') });

export function applyHldEvent(qc: QueryClient, ev: ServerEvent): void {
  if (ev.type === 'hld-submission') {
    qc.invalidateQueries({ queryKey: hk.submissions(ev.sessionId) });
    qc.invalidateQueries({ queryKey: hk.stats });
    qc.invalidateQueries({ queryKey: hk.sessions });
  } else if (ev.type === 'job' && ev.job.kind === 'hld-review' && ev.job.sessionId && !['queued', 'running'].includes(ev.job.state)) {
    qc.invalidateQueries({ queryKey: hk.submissions(ev.job.sessionId) });
    // The evaluation guide is revealed after the first submission.
    qc.invalidateQueries({ queryKey: ['hld-session-meta', ev.job.sessionId] });
  } else if (ev.type === 'job' && ev.job.kind === 'hld-generate' && !['queued', 'running'].includes(ev.job.state)) {
    qc.invalidateQueries({ queryKey: ['hld-problems'] });
  }
}

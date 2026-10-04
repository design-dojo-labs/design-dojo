import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  ApiKeyInfo,
  JavaStatus,
  Job,
  LoginState,
  ProblemSummary,
  ProblemVersion,
  ProviderStatus,
  ReferenceSolution,
  Hint,
  ServerEvent,
  Session,
  SessionSummary,
  Settings,
  Stats,
  Submission,
  SubmissionSummary,
} from '@lld/shared';
import { get, qs } from './api';

export const qk = {
  settings: ['settings'] as const,
  providers: ['providers'] as const,
  java: ['java'] as const,
  problems: (f: object) => ['problems', f] as const,
  problem: (id: string, v?: number) => ['problem', id, v ?? 'latest'] as const,
  sessions: ['sessions'] as const,
  session: (id: string) => ['session', id] as const,
  submissions: (sid: string) => ['submissions', sid] as const,
  submission: (id: string) => ['submission', id] as const,
  recentSubmissions: ['recent-submissions'] as const,
  hints: (sid: string) => ['hints', sid] as const,
  reference: (sid: string) => ['reference', sid] as const,
  stats: ['stats'] as const,
  job: (id: string) => ['job', id] as const,
  login: (p: string) => ['login', p] as const,
  apiKey: (p: string) => ['api-key', p] as const,
};

export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => get<Settings>('/api/settings') });
export const useProviders = () => useQuery({ queryKey: qk.providers, queryFn: () => get<ProviderStatus[]>('/api/status/providers'), staleTime: 30_000 });
export const useJava = () => useQuery({ queryKey: qk.java, queryFn: () => get<JavaStatus>('/api/status/java'), staleTime: 30_000 });
export const useProblems = (f: { difficulty?: string; target?: string; topic?: string }) =>
  useQuery({ queryKey: qk.problems(f), queryFn: () => get<ProblemSummary[]>(`/api/problems${qs(f)}`) });
export const useProblem = (id: string, version?: number) =>
  useQuery({ queryKey: qk.problem(id, version), queryFn: () => get<ProblemVersion>(`/api/problems/${encodeURIComponent(id)}${qs({ version })}`) });
export const useSessions = () => useQuery({ queryKey: qk.sessions, queryFn: () => get<SessionSummary[]>('/api/sessions') });
export const useSession = (id: string) => useQuery({ queryKey: qk.session(id), queryFn: () => get<Session>(`/api/sessions/${id}`) });
export const useSubmissions = (sid: string) => useQuery({ queryKey: qk.submissions(sid), queryFn: () => get<SubmissionSummary[]>(`/api/sessions/${sid}/submissions`) });
export const useSubmission = (id: string | null) =>
  useQuery({ queryKey: qk.submission(id ?? ''), queryFn: () => get<Submission>(`/api/submissions/${id}`), enabled: !!id });
export const useRecentSubmissions = () =>
  useQuery({ queryKey: qk.recentSubmissions, queryFn: () => get<(SubmissionSummary & { problemTitle: string })[]>('/api/submissions/recent') });
export const useHints = (sid: string) => useQuery({ queryKey: qk.hints(sid), queryFn: () => get<Hint[]>(`/api/sessions/${sid}/hints`) });
export const useReference = (sid: string) => useQuery({ queryKey: qk.reference(sid), queryFn: () => get<ReferenceSolution | null>(`/api/sessions/${sid}/reference`) });
export const useStats = () => useQuery({ queryKey: qk.stats, queryFn: () => get<Stats>('/api/stats') });
export const useJob = (id: string | null | undefined) =>
  useQuery({ queryKey: qk.job(id ?? ''), queryFn: () => get<Job>(`/api/jobs/${id}`), enabled: !!id });
export const useLogin = (p: 'claude' | 'codex' | 'gemini') => useQuery({ queryKey: qk.login(p), queryFn: () => get<LoginState>(`/api/providers/${p}/login`) });
export const useApiKey = (p: 'claude' | 'codex' | 'gemini') => useQuery({ queryKey: qk.apiKey(p), queryFn: () => get<ApiKeyInfo>(`/api/providers/${p}/api-key`) });

export const isActiveJob = (j: Job | null | undefined) => !!j && (j.state === 'queued' || j.state === 'running');

/** Applies server push events to the query cache so every view stays live without polling. */
export function applyServerEvent(qc: QueryClient, ev: ServerEvent): void {
  if (ev.type === 'job') {
    qc.setQueryData(qk.job(ev.job.id), ev.job);
    if (isActiveJob(ev.job)) return;
    switch (ev.job.kind) {
      case 'review':
        if (ev.job.sessionId) {
          qc.invalidateQueries({ queryKey: qk.submissions(ev.job.sessionId) });
          qc.invalidateQueries({ queryKey: qk.session(ev.job.sessionId) });
        }
        if (ev.job.submissionId) qc.invalidateQueries({ queryKey: qk.submission(ev.job.submissionId) });
        qc.invalidateQueries({ queryKey: qk.stats });
        qc.invalidateQueries({ queryKey: qk.recentSubmissions });
        qc.invalidateQueries({ queryKey: qk.sessions });
        break;
      case 'hint':
        if (ev.job.sessionId) {
          qc.invalidateQueries({ queryKey: qk.hints(ev.job.sessionId) });
          qc.invalidateQueries({ queryKey: qk.session(ev.job.sessionId) });
        }
        break;
      case 'reference':
        if (ev.job.sessionId) {
          qc.invalidateQueries({ queryKey: qk.reference(ev.job.sessionId) });
          qc.invalidateQueries({ queryKey: qk.session(ev.job.sessionId) });
        }
        break;
      case 'generate':
        qc.invalidateQueries({ queryKey: ['problems'] });
        break;
      case 'connection-test':
        qc.invalidateQueries({ queryKey: qk.providers });
        break;
      case 'toolchain-bootstrap':
        qc.invalidateQueries({ queryKey: qk.java });
        break;
    }
  } else if (ev.type === 'submission') {
    qc.invalidateQueries({ queryKey: qk.submissions(ev.submission.sessionId) });
    qc.invalidateQueries({ queryKey: qk.submission(ev.submission.id) });
  } else if (ev.type === 'login') {
    qc.setQueryData(qk.login(ev.login.provider), ev.login);
    if (ev.login.state !== 'running') qc.invalidateQueries({ queryKey: qk.providers });
  }
}

export function useQc() {
  return useQueryClient();
}

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import clsx from 'clsx';
import { Dices, Play, Sparkles } from 'lucide-react';
import { DIFFICULTIES, HLD_DOMAINS, HLD_DOMAIN_LABELS, TARGET_LABELS, TARGETS, type Difficulty, type HldProblemSummary, type Job, type Target } from '@lld/shared';
import { PageShell } from '../components/Shell';
import { Badge, Button, EmptyState, inputClass, Segmented, Spinner, useToast } from '../components/ui';
import { JobProgress } from '../components/JobProgress';
import { ProblemIdea } from '../components/ProblemIdea';
import { errorMessage, post } from '../lib/api';
import { aiReadiness } from '../lib/practice';
import { isActiveJob, useJob, useProviders, useSettings } from '../lib/queries';
import { DIFFICULTY_LABEL, formatDuration, relativeTime } from '../lib/format';
import { elapsed } from '../workspace/timer';
import { ScoreBadge } from '../pages/Dashboard';
import { useHldProblems, useHldSessions, useHldStats } from './queries';
import { ensureNotificationPermission } from '../lib/notify';

interface Filters {
  difficulty: Difficulty;
  target: Target;
  domain: string;
}

function useFilters(): [Filters, (p: Partial<Filters>) => void] {
  const [f, setF] = useState<Filters>(() => {
    try {
      return { difficulty: 'medium', target: 'sde2', domain: '', ...JSON.parse(localStorage.getItem('lld.hldFilters') ?? '{}') };
    } catch {
      return { difficulty: 'medium', target: 'sde2', domain: '' };
    }
  });
  return [
    f,
    (p) =>
      setF((x) => {
        const n = { ...x, ...p };
        try {
          localStorage.setItem('lld.hldFilters', JSON.stringify(n));
        } catch {
          /* ignore */
        }
        return n;
      }),
  ];
}

export function HldDashboard() {
  const [f, setF] = useFilters();
  const navigate = useNavigate();
  const toast = useToast();
  const settings = useSettings();
  const providers = useProviders();
  const ai = aiReadiness(settings.data, providers.data);
  const [jobId, setJobId] = useState<string | null>(() => sessionStorage.getItem('lld.hldGenJob'));
  const job = useJob(jobId).data;
  const bank = useHldProblems({ difficulty: f.difficulty, target: f.target, domain: f.domain || undefined });
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState('');
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    setGenerating(true);
    void ensureNotificationPermission(); // generation takes a while; ask now so "question ready" can notify
    try {
      const j = await post<Job>('/api/hld/problems/generate', { difficulty: f.difficulty, target: f.target, domain: f.domain || undefined, theme: theme.trim() || undefined });
      setJobId(j.id);
      sessionStorage.setItem('lld.hldGenJob', j.id);
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };
  const random = async () => {
    setBusy(true);
    try {
      const p = await post<HldProblemSummary>('/api/hld/problems/random', { difficulty: f.difficulty, target: f.target, domain: f.domain || undefined });
      navigate(`/hld/problems/${encodeURIComponent(p.id)}`);
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const result = job?.state === 'completed' ? (job.result as { problemId: string; title: string; isMock?: boolean }) : null;

  return (
    <PageShell>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section>
          <h1 className="text-[22px] font-semibold tracking-tight">High-level design practice</h1>
          <p className="mt-1 max-w-[64ch] text-muted">
            Get a system design question for your level. Write the requirements and estimates, design the API and data model, draw the architecture, then submit for review.
          </p>
          <div className="mt-5 grid max-w-[640px] grid-cols-[7.5rem_1fr] items-center gap-x-4 gap-y-3">
            <span className="text-[13px] text-muted">Difficulty</span>
            <Segmented label="Difficulty" value={f.difficulty} onChange={(v) => setF({ difficulty: v })} options={DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_LABEL[d] }))} />
            <span className="text-[13px] text-muted">Your experience</span>
            <Segmented label="Experience" value={f.target} onChange={(v) => setF({ target: v })} options={TARGETS.map((t) => ({ value: t, label: TARGET_LABELS[t] }))} />
            <label htmlFor="hld-domain" className="text-[13px] text-muted">
              Domain
            </label>
            <select id="hld-domain" className={clsx(inputClass, 'w-64')} value={f.domain} onChange={(e) => setF({ domain: e.target.value })}>
              <option value="">Any domain</option>
              {HLD_DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {HLD_DOMAIN_LABELS[d]}
                </option>
              ))}
            </select>
          </div>
          <ProblemIdea value={theme} onChange={setTheme} disabled={generating || isActiveJob(job)} />
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Sparkles className="size-4" />} busy={generating} disabled={!ai.ready || isActiveJob(job)} title={ai.reason ?? undefined} onClick={generate}>
              {theme.trim() ? 'Generate from my idea' : `Generate a question with ${ai.label || 'AI'}`}
            </Button>
            <Button icon={<Dices className="size-4" />} busy={busy} disabled={bank.data?.length === 0} onClick={random}>
              Random from the bank
            </Button>
          </div>
          <p className="mt-2 max-w-[64ch] text-[12.5px] text-faint">
            {ai.ready
              ? `A fresh question is written for ${DIFFICULTY_LABEL[f.difficulty].toLowerCase()} difficulty at the ${TARGET_LABELS[f.target]} level, validated and saved. Your idea and settings are sent to ${ai.label}; it needs internet and counts against your plan.`
              : `AI generation unavailable: ${ai.reason}`}{' '}
            {bank.data && `${bank.data.length} bank question${bank.data.length === 1 ? '' : 's'} match these filters.`}
          </p>
          {jobId && (
            <div className="mt-3 max-w-[640px]">
              <JobProgress jobId={jobId} title="Writing a system design question" onRetry={generate} />
              {result && (
                <div className="mt-2 flex items-center gap-2 text-[13px]">
                  Created “{result.title}”{result.isMock ? ' (mock)' : ''}.
                  <Button size="sm" variant="primary" onClick={() => navigate(`/hld/problems/${encodeURIComponent(result.problemId)}`)}>
                    Open question
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setJobId(null);
                      sessionStorage.removeItem('lld.hldGenJob');
                    }}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
          )}
          <InProgress />
          <section className="mt-10">
            <h2 className="mb-2 text-[15px] font-semibold">Question bank</h2>
            {bank.isLoading ? (
              <Spinner />
            ) : !bank.data?.length ? (
              <EmptyState title="No questions match these filters">Generate one with AI, or change the difficulty, experience or domain.</EmptyState>
            ) : (
              <ul className="divide-y divide-line rounded-[6px] border border-line bg-panel">
                {bank.data.map((p) => (
                  <li key={p.id}>
                    <Link to={`/hld/problems/${encodeURIComponent(p.id)}`} className="flex items-center gap-3 px-3 py-2 hover:bg-sunken">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{p.title}</span>
                          {p.source === 'generated' && <Badge tone="info">AI-generated</Badge>}
                        </div>
                        <div className="truncate text-[12.5px] text-muted">{p.summary}</div>
                      </div>
                      <Badge>{DIFFICULTY_LABEL[p.difficulty]}</Badge>
                      <span className="hidden w-28 text-[12px] text-faint sm:block">{HLD_DOMAIN_LABELS[p.domain]}</span>
                      <span className="w-10 text-right">{p.bestScore != null ? <ScoreBadge score={p.bestScore} /> : null}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>
        <aside className="lg:border-l lg:border-line lg:pl-8">
          <Recent />
        </aside>
      </div>
    </PageShell>
  );
}

function InProgress() {
  const sessions = useHldSessions().data ?? [];
  if (!sessions.length) return null;
  return (
    <section className="mt-10">
      <h2 className="mb-2 text-[15px] font-semibold">Continue where you left off</h2>
      <ul className="divide-y divide-line rounded-[6px] border border-line bg-panel">
        {sessions.slice(0, 5).map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{s.problemTitle}</div>
              <div className="text-[12px] text-muted">
                {DIFFICULTY_LABEL[s.difficulty]}, {formatDuration(elapsed(s.timer))}
                {s.timer.durationMinutes ? ` of ${s.timer.durationMinutes} min` : ' elapsed'}, {s.submissionCount} submission{s.submissionCount === 1 ? '' : 's'}, updated {relativeTime(s.updatedAt)}
              </div>
            </div>
            {s.latestScore != null && <ScoreBadge score={s.latestScore} />}
            <Link to={`/hld/session/${s.id}`}>
              <Button size="sm" icon={<Play className="size-3.5" />}>
                Resume
              </Button>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Recent() {
  const stats = useHldStats().data;
  const rows = stats?.recent ?? [];
  return (
    <div>
      <h2 className="text-[15px] font-semibold">Your HLD reviews</h2>
      {!rows.length ? (
        <p className="mt-2 text-[13px] text-muted">No reviewed designs yet. Scores appear here after your first review.</p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <dt className="text-[12px] text-muted">Reviewed designs</dt>
              <dd className="tabular text-[26px] font-semibold">{rows.length}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted">Average score</dt>
              <dd className="tabular text-[26px] font-semibold">{Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length)}</dd>
            </div>
          </dl>
          <ul className="mt-4 flex flex-col gap-1.5 text-[13px]">
            {rows.slice(0, 10).map((r, i) => (
              <li key={i} className="flex items-center gap-2">
                <Link to={`/hld/session/${r.sessionId}`} className="min-w-0 flex-1 truncate hover:underline">
                  {r.title}
                </Link>
                <span className="text-[12px] text-faint">{relativeTime(r.at)}</span>
                <ScoreBadge score={r.score} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

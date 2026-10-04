import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import clsx from 'clsx';
import { Dices, Sparkles, Play } from 'lucide-react';
import { DIFFICULTIES, TARGET_LABELS, TARGETS, TOPIC_LABELS, TOPICS, type Job, type ProblemSummary, type Topic } from '@lld/shared';
import { PageShell } from '../components/Shell';
import { Badge, Button, EmptyState, ErrorNote, inputClass, Segmented, Spinner, useToast } from '../components/ui';
import { CategoryBars, ScoreHistoryChart } from '../components/charts';
import { JobProgress } from '../components/JobProgress';
import { ProblemIdea } from '../components/ProblemIdea';
import { errorMessage, post } from '../lib/api';
import { aiReadiness, usePracticeFilters } from '../lib/practice';
import { isActiveJob, useJob, useProblems, useProviders, useRecentSubmissions, useSessions, useSettings, useStats } from '../lib/queries';
import { DIFFICULTY_LABEL, formatDuration, relativeTime, scoreTone } from '../lib/format';
import { elapsed } from '../workspace/timer';
import { ensureNotificationPermission } from '../lib/notify';

export function Dashboard() {
  const [f, setF] = usePracticeFilters();
  const navigate = useNavigate();
  const toast = useToast();
  const settings = useSettings();
  const providers = useProviders();
  const ai = aiReadiness(settings.data, providers.data);
  const [genJobId, setGenJobId] = useState<string | null>(() => sessionStorage.getItem('lld.genJob'));
  const genJob = useJob(genJobId).data;
  const [randomBusy, setRandomBusy] = useState(false);
  const [theme, setTheme] = useState('');
  const [generating, setGenerating] = useState(false);

  const matching = useProblems({ difficulty: f.difficulty, target: f.target, topic: f.topic || undefined });
  const matchCount = matching.data?.length ?? null;
  const previewUrl = (id: string) => `/problems/${encodeURIComponent(id)}?mode=${f.mode}&duration=${f.duration ?? 'untimed'}`;
  const startRandom = async () => {
    setRandomBusy(true);
    try {
      const p = await post<ProblemSummary>('/api/problems/random', { difficulty: f.difficulty, target: f.target, topic: f.topic || undefined });
      navigate(previewUrl(p.id));
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setRandomBusy(false);
    }
  };
  const generate = async () => {
    setGenerating(true);
    void ensureNotificationPermission(); // generation takes a while; ask now so "problem ready" can notify
    try {
      const job = await post<Job>('/api/problems/generate', { difficulty: f.difficulty, target: f.target, topic: f.topic || undefined, durationMinutes: f.duration, theme: theme.trim() || undefined });
      setGenJobId(job.id);
      sessionStorage.setItem('lld.genJob', job.id);
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };
  const genResult = genJob?.state === 'completed' ? (genJob.result as { problemId: string; title: string; isMock?: boolean }) : null;

  return (
    <PageShell>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section aria-labelledby="start-h">
          <h1 id="start-h" className="text-[22px] font-semibold tracking-tight">
            Low-level design practice
          </h1>
          <p className="mt-1 max-w-[62ch] text-muted">
            Pick a problem, read the requirements and the rubric, then build a complete Java solution and submit it for an AI practice assessment.
          </p>
          <div className="mt-5 grid max-w-[640px] grid-cols-[7.5rem_1fr] items-center gap-x-4 gap-y-3">
            <span className="text-[13px] text-muted">Difficulty</span>
            <Segmented label="Difficulty" value={f.difficulty} onChange={(v) => setF({ difficulty: v })} options={DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_LABEL[d] }))} />
            <span className="text-[13px] text-muted">Interview level</span>
            <Segmented label="Interview level" value={f.target} onChange={(v) => setF({ target: v })} options={TARGETS.map((t) => ({ value: t, label: TARGET_LABELS[t] }))} />
            <label htmlFor="topic" className="text-[13px] text-muted">
              Topic
            </label>
            <select id="topic" className={clsx(inputClass, 'w-64')} value={f.topic} onChange={(e) => setF({ topic: e.target.value as Topic | '' })}>
              <option value="">Any topic</option>
              {TOPICS.map((t) => (
                <option key={t} value={t}>
                  {TOPIC_LABELS[t]}
                </option>
              ))}
            </select>
            <span className="text-[13px] text-muted">Time limit</span>
            <Segmented
              label="Time limit"
              value={f.duration ?? 0}
              onChange={(v) => setF({ duration: v === 0 ? null : v, mode: v === 0 && f.mode === 'interview' ? 'practice' : f.mode })}
              options={[30, 45, 60, 90].map((d) => ({ value: d, label: `${d} min` })).concat([{ value: 0, label: 'Untimed' }])}
            />
            <span className="text-[13px] text-muted">Mode</span>
            <div className="flex flex-col gap-1">
              <Segmented
                label="Mode"
                value={f.mode}
                onChange={(v) => setF({ mode: v, duration: v === 'interview' && f.duration == null ? 60 : f.duration })}
                options={[
                  { value: 'practice', label: 'Practice', title: 'Pause the timer and ask for progressive hints' },
                  { value: 'interview', label: 'Interview', title: 'Timer cannot be paused; AI hints are off' },
                ]}
              />
              <span className="text-[12px] text-faint">
                {f.mode === 'practice' ? 'Timer can be paused; progressive AI hints are available.' : 'Timer runs continuously; AI hints are disabled until you submit.'}
              </span>
            </div>
          </div>
          <ProblemIdea value={theme} onChange={setTheme} disabled={generating || isActiveJob(genJob)} />
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Dices className="size-4" />} busy={randomBusy} disabled={matchCount === 0} onClick={startRandom}>
              Pick a random problem
            </Button>
            <Button icon={<Sparkles className="size-4" />} busy={generating} disabled={!ai.ready || isActiveJob(genJob)} onClick={generate} title={ai.reason ?? undefined}>
              {theme.trim() ? 'Generate from my idea' : `Generate a new problem with ${ai.label || 'AI'}`}
            </Button>
          </div>
          {matchCount != null && (
            <p className="mt-2 text-[12.5px] text-muted" data-testid="match-count">
              {matchCount === 0
                ? 'No bundled or saved problems match this difficulty, level and topic. Change a filter or generate a new problem.'
                : `${matchCount} problem${matchCount === 1 ? '' : 's'} match these filters.`}
            </p>
          )}
          {!ai.ready && ai.reason && (
            <p className="mt-2 max-w-[62ch] text-[12.5px] text-faint">
              AI generation unavailable: {ai.reason}{' '}
              <Link to="/settings" className="text-focus underline">
                Settings
              </Link>
            </p>
          )}
          {ai.ready && (
            <p className="mt-2 max-w-[62ch] text-[12px] text-faint">Generation sends your idea, filter choices and existing problem titles to {ai.label}; it needs internet access and counts against your plan.</p>
          )}
          {genJobId && (
            <div className="mt-3 max-w-[640px]">
              <JobProgress jobId={genJobId} title="Generating a problem" onRetry={generate} />
              {genResult && (
                <div className="mt-2 flex items-center gap-2 text-[13px]">
                  <span>
                    Created “{genResult.title}”{genResult.isMock ? ' (mock)' : ''}.
                  </span>
                  <Button size="sm" variant="primary" onClick={() => navigate(previewUrl(genResult.problemId))}>
                    Open problem
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setGenJobId(null);
                      sessionStorage.removeItem('lld.genJob');
                    }}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
          )}

          <InProgress />
          <RecentSubmissions />
          <ProblemBank filters={f} previewUrl={previewUrl} />
        </section>

        <aside aria-labelledby="progress-h" className="lg:border-l lg:border-line lg:pl-8">
          <Progress />
        </aside>
      </div>
    </PageShell>
  );
}

function InProgress() {
  const sessions = useSessions();
  const active = (sessions.data ?? []).slice(0, 5);
  if (sessions.isLoading) return <Spinner className="mt-8" />;
  if (!active.length) return null;
  return (
    <section className="mt-10" aria-labelledby="resume-h">
      <h2 id="resume-h" className="mb-2 text-[15px] font-semibold">
        Continue where you left off
      </h2>
      <ul className="divide-y divide-line rounded-[6px] border border-line bg-panel">
        {active.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{s.problemTitle}</div>
              <div className="text-[12px] text-muted">
                {s.mode === 'interview' ? 'Interview' : 'Practice'}, {DIFFICULTY_LABEL[s.difficulty]}, {formatDuration(elapsed(s.timer))}
                {s.timer.durationMinutes ? ` of ${s.timer.durationMinutes} min` : ' elapsed'}, {s.submissionCount} submission{s.submissionCount === 1 ? '' : 's'}, updated {relativeTime(s.updatedAt)}
              </div>
            </div>
            {s.latestScore != null && <ScoreBadge score={s.latestScore} />}
            <Link to={`/session/${s.id}`}>
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

function RecentSubmissions() {
  const recent = useRecentSubmissions();
  const rows = recent.data ?? [];
  if (!rows.length) return null;
  return (
    <section className="mt-10" aria-labelledby="recent-h">
      <h2 id="recent-h" className="mb-2 text-[15px] font-semibold">
        Recent submissions
      </h2>
      <div className="overflow-x-auto rounded-[6px] border border-line bg-panel">
        <table className="w-full text-[13px]">
          <thead className="text-left text-[12px] text-muted">
            <tr className="border-b border-line">
              <th className="px-3 py-1.5 font-medium">Problem</th>
              <th className="px-3 py-1.5 font-medium">Build</th>
              <th className="px-3 py-1.5 font-medium">Tests</th>
              <th className="px-3 py-1.5 font-medium">Review</th>
              <th className="px-3 py-1.5 text-right font-medium">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((s) => (
              <tr key={s.id} className="border-b border-line last:border-0">
                <td className="px-3 py-1.5">
                  <Link className="hover:underline" to={`/session/${s.sessionId}?submission=${s.id}`}>
                    {s.problemTitle}
                  </Link>
                  <span className="ml-1.5 text-[12px] text-faint">
                    #{s.seq}, {relativeTime(s.createdAt)}
                  </span>
                </td>
                <td className="px-3 py-1.5">
                  <Badge tone={s.compile === 'passed' ? 'ok' : s.compile === 'failed' ? 'err' : 'neutral'}>{s.compile === 'passed' ? 'Compiled' : s.compile === 'failed' ? 'Failed' : s.compile}</Badge>
                </td>
                <td className="tabular px-3 py-1.5 text-muted">{s.tests ? `${s.tests.passed}/${s.tests.total} passed` : 'none ran'}</td>
                <td className="px-3 py-1.5 text-muted">
                  {s.reviewStatus}
                  {s.isMock ? ' (mock)' : ''}
                </td>
                <td className="px-3 py-1.5 text-right">{s.score != null ? <ScoreBadge score={s.score} /> : <span className="text-faint">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProblemBank({ filters, previewUrl }: { filters: { difficulty: string; target: string; topic: string }; previewUrl: (id: string) => string }) {
  const [showAll, setShowAll] = useState(false);
  const q = useProblems(showAll ? {} : { difficulty: filters.difficulty, target: filters.target, topic: filters.topic || undefined });
  const rows = q.data ?? [];
  return (
    <section className="mt-10" aria-labelledby="bank-h">
      <div className="mb-2 flex items-baseline gap-3">
        <h2 id="bank-h" className="text-[15px] font-semibold">
          Problem bank
        </h2>
        <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Ignore filters
        </label>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorNote>{errorMessage(q.error)}</ErrorNote>
      ) : !rows.length ? (
        <EmptyState title="No problems match these filters">Change the difficulty, level or topic, tick “Ignore filters”, or generate a new problem.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-[6px] border border-line bg-panel">
          {rows.map((p) => (
            <li key={p.id}>
              <Link to={previewUrl(p.id)} className="flex items-center gap-3 px-3 py-2 hover:bg-sunken">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.title}</span>
                    {p.source === 'generated' && <Badge tone="info">AI-generated</Badge>}
                  </div>
                  <div className="truncate text-[12.5px] text-muted">{p.summary}</div>
                </div>
                <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
                  <Badge>{DIFFICULTY_LABEL[p.difficulty]}</Badge>
                  <span className="tabular w-14 text-right text-[12px] text-faint">{p.estimatedMinutes} min</span>
                  <span className="w-20 text-right text-[12px] text-faint">{p.attempts ? `${p.attempts} attempt${p.attempts > 1 ? 's' : ''}` : 'new'}</span>
                  <span className="w-10 text-right">{p.bestScore != null ? <ScoreBadge score={p.bestScore} /> : null}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Progress() {
  const stats = useStats();
  const s = stats.data;
  return (
    <div>
      <h2 id="progress-h" className="text-[15px] font-semibold">
        Your progress
      </h2>
      {!s ? (
        <Spinner className="mt-3" />
      ) : s.reviewedSubmissions === 0 ? (
        <p className="mt-2 text-[13px] text-muted">
          No reviewed submissions yet. Scores and category trends appear here after your first AI review.
          {s.excludedMockReviews ? ` (${s.excludedMockReviews} mock review${s.excludedMockReviews > 1 ? 's are' : ' is'} excluded.)` : ''}
        </p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <Stat label="Problems completed" value={String(s.completedProblems)} />
            <Stat label="Average score" value={s.averageScore != null ? String(Math.round(s.averageScore)) : '–'} />
            <Stat label="Last 5 reviews" value={s.recentAverage != null ? String(Math.round(s.recentAverage)) : '–'} />
          </dl>
          <div className="mt-5">
            <ScoreHistoryChart history={s.history} />
          </div>
          {s.categories.length > 0 && (
            <div className="mt-6">
              <CategoryBars categories={s.categories} />
              {s.strongest && s.weakest && (
                <p className="mt-3 text-[12.5px] text-muted">
                  Strongest: <span className="text-ink">{s.strongest.label}</span>. Weakest: <span className="text-ink">{s.weakest.label}</span>.
                </p>
              )}
            </div>
          )}
          {s.designWeakSpots.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-1.5 text-[13px] font-medium">Design habits to work on</h3>
              <ul className="flex flex-col gap-1 text-[12.5px]">
                {s.designWeakSpots.map((w) => (
                  <li key={`${w.area}:${w.item}`} className="flex gap-2">
                    <span className="w-16 shrink-0 text-faint">{w.area}</span>
                    <span className="min-w-0 flex-1 truncate">{w.item}</span>
                    <span className="tabular shrink-0 text-muted">
                      {w.violated ? `${w.violated} violated` : ''}
                      {w.violated && w.partial ? ', ' : ''}
                      {w.partial ? `${w.partial} partial` : ''} of {w.samples}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-4 text-[12px] text-faint">
            Based on {s.reviewedSubmissions} reviewed submission{s.reviewedSubmissions > 1 ? 's' : ''} across {s.sessions} session{s.sessions > 1 ? 's' : ''}. {s.hintsUsed} hint
            {s.hintsUsed === 1 ? '' : 's'} used.{s.excludedMockReviews ? ` ${s.excludedMockReviews} mock review(s) excluded.` : ''} AI practice assessments, not interview verdicts.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="tabular text-[26px] leading-tight font-semibold">{value}</dd>
    </div>
  );
}

export function ScoreBadge({ score }: { score: number }) {
  const t = scoreTone(score);
  return <Badge tone={t === 'ok' ? 'ok' : t === 'warn' ? 'warn' : 'err'}>{score}</Badge>;
}

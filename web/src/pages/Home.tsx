import { Link } from 'react-router';
import { ArrowRight, Boxes, Code2, Flame, MessageSquare, PlayCircle, Sparkles, Target, Timer, Trophy, Wand2, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageShell } from '../components/Shell';
import { Badge } from '../components/ui';
import { useProviders, useSessions, useSettings, useStats } from '../lib/queries';
import { useHldSessions, useHldStats } from '../hld/queries';
import { relativeTime } from '../lib/format';
import { ScoreBadge } from './Dashboard';
import { APP_NAME } from '../lib/brand';


interface Activity {
  kind: 'LLD' | 'HLD';
  title: string;
  at: string;
  to: string;
  score: number | null;
}

/** Home: what to do next, how practice is going, and the two tracks. */
export function Home() {
  const lldStats = useStats().data;
  const lldSessions = useSessions().data ?? [];
  const hldStats = useHldStats().data;
  const hldSessions = useHldSessions().data ?? [];
  const settings = useSettings().data;
  const providers = useProviders().data;

  const lldScores = (lldStats?.history ?? []).map((h) => ({ kind: 'LLD' as const, title: h.problemTitle, at: h.at, to: `/session/${h.sessionId}?submission=${h.submissionId}`, score: h.score }));
  const hldScores = (hldStats?.recent ?? []).map((h) => ({ kind: 'HLD' as const, title: h.title, at: h.at, to: `/hld/session/${h.sessionId}`, score: h.score }));
  const reviews: Activity[] = [...lldScores, ...hldScores].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const inProgress: Activity[] = [
    ...lldSessions.map((s) => ({ kind: 'LLD' as const, title: s.problemTitle, at: s.updatedAt, to: `/session/${s.id}`, score: s.latestScore })),
    ...hldSessions.map((s) => ({ kind: 'HLD' as const, title: s.problemTitle, at: s.updatedAt, to: `/hld/session/${s.id}`, score: s.latestScore })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const latest = inProgress[0];

  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, v) => s + v, 0) / xs.length) : null);
  const recentAvg = avg(reviews.slice(0, 5).map((r) => r.score ?? 0));
  const best = reviews.length ? Math.max(...reviews.map((r) => r.score ?? 0)) : null;
  const streak = practiceStreak(reviews.map((r) => r.at));
  const selected = providers?.find((p) => p.id === settings?.provider);

  return (
    <PageShell>
      {/* Hero */}
      <section className="flex flex-wrap items-end gap-x-8 gap-y-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[28px] font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="mt-1 max-w-[70ch] text-[14px] text-muted">
            Practice low-level and high-level design interviews end to end: build or design, get a rubric-based AI review in about a minute, then dig into each finding until it sticks.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {latest && (
            <Link to={latest.to} className="inline-flex items-center gap-2 rounded-[6px] bg-ink px-3.5 py-2 text-[13px] font-medium text-canvas hover:opacity-90" data-testid="home-continue">
              <PlayCircle className="size-4" />
              Continue {latest.kind}: <span className="max-w-[22ch] truncate">{latest.title}</span>
            </Link>
          )}
          <Link to="/lld" className="inline-flex items-center gap-1.5 rounded-[6px] border border-line px-3 py-2 text-[13px] hover:border-line-strong">
            <Code2 className="size-4 text-accent" /> New LLD problem
          </Link>
          <Link to="/hld" className="inline-flex items-center gap-1.5 rounded-[6px] border border-line px-3 py-2 text-[13px] hover:border-line-strong">
            <Boxes className="size-4 text-accent" /> New HLD question
          </Link>
        </div>
      </section>

      {/* Progress tiles */}
      <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Your progress">
        <Tile icon={<Target className="size-4" />} label="Reviews" value={reviews.length ? String(reviews.length) : '—'} note={`${lldScores.length} LLD · ${hldScores.length} HLD`} />
        <Tile icon={<Zap className="size-4" />} label="Recent average" value={recentAvg != null ? `${recentAvg}` : '—'} note={recentAvg != null ? 'last 5 reviews, out of 100' : 'submit to get a score'} />
        <Tile icon={<Trophy className="size-4" />} label="Best score" value={best != null ? `${best}` : '—'} note={best != null ? reviews.find((r) => r.score === best)?.title ?? '' : 'no reviews yet'} />
        <Tile icon={<Flame className="size-4" />} label="Practice streak" value={streak ? `${streak} day${streak === 1 ? '' : 's'}` : '—'} note={streak ? 'days in a row with a review' : 'review something today to start one'} />
      </section>

      {/* Tracks */}
      <section className="mt-6 grid gap-5 md:grid-cols-2">
        <Track
          to="/lld"
          icon={<Code2 className="size-5" />}
          title="Low-level design"
          subtitle="Java machine coding"
          steps={['Read the requirements and the rubric', 'Build a multi-file Java project in the editor', 'Compile, run and test it, with instant checks as you type', 'Get SOLID, design-principle, atomicity and pattern feedback']}
          stat={lldStats?.reviewedSubmissions ? `${lldStats.reviewedSubmissions} reviewed, average ${Math.round(lldStats.averageScore ?? 0)}` : 'No reviews yet'}
          inProgress={lldSessions.length}
          cta="Practice LLD"
        />
        <Track
          to="/hld"
          icon={<Boxes className="size-5" />}
          title="High-level design"
          subtitle="System design"
          steps={['Get a question for your level, AI-generated or from the bank', 'Write requirements, estimates, the API and the data model', 'Draw the architecture, starting from a template if you like', 'Go deep on trade-offs, then practise the follow-up questions']}
          stat={hldScores.length ? `${hldScores.length} reviewed, average ${avg(hldScores.map((h) => h.score ?? 0))}` : 'No reviews yet'}
          inProgress={hldSessions.length}
          cta="Practice HLD"
        />
      </section>

      {/* Activity */}
      <section className="mt-6 grid gap-5 md:grid-cols-2">
        <Panel title="Continue practising" empty="Nothing in progress. Start a problem above." items={inProgress.slice(0, 6)} meta={(a) => (a.score != null ? <ScoreBadge score={a.score} /> : <span className="text-faint">not reviewed</span>)} />
        <Panel title="Recent reviews" empty="Your reviews will show up here." items={reviews.slice(0, 6)} meta={(a) => (a.score != null ? <ScoreBadge score={a.score} /> : null)} />
      </section>

      {/* Focus + how it works */}
      <section className="mt-6 grid gap-5 md:grid-cols-[1fr_1.4fr]">
        <div className="rounded-[8px] border border-line bg-panel p-4">
          <h2 className="text-[14px] font-semibold">Focus areas</h2>
          {lldStats?.weakest || lldStats?.designWeakSpots.length ? (
            <ul className="mt-2 flex flex-col gap-2 text-[13px]">
              {lldStats?.weakest && (
                <li className="flex items-baseline gap-2">
                  <Badge tone="warn">weakest</Badge>
                  <span>
                    {lldStats.weakest.label} <span className="text-faint">· {Math.round(lldStats.weakest.averagePct)}% on average</span>
                  </span>
                </li>
              )}
              {lldStats?.strongest && (
                <li className="flex items-baseline gap-2">
                  <Badge tone="ok">strongest</Badge>
                  <span>
                    {lldStats.strongest.label} <span className="text-faint">· {Math.round(lldStats.strongest.averagePct)}%</span>
                  </span>
                </li>
              )}
              {lldStats?.designWeakSpots.slice(0, 3).map((w) => (
                <li key={`${w.area}-${w.item}`} className="flex items-baseline gap-2">
                  <Badge>{w.area}</Badge>
                  <span>
                    {w.item} <span className="text-faint">· flagged in {w.violated + w.partial} of {w.samples}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[13px] text-muted">After a few reviews, your weakest rubric areas and the design principles you most often miss show up here.</p>
          )}
          <Link to="/lld" className="mt-3 inline-flex items-center gap-1 text-[12.5px] text-focus hover:underline">
            Full progress dashboard <ArrowRight className="size-3.5" />
          </Link>
        </div>

        <div className="rounded-[8px] border border-line bg-panel p-4">
          <h2 className="text-[14px] font-semibold">How a review works</h2>
          <ol className="mt-3 grid gap-3 sm:grid-cols-2">
            <Step icon={<Timer className="size-4" />} title="Score first">
              Fast mode returns the score, category breakdown and top findings in about a minute, while the detailed design assessment is written in parallel.
            </Step>
            <Step icon={<Sparkles className="size-4" />} title="Watch it arrive">
              A live preview shows scores and findings as the reviewer writes them, with an estimate of the time left.
            </Step>
            <Step icon={<MessageSquare className="size-4" />} title="Ask and fix">
              Ask follow-up questions on any finding, or get a suggested fix as a diff you can apply to your working copy.
            </Step>
            <Step icon={<Wand2 className="size-4" />} title="Practise the interview">
              A mock interviewer asks the follow-up questions one at a time and gives feedback on each answer.
            </Step>
          </ol>
        </div>
      </section>

      {/* AI status */}
      <section className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[8px] border border-line bg-panel px-4 py-3 text-[12.5px] text-muted">
        <span className="font-medium text-ink">Reviewer</span>
        {settings?.provider && settings.provider !== 'none' ? (
          <span>
            {selected?.label ?? settings.provider}
            {selected && <span className={selected.state === 'authenticated' || selected.state === 'mock' ? 'text-ok' : 'text-warn'}> · {selected.state === 'authenticated' ? 'ready' : selected.state}</span>}
          </span>
        ) : (
          <span className="text-warn">No AI provider selected</span>
        )}
        {settings && <span>Review mode: {settings.review.mode === 'fast' ? 'fast (score first)' : 'full (one pass)'}</span>}
        {providers && <span>{providers.filter((p) => p.id !== 'mock' && p.state === 'authenticated').length} of {providers.filter((p) => p.id !== 'mock').length} CLIs signed in (Claude Code, Codex, Gemini)</span>}
        <Link to="/settings" className="ml-auto inline-flex items-center gap-1 text-focus hover:underline">
          Models, speed and providers <ArrowRight className="size-3.5" />
        </Link>
      </section>
    </PageShell>
  );
}

/** Consecutive days (ending today or yesterday) with at least one review. */
function practiceStreak(dates: string[]): number {
  const days = new Set(dates.map((d) => new Date(d).toDateString()));
  const day = new Date();
  if (!days.has(day.toDateString())) day.setDate(day.getDate() - 1);
  let n = 0;
  while (days.has(day.toDateString())) {
    n++;
    day.setDate(day.getDate() - 1);
  }
  return n;
}

function Tile({ icon, label, value, note }: { icon: ReactNode; label: string; value: string; note: string }) {
  return (
    <div className="rounded-[8px] border border-line bg-panel px-4 py-3">
      <div className="flex items-center gap-1.5 text-[12px] text-muted">
        <span className="text-accent">{icon}</span>
        {label}
      </div>
      <div className="tabular mt-1 text-[24px] leading-tight font-semibold">{value}</div>
      <div className="truncate text-[12px] text-faint" title={note}>
        {note}
      </div>
    </div>
  );
}

function Panel({ title, empty, items, meta }: { title: string; empty: string; items: Activity[]; meta: (a: Activity) => ReactNode }) {
  return (
    <div className="rounded-[8px] border border-line bg-panel p-4">
      <h2 className="text-[14px] font-semibold">{title}</h2>
      {!items.length ? (
        <p className="mt-2 text-[13px] text-muted">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-col">
          {items.map((a, i) => (
            <li key={`${a.to}-${i}`}>
              <Link to={a.to} className="-mx-2 flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[13px] hover:bg-sunken">
                <Badge tone={a.kind === 'LLD' ? 'info' : 'accent'}>{a.kind}</Badge>
                <span className="min-w-0 flex-1 truncate">{a.title}</span>
                <span className="shrink-0 text-[12px] text-faint">{relativeTime(a.at)}</span>
                <span className="w-9 shrink-0 text-right">{meta(a)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Step({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 text-accent">{icon}</span>
      <div>
        <div className="text-[13px] font-medium">{title}</div>
        <p className="text-[12.5px] text-muted">{children}</p>
      </div>
    </li>
  );
}

function Track(props: { to: string; icon: ReactNode; title: string; subtitle: string; steps: string[]; stat: string; inProgress: number; cta: string }) {
  return (
    <Link to={props.to} className="group flex flex-col rounded-[8px] border border-line bg-panel p-5 transition-colors hover:border-line-strong">
      <div className="flex items-center gap-2 text-accent">{props.icon}</div>
      <h2 className="mt-3 text-[20px] font-semibold tracking-tight">{props.title}</h2>
      <div className="text-[13px] text-muted">{props.subtitle}</div>
      <ol className="mt-4 flex flex-col gap-1.5 text-[13.5px]">
        {props.steps.map((s, i) => (
          <li key={s} className="flex gap-2.5">
            <span className="tabular w-4 shrink-0 text-faint">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex items-center gap-3 border-t border-line pt-3 text-[12.5px] text-muted">
        <span>{props.stat}</span>
        {props.inProgress > 0 && <span>{props.inProgress} in progress</span>}
        <span className="ml-auto rounded-[5px] bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas group-hover:opacity-90">{props.cta}</span>
      </div>
    </Link>
  );
}

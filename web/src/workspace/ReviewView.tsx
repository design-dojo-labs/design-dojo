import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { AlertTriangle, FileCode2, Info } from 'lucide-react';
import {
  DESIGN_PRINCIPLE_LABELS,
  SOLID_LABELS,
  type FixSuggestion as Fix,
  type ReviewThread,
  type StoredDesignAssessment,
  type StoredFinding,
  type StoredReview,
  type Submission,
  type VerifiedRef,
} from '@lld/shared';
import { Badge, Markdown, RubricBar, useToast } from '../components/ui';
import { DetailStatus } from '../components/LiveReview';
import { FindingChat } from '../components/FindingChat';
import { FixSuggestion } from '../components/FixSuggestion';
import { InterviewPanel } from '../components/InterviewPanel';
import { errorMessage } from '../lib/api';
import { setMark, useReviewInteractive } from '../lib/interactive';
import { useWorkspace } from './context';

const SEVERITY_TONE = { critical: 'err', major: 'err', minor: 'warn', nit: 'neutral' } as const;
const COVERAGE_TONE = { met: 'ok', partial: 'warn', missing: 'err', unclear: 'neutral' } as const;
const BASIS_TEXT = { 'test-evidence': 'from test results', 'code-inspection': 'by reading code', 'not-verifiable': 'not verifiable' } as const;

export function ReviewView({
  submission,
  review,
  detailPartial,
  onRetryDetail,
  retryingDetail = false,
}: {
  submission: Submission;
  review: StoredReview;
  /** Streamed, unvalidated output of a running detail pass (fast mode). */
  detailPartial?: Record<string, unknown>;
  onRetryDetail?: () => void;
  retryingDetail?: boolean;
}) {
  const da = detailPartial?.designAssessment as { solid?: unknown[]; principles?: unknown[] } | undefined;
  const streamedVerdicts = (Array.isArray(da?.solid) ? da.solid.length : 0) + (Array.isArray(da?.principles) ? da.principles.length : 0);
  const [sev, setSev] = useState<'all' | 'critical' | 'major' | 'minor' | 'nit'>('all');
  const findings = review.findings.filter((f) => sev === 'all' || f.severity === sev);
  const interactive = useReviewInteractive('lld', submission.id);
  const ix = interactive.data?.reviewId === review.id ? interactive.data : undefined;
  const assistOff = ix?.interviewMode ? 'Disabled in interview mode' : null;
  const detailReady = review.reviewMode !== 'fast' || review.detail?.status === 'completed';
  return (
    <div className="text-[13px]">
      <div className="flex items-end gap-3">
        <div className="tabular text-[34px] leading-none font-semibold" data-testid="review-score">
          {review.totalScore}
          <span className="text-[16px] font-normal text-faint">/100</span>
        </div>
        <div className="pb-0.5 text-[12px] text-muted">
          <div>AI practice assessment, not an interview verdict</div>
          <div>
            Confidence {review.confidence}. {review.provider}
            {review.model ? ` / ${review.model}` : ''}
          </div>
        </div>
        {review.isMock && <Badge tone="warn">MOCK</Badge>}
      </div>
      <div className="mt-3">
        <RubricBar categories={review.categories} showLabels />
      </div>

      {review.systemNotes.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 rounded-[5px] border border-line bg-sunken px-2.5 py-2 text-[12.5px] text-muted">
          {review.systemNotes.map((n, i) => (
            <li key={i} className="flex gap-1.5">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {n}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3">{review.summary}</p>

      <Section title="Next steps">
        <ol className="list-decimal pl-5 marker:text-faint">
          {review.nextSteps.map((s, i) => (
            <li key={i} className="my-0.5">
              {s}
            </li>
          ))}
        </ol>
      </Section>

      <Section
        title={`Findings (${review.findings.length})`}
        aside={
          <select className="rounded-[4px] border border-line bg-panel px-1 text-[12px]" value={sev} onChange={(e) => setSev(e.target.value as typeof sev)} aria-label="Filter findings by severity">
            <option value="all">All severities</option>
            <option value="critical">Critical</option>
            <option value="major">Major</option>
            <option value="minor">Minor</option>
            <option value="nit">Nit</option>
          </select>
        }
      >
        {!findings.length && <p className="text-faint">No findings{sev !== 'all' ? ' at this severity' : ''}.</p>}
        <ul className="flex flex-col gap-2.5">
          {findings.map((f) => (
            <FindingCard
              key={f.id}
              f={f}
              submission={submission}
              thread={ix?.threads.find((t) => t.itemKey === f.id)}
              marked={!!ix?.marks[f.id]}
              fix={ix?.fixes.find((x) => x.findingId === f.id)}
              pendingFix={ix?.pendingFixes[f.id]}
              assistOff={assistOff}
              onChanged={() => void interactive.refresh()}
            />
          ))}
        </ul>
      </Section>

      {review.designAssessment ? (
        <DesignAssessmentView da={review.designAssessment} submission={submission} />
      ) : review.reviewMode === 'fast' ? (
        <DetailStatus detail={review.detail} what="design assessment" partialCount={streamedVerdicts} onRetry={() => onRetryDetail?.()} retrying={retryingDetail} />
      ) : (
        <p className="mt-5 text-[12px] text-faint">This review predates the design assessment (SOLID, principles, atomicity, patterns). Use Review again to get one.</p>
      )}

      <Section title="Category scores">
        <ul className="flex flex-col gap-2">
          {review.categories.map((c) => (
            <li key={c.key}>
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{c.label}</span>
                <span className="tabular ml-auto">
                  {c.score}/{c.max}
                </span>
              </div>
              <p className="text-[12.5px] text-muted">{c.rationale}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Requirement coverage">
        <table className="w-full text-[12.5px]">
          <tbody>
            {review.requirementCoverage.map((r) => (
              <tr key={r.requirementId} className="border-t border-line align-top">
                <td className="w-12 py-1 font-mono text-muted">{r.requirementId}</td>
                <td className="w-20 py-1">
                  <Badge tone={COVERAGE_TONE[r.status]}>{r.status}</Badge>
                </td>
                <td className="py-1">
                  {r.evidence} <span className="text-faint">({BASIS_TEXT[r.basis]})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {review.coverageAdjustments.length > 0 && (
          <ul className="mt-1 list-disc pl-5 text-[12px] text-faint">
            {review.coverageAdjustments.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        )}
      </Section>

      {review.strengths.length > 0 && (
        <Section title="Strengths">
          <Bullets items={review.strengths} />
        </Section>
      )}
      {review.tradeoffs.length > 0 && (
        <Section title="Design trade-offs">
          <ul className="flex flex-col gap-1.5">
            {review.tradeoffs.map((t, i) => (
              <li key={i}>
                <span className="font-medium">{t.title}.</span> <span className="text-muted">{t.discussion}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {review.suggestedTests.length > 0 && (
        <Section title="Tests to add">
          <ul className="flex flex-col gap-1.5">
            {review.suggestedTests.map((t, i) => (
              <li key={i}>
                <span className="font-medium">{t.title}</span>
                {t.requirementId && <span className="ml-1 font-mono text-[11.5px] text-faint">{t.requirementId}</span>}
                <div className="text-muted">{t.description}</div>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {review.followUpQuestions.length > 0 && (
        <Section title="Follow-up interview questions">
          <Bullets items={review.followUpQuestions} />
        </Section>
      )}
      {(review.followUpQuestions.length > 0 || !detailReady) && (
        <InterviewPanel
          track="lld"
          submissionId={submission.id}
          interview={ix?.interview ?? null}
          questionCount={review.followUpQuestions.length}
          unavailableReason={detailReady ? null : 'The follow-up questions are still being written.'}
          onChanged={() => void interactive.refresh()}
        />
      )}
      {review.limitations.length > 0 && (
        <Section title="Limitations of this review">
          <Bullets items={review.limitations} muted />
        </Section>
      )}
      <Section title="Review details">
        <dl className="grid grid-cols-[8rem_1fr] gap-x-2 gap-y-0.5 text-[12px] text-muted">
          <dt>Snapshot</dt>
          <dd className="font-mono break-all">
            #{submission.seq}, {submission.contentHash.slice(0, 16)}
          </dd>
          <dt>Problem</dt>
          <dd>
            {review.problemId} v{review.problemVersion}
          </dd>
          <dt>Rubric / schema</dt>
          <dd>
            {review.rubricVersion}, {review.schemaVersion}
          </dd>
          <dt>Prompt</dt>
          <dd>{review.promptVersion}</dd>
          <dt>Reviewer</dt>
          <dd>
            {review.provider}
            {review.model ? ` / ${review.model}` : ' (model not reported)'}
          </dd>
          <dt>Reviewed</dt>
          <dd>
            {new Date(review.createdAt).toLocaleString()}
            {review.durationMs ? `, took ${Math.round(review.durationMs / 1000)} s` : ''}
          </dd>
          <dt>Build</dt>
          <dd>
            compile {submission.compile}
            {submission.tests ? `, tests ${submission.tests.passed} passed / ${submission.tests.failed} failed / ${submission.tests.errored} errored / ${submission.tests.skipped} skipped` : ', no tests ran'}
          </dd>
          <dt>Practice</dt>
          <dd>
            {submission.hintsUsedAtSubmit} hint{submission.hintsUsedAtSubmit === 1 ? '' : 's'} used
            {submission.solutionRevealedAtSubmit ? ', reference solution had been revealed' : ''}
          </dd>
        </dl>
      </Section>
    </div>
  );
}

function FindingCard({
  f,
  submission,
  thread,
  marked,
  fix,
  pendingFix,
  assistOff,
  onChanged,
}: {
  f: StoredFinding;
  submission: Submission;
  thread: ReviewThread | undefined;
  marked: boolean;
  fix: Fix | undefined;
  pendingFix: string | undefined;
  assistOff: string | null;
  onChanged: () => void;
}) {
  const ws = useWorkspace();
  const toast = useToast();
  const [markBusy, setMarkBusy] = useState(false);
  const toggleMark = async (resolved: boolean) => {
    setMarkBusy(true);
    try {
      await setMark('lld', submission.id, f.id, resolved);
      onChanged();
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setMarkBusy(false);
    }
  };
  const loc = f.filePath ? `${f.filePath.split('/').pop()}${f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `–${f.lineEnd}` : ''}` : ''}` : null;
  const inSnapshot = !!f.filePath && submission.manifest.some((m) => m.path === f.filePath);
  return (
    <li className="rounded-[5px] border border-line bg-panel p-2.5" data-testid="finding">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
        <span className="text-[11.5px] text-faint">{f.category.replace('_', ' ')}</span>
        {f.requirementId && <span className="font-mono text-[11.5px] text-faint">{f.requirementId}</span>}
      </div>
      <div className="mt-1 font-medium">{f.title}</div>
      {loc && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]">
          {inSnapshot ? (
            <button
              className="inline-flex items-center gap-1 font-mono text-focus underline-offset-2 hover:underline"
              onClick={() => ws.openSnapshot(submission.id, submission.seq, f.filePath!, f.lineStart, f.lineEnd)}
              title={`Open ${f.filePath} in submitted snapshot #${submission.seq}`}
            >
              <FileCode2 className="size-3.5" aria-hidden />
              {loc}
            </button>
          ) : (
            <span className="font-mono text-faint">{loc}</span>
          )}
          {inSnapshot && (
            <button className="text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => ws.openFile(f.filePath!, f.lineStart ?? undefined).catch(() => {})}>
              working copy
            </button>
          )}
          {f.reference === 'unverified' && (
            <span className="inline-flex items-center gap-1 text-accent" title={f.referenceNote ?? ''}>
              <AlertTriangle className="size-3" aria-hidden /> unverified reference
            </span>
          )}
          {f.reference === 'relocated' && <span className="text-faint" title={f.referenceNote ?? ''}>location corrected</span>}
        </div>
      )}
      {f.referenceNote && f.reference !== 'verified' && f.reference !== 'range-only' && <div className="mt-0.5 text-[11.5px] text-faint">{f.referenceNote}</div>}
      <Markdown className="mt-1.5 text-muted">{f.explanation}</Markdown>
      {f.evidence && <pre className="mt-1.5 max-h-40 overflow-auto rounded-[4px] border border-line bg-sunken p-2 font-mono text-[11.5px] whitespace-pre-wrap">{f.evidence}</pre>}
      <div className="mt-1.5">
        <span className="font-medium">Suggestion: </span>
        <span className="text-muted">{f.suggestion}</span>
      </div>
      {f.sharedRootCauseWith.length > 0 && <div className="mt-1 text-[11.5px] text-faint">Same root cause also noted under {f.sharedRootCauseWith.join(', ').replace(/_/g, ' ')}.</div>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-1.5">
        <FindingChat track="lld" submissionId={submission.id} itemKey={f.id} thread={thread} disabledReason={assistOff} onChanged={onChanged} />
        <FixSuggestion submission={submission} finding={f} fix={fix} pendingJobId={pendingFix} disabledReason={assistOff} onChanged={onChanged} />
        <label className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted" title="Tick when you have fixed this in your working copy. The next review is told to verify it.">
          <input type="checkbox" checked={marked} disabled={markBusy} onChange={(e) => void toggleMark(e.target.checked)} data-testid="finding-mark" />I fixed this
        </label>
      </div>
    </li>
  );
}

const VERDICT_TONE = {
  followed: 'ok',
  'partially-followed': 'warn',
  violated: 'err',
  'not-applicable': 'neutral',
  atomic: 'ok',
  'partially-atomic': 'warn',
  'not-atomic': 'err',
  yes: 'ok',
  partial: 'warn',
  no: 'err',
  unclear: 'neutral',
  'used-appropriately': 'ok',
  'used-but-misapplied': 'err',
  unnecessary: 'warn',
  'would-help': 'info',
} as const;

function Verdict({ v }: { v: keyof typeof VERDICT_TONE }) {
  return <Badge tone={VERDICT_TONE[v]}>{v.replace(/-/g, ' ')}</Badge>;
}

function EvidenceLinks({ refs, submission }: { refs: VerifiedRef[]; submission: Submission }) {
  const ws = useWorkspace();
  if (!refs.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-x-2 text-[11.5px]">
      {refs.map((r, i) => {
        const label = `${r.filePath?.split('/').pop()}${r.lineStart ? `:${r.lineStart}${r.lineEnd && r.lineEnd !== r.lineStart ? `–${r.lineEnd}` : ''}` : ''}`;
        const ok = r.filePath && r.reference !== 'unverified' && submission.manifest.some((m) => m.path === r.filePath);
        return ok ? (
          <button key={i} className="font-mono text-focus hover:underline" onClick={() => ws.openSnapshot(submission.id, submission.seq, r.filePath!, r.lineStart, r.lineEnd)}>
            {label}
          </button>
        ) : (
          <span key={i} className="font-mono text-faint" title={r.referenceNote ?? 'unverified reference'}>
            {label} (unverified)
          </span>
        );
      })}
    </span>
  );
}

function VerdictTable({ rows, submission }: { rows: { name: string; verdict: keyof typeof VERDICT_TONE; explanation: string; evidence: VerifiedRef[] }[]; submission: Submission }) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-[5px] border border-line">
      {rows.map((r) => (
        <li key={r.name} className="px-2.5 py-1.5">
          <div className="flex items-center gap-2">
            <span className="font-medium">{r.name}</span>
            <span className="ml-auto">
              <Verdict v={r.verdict} />
            </span>
          </div>
          <div className="text-[12.5px] text-muted">
            {r.explanation}
            <EvidenceLinks refs={r.evidence} submission={submission} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function DesignAssessmentView({ da, submission }: { da: StoredDesignAssessment; submission: Submission }) {
  return (
    <section className="mt-5" data-testid="design-assessment">
      <h3 className="text-[13.5px] font-semibold">Design assessment</h3>
      <p className="mt-1">{da.overall}</p>
      <h4 className="mt-3 mb-1.5 text-[12.5px] font-semibold text-muted">SOLID</h4>
      <VerdictTable submission={submission} rows={da.solid.map((x) => ({ name: `${x.principle}: ${SOLID_LABELS[x.principle]}`, verdict: x.verdict, explanation: x.explanation, evidence: x.evidence }))} />
      <h4 className="mt-3 mb-1.5 text-[12.5px] font-semibold text-muted">Design principles</h4>
      <VerdictTable submission={submission} rows={da.principles.map((x) => ({ name: DESIGN_PRINCIPLE_LABELS[x.principle], verdict: x.verdict, explanation: x.explanation, evidence: x.evidence }))} />
      <div className="mt-3 mb-1.5 flex items-center gap-2">
        <h4 className="text-[12.5px] font-semibold text-muted">Atomic operations</h4>
        <Verdict v={da.atomicity.verdict} />
      </div>
      <p className="text-[12.5px] text-muted">{da.atomicity.summary}</p>
      {da.atomicity.operations.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {da.atomicity.operations.map((o, i) => (
            <li key={i} className="rounded-[5px] border border-line px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-medium">{o.operation}</span>
                <span className="ml-auto">
                  <Verdict v={o.atomic} />
                </span>
              </div>
              <div className="text-[12.5px] text-muted">
                {o.risk}
                <EvidenceLinks refs={o.evidence} submission={submission} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <h4 className="mt-3 mb-1 text-[12.5px] font-semibold text-muted">Design patterns</h4>
      <p className="mb-1.5 text-[11.5px] text-faint">Judged on fit to the stated requirements. The number of patterns earns nothing on its own.</p>
      {!da.patterns.length ? (
        <p className="text-[12.5px] text-muted">No patterns identified or needed.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {da.patterns.map((p, i) => (
            <li key={i} className="rounded-[5px] border border-line px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.pattern}</span>
                <span className="text-[11.5px] text-faint">{p.where}</span>
                <span className="ml-auto">
                  <Verdict v={p.status} />
                </span>
              </div>
              <div className="text-[12.5px] text-muted">
                {p.explanation}
                <EvidenceLinks refs={p.evidence} submission={submission} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mt-5">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-[13.5px] font-semibold">{title}</h3>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Bullets({ items, muted }: { items: string[]; muted?: boolean }) {
  return (
    <ul className={clsx('list-disc pl-5 marker:text-faint', muted && 'text-muted')}>
      {items.map((s, i) => (
        <li key={i} className="my-0.5">
          {s}
        </li>
      ))}
    </ul>
  );
}

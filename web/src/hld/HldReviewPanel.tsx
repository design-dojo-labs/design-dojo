import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Eye, Info, RotateCcw } from 'lucide-react';
import { HLD_RUBRIC, type HldDocument, type HldSubmission, type Job, type StoredHldReview } from '@lld/shared';
import { errorMessage, get, post } from '../lib/api';
import { isActiveJob, useJob, useSettings } from '../lib/queries';
import { relativeTime } from '../lib/format';
import { Badge, Button, EmptyState, Modal, RubricBar, Spinner, useToast } from '../components/ui';
import { JobProgress } from '../components/JobProgress';
import { JobEta } from '../components/JobEta';
import { DetailStatus, LivePreview, useJobPartials } from '../components/LiveReview';
import { FindingChat } from '../components/FindingChat';
import { InterviewPanel } from '../components/InterviewPanel';
import { setMark, useReviewInteractive } from '../lib/interactive';
import { ScoreBadge } from '../pages/Dashboard';
import { useHldSubmissions } from './queries';

const DiagramCanvas = lazy(() => import('./DiagramCanvas'));

export function HldReviewPanel({ sessionId, onHighlight }: { sessionId: string; onHighlight: (labels: string[]) => void }) {
  const subs = useHldSubmissions(sessionId);
  const list = subs.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const current = list.find((s) => s.id === selected) ?? list[0] ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center border-b border-line px-3 text-[12.5px] font-medium">Submissions and reviews</div>
      {subs.isLoading ? (
        <Spinner className="m-3" />
      ) : !list.length ? (
        <EmptyState title="Nothing submitted yet">
          When your design is ready, press Submit for review. Your requirements, API, data model, diagram and notes are snapshotted and reviewed against the rubric. You can keep working while it runs.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <ul className="border-b border-line">
            {list.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => setSelected(s.id)}
                  aria-current={current?.id === s.id}
                  className={clsx('flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]', current?.id === s.id ? 'bg-select' : 'hover:bg-sunken')}
                >
                  <span className="tabular w-7 font-medium">#{s.seq}</span>
                  <span className="text-faint">{relativeTime(s.createdAt)}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {s.reviewStatus === 'running' || s.reviewStatus === 'pending' ? (
                      <Spinner className="size-3" />
                    ) : s.score != null ? (
                      <ScoreBadge score={s.score} />
                    ) : (
                      <Badge tone={s.reviewStatus === 'failed' || s.reviewStatus === 'interrupted' ? 'err' : 'neutral'}>{s.reviewStatus}</Badge>
                    )}
                    {s.isMock && <Badge tone="warn">mock</Badge>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {current && <Detail sub={current} onHighlight={onHighlight} refetch={() => subs.refetch()} />}
        </div>
      )}
    </div>
  );
}

function Detail({ sub, onHighlight, refetch }: { sub: HldSubmission; onHighlight: (labels: string[]) => void; refetch: () => void }) {
  const reviewJob = useJob(sub.reviewJobId).data;
  const [detailJobId, setDetailJobId] = useState<string | null>(null);
  const detailJob = useJob(detailJobId).data;
  // A detail-only retry is its own job; while it runs, show its progress instead of the finished review job.
  const job = isActiveJob(detailJob) ? detailJob : reviewJob;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [retryingDetail, setRetryingDetail] = useState(false);
  const [showDiagram, setShowDiagram] = useState(false);
  const active = isActiveJob(job);
  // "Review again" keeps showing the previous review until the new score is saved.
  const scored = !!sub.review && (!active || !job || Date.parse(sub.review.createdAt) >= Date.parse(job.createdAt) || job.kind === 'hld-review-detail');
  const partials = useJobPartials(active ? job?.id : null);
  const maxByKey = Object.fromEntries(HLD_RUBRIC.categories.map((c) => [c.key, { label: c.label, max: c.max }]));
  const retryDetail = async () => {
    setRetryingDetail(true);
    try {
      const j = await post<Job>(`/api/hld/submissions/${sub.id}/review-detail`);
      setDetailJobId(j.id);
      refetch();
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setRetryingDetail(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    try {
      await post(`/api/hld/submissions/${sub.id}/review`);
      refetch();
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-3 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <span className="font-medium text-ink">Design #{sub.seq}</span>
        <span>{new Date(sub.createdAt).toLocaleString()}</span>
        <span className="font-mono text-faint">{sub.contentHash.slice(0, 10)}</span>
        <span>
          {sub.graph.components.length} components, {sub.graph.connections.length} connections
        </span>
      </div>
      {active && job && (
        <div className="mt-3">
          <JobProgress jobId={job.id} title={scored ? `Writing section feedback for design #${sub.seq}` : `Reviewing design #${sub.seq}`} />
          <JobEta job={job} className="mt-1.5" />
          <p className="mt-1 text-[12px] text-faint">You can keep working; this review belongs to the snapshot of design #{sub.seq}.</p>
          {!scored && <LivePreview data={partials.score ?? partials.full} maxByKey={maxByKey} />}
          {!scored && sub.review && <p className="mt-3 text-[12px] text-faint">Below: the previous review of this design ({sub.review.totalScore}/100), until the new score is ready.</p>}
        </div>
      )}
      {!active && !sub.review && job && (
        <div className="mt-3">
          <JobProgress jobId={job.id} title="Review" onRetry={retry} />
          <p className="mt-1 text-[12px] text-faint">The submitted design is kept. No score was recorded because the review did not complete.</p>
        </div>
      )}
      {sub.review && (
        <ReviewBody
          submissionId={sub.id}
          review={sub.review}
          onHighlight={onHighlight}
          detailPartial={partials.detail}
          onRetryDetail={retryDetail}
          retryingDetail={retryingDetail || (active && job?.kind === 'hld-review-detail')}
        />
      )}
      <div className="mt-5 flex flex-wrap gap-1.5 border-t border-line pt-3">
        <Button size="sm" icon={<Eye className="size-3.5" />} onClick={() => setShowDiagram(true)}>
          View submitted design
        </Button>
        {sub.review && !active && (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} busy={busy} onClick={retry}>
            Review again
          </Button>
        )}
      </div>
      {showDiagram && <SubmittedDesign sub={sub} onClose={() => setShowDiagram(false)} />}
    </div>
  );
}

function ReviewBody({
  submissionId,
  review,
  onHighlight,
  detailPartial,
  onRetryDetail,
  retryingDetail,
}: {
  submissionId: string;
  review: StoredHldReview;
  onHighlight: (labels: string[]) => void;
  detailPartial?: Record<string, unknown>;
  onRetryDetail: () => void;
  retryingDetail: boolean;
}) {
  const s = review.sections;
  const detailReady = review.reviewMode !== 'fast' || review.detail?.status === 'completed';
  const streamedSections = detailPartial?.sections && typeof detailPartial.sections === 'object' ? Object.keys(detailPartial.sections).length : 0;
  const interactive = useReviewInteractive('hld', submissionId);
  const ix = interactive.data?.reviewId === review.id ? interactive.data : undefined;
  const toast = useToast();
  const [markBusy, setMarkBusy] = useState<string | null>(null);
  const toggleMark = async (itemKey: string, resolved: boolean) => {
    setMarkBusy(itemKey);
    try {
      await setMark('hld', submissionId, itemKey, resolved);
      void interactive.refresh();
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setMarkBusy(null);
    }
  };
  return (
    <div className="mt-3">
      <div className="flex items-end gap-3">
        <div className="tabular text-[34px] leading-none font-semibold" data-testid="hld-review-score">
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

      <Sec title="Next steps">
        <ol className="list-decimal pl-5 marker:text-faint">
          {review.nextSteps.map((x, i) => (
            <li key={i} className="my-0.5">
              {x}
            </li>
          ))}
        </ol>
      </Sec>

      <Sec title={`Improvements (${review.improvements.length})`}>
        <ul className="flex flex-col gap-2.5">
          {review.improvements.map((im, i) => (
            <li key={i} className="rounded-[5px] border border-line bg-panel p-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={im.priority === 'high' ? 'err' : im.priority === 'medium' ? 'warn' : 'neutral'}>{im.priority}</Badge>
                <span className="text-[11.5px] text-faint">{review.categories.find((c) => c.key === im.area)?.label ?? im.area}</span>
              </div>
              <div className="mt-1 font-medium">{im.title}</div>
              <p className="mt-1 text-muted">{im.explanation}</p>
              <p className="mt-1">
                <span className="font-medium">Suggestion: </span>
                <span className="text-muted">{im.suggestion}</span>
              </p>
              {im.componentRefs.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-[12px]">
                  {im.componentRefs.map((c) =>
                    c.matched ? (
                      <button key={c.label} className="rounded-[4px] border border-line px-1.5 py-0.5 text-focus hover:border-focus" onClick={() => onHighlight([c.matched!])} title="Show on the canvas">
                        {c.matched}
                      </button>
                    ) : (
                      <span key={c.label} className="rounded-[4px] border border-dashed border-line px-1.5 py-0.5 text-faint" title="Not a component in your diagram">
                        {c.label} (not in diagram)
                      </span>
                    ),
                  )}
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-1.5">
                <FindingChat
                  track="hld"
                  submissionId={submissionId}
                  itemKey={`improvement:${i}`}
                  thread={ix?.threads.find((t) => t.itemKey === `improvement:${i}`)}
                  disabledReason={ix?.interviewMode ? 'Disabled in interview mode' : null}
                  onChanged={() => void interactive.refresh()}
                />
                <label className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted" title="Tick when you have addressed this in your design.">
                  <input
                    type="checkbox"
                    checked={!!ix?.marks[`improvement:${i}`]}
                    disabled={markBusy === `improvement:${i}`}
                    onChange={(e) => void toggleMark(`improvement:${i}`, e.target.checked)}
                    data-testid="improvement-mark"
                  />
                  I fixed this
                </label>
              </div>
            </li>
          ))}
        </ul>
      </Sec>

      <Sec title="How the reviewer read your diagram">
        <p className="text-muted">{review.diagramInterpretation}</p>
      </Sec>

      <Sec title="Category scores">
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
      </Sec>

      <DetailStatus detail={review.detail} what="section feedback" partialCount={streamedSections} onRetry={onRetryDetail} retrying={retryingDetail} />
      {detailReady && (
        <Sec title="Section feedback">
          <Area title="Requirements" fb={s.requirements} extra={[['Missing functional', s.requirements.missingFunctional], ['Missing non-functional', s.requirements.missingNonFunctional]]} />
          <Area title="API" fb={s.api} />
          <Area title="Data model" fb={s.dataModel} />
          <Area
            title="Architecture"
            fb={s.architecture}
            extra={[
              ['Missing components', s.architecture.missingComponents],
              ['Single points of failure', s.architecture.singlePointsOfFailure],
              ['Bottlenecks', s.architecture.bottlenecks],
            ]}
          />
          <Area title="Scalability and reliability" fb={s.scalability} />
          <Area title="Trade-offs" fb={s.tradeoffs} />
        </Sec>
      )}
      {review.strengths.length > 0 && (
        <Sec title="Strengths">
          <ul className="list-disc pl-5 marker:text-faint">
            {review.strengths.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </Sec>
      )}
      {review.followUpQuestions.length > 0 && (
        <Sec title="Follow-up interview questions">
          <ul className="list-disc pl-5 marker:text-faint">
            {review.followUpQuestions.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </Sec>
      )}
      {(review.followUpQuestions.length > 0 || !detailReady) && (
        <InterviewPanel
          track="hld"
          submissionId={submissionId}
          interview={ix?.interview ?? null}
          questionCount={review.followUpQuestions.length}
          unavailableReason={detailReady ? null : 'The follow-up questions are still being written.'}
          onChanged={() => void interactive.refresh()}
        />
      )}
      {review.limitations.length > 0 && (
        <Sec title="Limitations of this review">
          <ul className="list-disc pl-5 text-muted marker:text-faint">
            {review.limitations.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </Sec>
      )}
      <Sec title="Review details">
        <p className="text-[12px] text-muted">
          {review.rubricVersion}, prompt {review.promptVersion}, reviewed {new Date(review.createdAt).toLocaleString()}
          {review.durationMs ? `, took ${Math.round(review.durationMs / 1000)} s` : ''}.
        </p>
      </Sec>
    </div>
  );
}

function Area({ title, fb, extra = [] }: { title: string; fb: { feedback: string; issues: string[] }; extra?: [string, string[]][] }) {
  return (
    <div className="mb-3">
      <div className="font-medium">{title}</div>
      <p className="text-muted">{fb.feedback}</p>
      {fb.issues.length > 0 && (
        <ul className="mt-0.5 list-disc pl-5 text-[12.5px] marker:text-faint">
          {fb.issues.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      {extra
        .filter(([, items]) => items.length)
        .map(([label, items]) => (
          <div key={label} className="mt-1 text-[12.5px]">
            <span className="text-faint">{label}: </span>
            {items.join('; ')}
          </div>
        ))}
    </div>
  );
}

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-1.5 text-[13.5px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** The immutable submitted design: read-only canvas plus exactly what the reviewer received. */
function SubmittedDesign({ sub, onClose }: { sub: HldSubmission; onClose: () => void }) {
  const [doc, setDoc] = useState<HldDocument | null>(null);
  const dark = useSettings().data?.editor.theme !== 'light';
  useEffect(() => {
    let live = true;
    void get<HldDocument>(`/api/hld/submissions/${sub.id}/doc`).then((d) => live && setDoc(d));
    return () => {
      live = false;
    };
  }, [sub.id]);
  const label = (ref: string) => sub.graph.components.find((c) => c.ref === ref)?.label ?? ref;
  return (
    <Modal open title={`Submitted design #${sub.seq} (read-only)`} onClose={onClose} wide="full">
      <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_340px] gap-3">
        <div className="min-h-0 rounded-[5px] border border-line">
          {doc ? (
            <Suspense fallback={<Spinner className="m-4" />}>
              <DiagramCanvas elements={doc.diagram.elements} dark={dark} readOnly />
            </Suspense>
          ) : (
            <Spinner className="m-4" />
          )}
        </div>
        <div className="min-h-0 overflow-auto text-[12.5px]">
          <h3 className="font-semibold">What the reviewer received</h3>
          <p className="mt-1 text-faint">The diagram is sent as this component graph. Unattached arrows are matched to the nearest shape and flagged.</p>
          <ul className="mt-2 flex flex-col gap-0.5">
            {sub.graph.components.map((c) => (
              <li key={c.ref}>
                <span className="font-mono text-faint">{c.ref}</span> {c.label} <span className="text-faint">({[c.shape, c.color, c.kind].filter(Boolean).join(', ')})</span>
              </li>
            ))}
          </ul>
          <h4 className="mt-3 font-medium">Connections</h4>
          <ul className="mt-1 flex flex-col gap-0.5">
            {sub.graph.connections.map((e, i) => (
              <li key={i}>
                {label(e.from)} {e.directed ? '→' : '—'} {label(e.to)}
                {e.label ? <span className="text-faint"> [{e.label}]</span> : null}
                {e.inferred && <span className="text-accent"> (inferred)</span>}
              </li>
            ))}
            {!sub.graph.connections.length && <li className="text-faint">No connections.</li>}
          </ul>
          {sub.graph.notes.length > 0 && (
            <>
              <h4 className="mt-3 font-medium">Text notes on the canvas</h4>
              <ul className="mt-1 list-disc pl-4">
                {sub.graph.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </>
          )}
          {sub.graph.ignored.length > 0 && <p className="mt-3 text-faint">Not interpreted: {sub.graph.ignored.join('; ')}</p>}
        </div>
      </div>
    </Modal>
  );
}

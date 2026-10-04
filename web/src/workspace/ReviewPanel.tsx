import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Download, GitCompare, RotateCcw } from 'lucide-react';
import type { Job, SubmissionComparison, SubmissionSummary } from '@lld/shared';
import { errorMessage, get, post } from '../lib/api';
import { isActiveJob, useJob, useProviders, useReference, useSettings, useSubmission, useSubmissions } from '../lib/queries';
import { aiReadiness } from '../lib/practice';
import { relativeTime } from '../lib/format';
import { Badge, Button, EmptyState, ErrorNote, Markdown, Modal, Spinner, useConfirm, useToast } from '../components/ui';
import { JobProgress } from '../components/JobProgress';
import { JobEta } from '../components/JobEta';
import { LivePreview, useJobPartials } from '../components/LiveReview';
import { ScoreBadge } from '../pages/Dashboard';
import { ReviewView } from './ReviewView';
import { useReviewInteractive } from '../lib/interactive';
import { useWorkspace } from './context';
import { monaco } from './monaco';
import { languageFor } from './monaco';

export function ReviewPanel() {
  const ws = useWorkspace();
  const subs = useSubmissions(ws.session.id);
  const list = subs.data ?? [];
  const selected = ws.selectedSubmission ?? list[0]?.id ?? null;
  const [compare, setCompare] = useState<{ base: string; head: string } | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-[12.5px] font-medium">Submissions and reviews</span>
      </div>
      {subs.isLoading ? (
        <Spinner className="m-3" />
      ) : !list.length ? (
        <EmptyState title="Nothing submitted yet">
          When your solution is ready, press Submit for review. The studio snapshots your files, builds and tests that exact snapshot, then asks the selected AI provider to assess it against the
          rubric. You can keep editing while the review runs.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <ul className="border-b border-line" aria-label="Submissions">
            {list.map((s) => (
              <SubmissionRow key={s.id} s={s} active={s.id === selected} onSelect={() => ws.selectSubmission(s.id)} />
            ))}
          </ul>
          {selected && (
            <div className="px-3 py-3">
              <SubmissionDetail
                id={selected}
                previous={list[list.findIndex((s) => s.id === selected) + 1] ?? null}
                onCompare={(base, head) => setCompare({ base, head })}
              />
            </div>
          )}
          <div className="border-t border-line px-3 py-3">
            <ReferenceSection hasSubmission={list.length > 0} />
          </div>
        </div>
      )}
      {compare && <CompareModal list={list} initial={compare} onClose={() => setCompare(null)} />}
    </div>
  );
}

function SubmissionRow({ s, active, onSelect }: { s: SubmissionSummary; active: boolean; onSelect: () => void }) {
  return (
    <li>
      <button onClick={onSelect} aria-current={active} className={clsx('flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]', active ? 'bg-select' : 'hover:bg-sunken')}>
        <span className="tabular w-7 font-medium">#{s.seq}</span>
        <span className="text-faint">{relativeTime(s.createdAt)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {s.compile === 'failed' && <Badge tone="err">no compile</Badge>}
          {s.tests && <span className="tabular text-faint">{s.tests.passed}/{s.tests.total}</span>}
          {s.reviewStatus === 'running' || s.reviewStatus === 'pending' ? (
            <Spinner className="size-3" />
          ) : s.score != null ? (
            <ScoreBadge score={s.score} />
          ) : (
            <Badge tone={s.reviewStatus === 'failed' || s.reviewStatus === 'interrupted' ? 'err' : 'neutral'}>{s.reviewStatus === 'not-requested' ? 'no review' : s.reviewStatus}</Badge>
          )}
          {s.isMock && <Badge tone="warn">mock</Badge>}
        </span>
      </button>
    </li>
  );
}

function SubmissionDetail({ id, previous, onCompare }: { id: string; previous: SubmissionSummary | null; onCompare: (base: string, head: string) => void }) {
  const ws = useWorkspace();
  const sub = useSubmission(id);
  const reviewJob = useJob(sub.data?.reviewJobId).data;
  const [detailJobId, setDetailJobId] = useState<string | null>(null);
  const detailJob = useJob(detailJobId).data;
  // A detail-only retry is its own job; while it runs, show its progress instead of the finished review job.
  const job = isActiveJob(detailJob) ? detailJob : reviewJob;
  const partials = useJobPartials(isActiveJob(job) ? job?.id : null);
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  const [retryingDetail, setRetryingDetail] = useState(false);
  const s = sub.data;
  const maxByKey = Object.fromEntries(ws.session.problem.rubric.categories.map((c) => [c.key, { label: c.label, max: c.max }]));
  if (sub.isLoading) return <Spinner />;
  if (sub.error) return <ErrorNote>{errorMessage(sub.error)}</ErrorNote>;
  if (!s) return null;
  const retry = async () => {
    setRetrying(true);
    try {
      await post<Job>(`/api/submissions/${s.id}/review`);
      await sub.refetch();
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setRetrying(false);
    }
  };
  const retryDetail = async () => {
    setRetryingDetail(true);
    try {
      const j = await post<Job>(`/api/submissions/${s.id}/review-detail`);
      setDetailJobId(j.id);
      await sub.refetch();
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setRetryingDetail(false);
    }
  };
  const active = isActiveJob(job);
  // "Review again" keeps showing the previous review until the new score is saved; only a review
  // created by the running job means that job has moved on to the detail pass.
  const scored = !!s.review && (!active || !job || Date.parse(s.review.createdAt) >= Date.parse(job.createdAt) || job.kind === 'review-detail');
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <span className="font-medium text-ink">Submission #{s.seq}</span>
        <span>{new Date(s.createdAt).toLocaleString()}</span>
        <span className="font-mono text-faint" title={s.contentHash}>
          {s.contentHash.slice(0, 10)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
        <Badge tone={s.compile === 'passed' ? 'ok' : s.compile === 'failed' ? 'err' : 'neutral'}>
          {s.compile === 'passed' ? 'compiled' : s.compile === 'failed' ? 'compilation failed' : s.compile === 'pending' ? 'building…' : 'not built'}
        </Badge>
        {s.tests ? (
          <Badge tone={s.tests.failed + s.tests.errored ? 'err' : 'ok'}>
            tests {s.tests.passed} passed, {s.tests.failed} failed, {s.tests.errored} errored, {s.tests.skipped} skipped
          </Badge>
        ) : (
          s.compile === 'passed' && <Badge>no tests ran</Badge>
        )}
        <span className="text-faint">{s.manifest.length} files</span>
      </div>
      {s.excluded.length > 0 && <p className="mt-1 text-[11.5px] text-faint">Not in snapshot: {s.excluded.map((e) => `${e.path} (${e.reason})`).join(', ')}</p>}

      {active && job && (
        <div className="mt-3">
          <JobProgress jobId={job.id} title={scored ? `Writing the design assessment for #${s.seq}` : `Reviewing #${s.seq}`} />
          <JobEta job={job} className="mt-1.5" />
          <p className="mt-1 text-[12px] text-faint">You can keep editing. This review belongs to snapshot #{s.seq} and later edits won't change it.</p>
          {!scored && <LivePreview data={partials.score ?? partials.full} maxByKey={maxByKey} />}
          {!scored && s.review && <p className="mt-3 text-[12px] text-faint">Below: the previous review of this snapshot ({s.review.totalScore}/100), until the new score is ready.</p>}
        </div>
      )}
      {!active && !s.review && (
        <div className="mt-3">
          {job ? (
            <JobProgress jobId={job.id} title="Review" onRetry={retry} />
          ) : (
            <div className="flex items-center gap-2 text-[12.5px] text-muted">
              No review was requested.
              <Button size="sm" busy={retrying} onClick={retry}>
                Request review
              </Button>
            </div>
          )}
          {s.reviewError && <p className="mt-1 text-[12px] text-faint">The snapshot, build and test results are kept. No score was recorded because the review did not complete.</p>}
        </div>
      )}
      {s.review && (
        <div className="mt-3">
          <ReviewView submission={s} review={s.review} detailPartial={partials.detail} onRetryDetail={retryDetail} retryingDetail={retryingDetail || (active && job?.kind === 'review-detail')} />
        </div>
      )}
      <div className="mt-5 flex flex-wrap gap-1.5 border-t border-line pt-3">
        {previous && (
          <Button size="sm" icon={<GitCompare className="size-3.5" />} onClick={() => onCompare(previous.id, s.id)}>
            Compare with #{previous.seq}
          </Button>
        )}
        {s.review && (
          <>
            <a href={`/api/submissions/${s.id}/export?format=md`} download>
              <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />}>
                Review (Markdown)
              </Button>
            </a>
            <a href={`/api/submissions/${s.id}/export?format=json`} download>
              <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />}>
                JSON
              </Button>
            </a>
          </>
        )}
        <a href={`/api/submissions/${s.id}/export?format=zip`} download>
          <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />}>
            Snapshot ZIP
          </Button>
        </a>
        {s.review && !active && (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} busy={retrying} onClick={retry} title="Ask the reviewer again about this same snapshot">
            Review again
          </Button>
        )}
      </div>
    </div>
  );
}

function ReferenceSection({ hasSubmission }: { hasSubmission: boolean }) {
  const ws = useWorkspace();
  const ref = useReference(ws.session.id);
  const settings = useSettings();
  const providers = useProviders();
  const ai = aiReadiness(settings.data, providers.data);
  const confirm = useConfirm();
  const toast = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId).data;
  if (!hasSubmission) return null;
  const reveal = async () => {
    const ok = await confirm({
      title: 'Show a reference solution?',
      body: 'An AI-written reference design will be generated into a separate read-only folder; your workspace is not touched. The session is marked "reference revealed" and later submissions show that next to their assessment.',
      confirmLabel: 'Generate reference',
    });
    if (!ok) return;
    try {
      setJobId((await post<Job>(`/api/sessions/${ws.session.id}/reference`)).id);
    } catch (e) {
      toast('err', errorMessage(e));
    }
  };
  const r = ref.data;
  return (
    <div className="text-[13px]">
      <div className="flex items-center gap-2">
        <BookOpen className="size-4 text-muted" aria-hidden />
        <span className="font-medium">Reference solution</span>
        {r?.isMock && <Badge tone="warn">MOCK</Badge>}
      </div>
      {!r && !isActiveJob(job) && (
        <div className="mt-1.5">
          <p className="text-[12.5px] text-muted">One valid design to compare against, available after you submit. It stays separate from your files.</p>
          <Button className="mt-2" size="sm" disabled={!ai.ready} title={ai.reason ?? undefined} onClick={reveal}>
            Show reference solution
          </Button>
        </div>
      )}
      {jobId && !r && (
        <div className="mt-2">
          <JobProgress jobId={jobId} title="Writing reference" onRetry={reveal} />
        </div>
      )}
      {r && (
        <div className="mt-2">
          <Markdown className="text-muted">{r.overview}</Markdown>
          <ul className="mt-2 flex flex-col gap-1">
            {r.keyDecisions.map((d, i) => (
              <li key={i}>
                <span className="font-medium">{d.title}.</span> <span className="text-muted">{d.rationale}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 text-[12px] text-faint">Files (open read-only):</div>
          <ul className="mt-1 flex flex-col">
            {r.files.map((f) => (
              <li key={f.path}>
                <button className="font-mono text-[12px] text-focus hover:underline" onClick={() => ws.openReference(r.id, f.path)}>
                  {f.path}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CompareModal({ list, initial, onClose }: { list: SubmissionSummary[]; initial: { base: string; head: string }; onClose: () => void }) {
  const [base, setBase] = useState(initial.base);
  const [head, setHead] = useState(initial.head);
  const cmp = useQuery({ queryKey: ['compare', base, head], queryFn: () => get<SubmissionComparison>(`/api/submissions/compare?base=${base}&head=${head}`), enabled: base !== head });
  const [file, setFile] = useState<string | null>(null);
  const data = cmp.data;
  // "I fixed this" marks the learner set on the base review, shown next to the reviewer's verdicts.
  const baseMarks = useReviewInteractive('lld', base).data?.marks ?? {};
  useEffect(() => {
    if (!data) return;
    const firstChanged = data.files.find((f) => f.status !== 'unchanged');
    setFile(firstChanged?.path ?? data.files[0]?.path ?? null);
  }, [data]);
  const seq = (id: string) => list.find((s) => s.id === id)?.seq;
  return (
    <Modal open title="Compare submissions" onClose={onClose} wide="full">
      <div className="flex h-full min-h-0 flex-col gap-3 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-muted" htmlFor="cmp-base">
            From
          </label>
          <select id="cmp-base" className="rounded-[4px] border border-line bg-panel px-1.5 py-0.5" value={base} onChange={(e) => setBase(e.target.value)}>
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                #{s.seq}
                {s.score != null ? ` (${s.score})` : ''}
              </option>
            ))}
          </select>
          <label className="text-muted" htmlFor="cmp-head">
            to
          </label>
          <select id="cmp-head" className="rounded-[4px] border border-line bg-panel px-1.5 py-0.5" value={head} onChange={(e) => setHead(e.target.value)}>
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                #{s.seq}
                {s.score != null ? ` (${s.score})` : ''}
              </option>
            ))}
          </select>
          {data?.totalDelta != null && (
            <span className={clsx('tabular ml-2 font-medium', data.totalDelta > 0 ? 'text-ok' : data.totalDelta < 0 ? 'text-err' : 'text-muted')}>
              {data.totalDelta > 0 ? '+' : ''}
              {data.totalDelta} points
            </span>
          )}
          {data && !data.comparable && <Badge tone="warn">not directly comparable</Badge>}
        </div>
        {base === head && <p className="text-muted">Choose two different submissions.</p>}
        {cmp.isLoading && <Spinner />}
        {cmp.error && <ErrorNote>{errorMessage(cmp.error)}</ErrorNote>}
        {data && (
          <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] gap-4">
            <div className="min-h-0 overflow-auto pr-1">
              {data.notes.length > 0 && (
                <ul className="mb-3 list-disc pl-4 text-[12px] text-muted">
                  {data.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
              <h3 className="mb-1 text-[12.5px] font-semibold">Category scores</h3>
              <table className="w-full text-[12px]">
                <tbody>
                  {data.categoryDeltas.map((c) => {
                    const d = c.base != null && c.head != null ? c.head - c.base : null;
                    return (
                      <tr key={c.key} className="border-t border-line">
                        <td className="py-0.5 pr-1">{c.label.split(' & ')[0].split(',')[0]}</td>
                        <td className="tabular py-0.5 text-right text-faint">
                          {c.base ?? '–'} → {c.head ?? '–'}
                        </td>
                        <td className={clsx('tabular w-8 py-0.5 text-right', d && d > 0 ? 'text-ok' : d && d < 0 ? 'text-err' : 'text-faint')}>{d == null ? '' : d > 0 ? `+${d}` : d}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {data.designChanges.length > 0 && (
                <>
                  <h3 className="mt-3 mb-1 text-[12.5px] font-semibold">Design verdict changes</h3>
                  <ul className="flex flex-col gap-0.5 text-[12px]">
                    {data.designChanges.map((c) => (
                      <li key={`${c.area}:${c.item}`}>
                        <span className="text-faint">{c.area}:</span> {c.item}{' '}
                        <span className={clsx(c.head === 'followed' || c.head === 'atomic' ? 'text-ok' : c.head === 'violated' || c.head === 'not-atomic' ? 'text-err' : 'text-accent')}>
                          {c.base.replace(/-/g, ' ')} → {c.head.replace(/-/g, ' ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {data.findings && (
                <div className="mt-3 flex flex-col gap-2 text-[12px]">
                  <FindingList
                    title={`Resolved (${data.findings.resolved.length})`}
                    tone="text-ok"
                    items={data.findings.resolved.map((f) => ({ id: f.id, text: f.title, note: f.note, marked: baseMarks[f.id] }))}
                  />
                  <FindingList
                    title={`Remaining (${data.findings.remaining.length})`}
                    tone="text-accent"
                    items={data.findings.remaining.map((f) => ({ id: f.id, text: f.title, note: f.note, marked: baseMarks[f.id] }))}
                  />
                  <FindingList title={`New (${data.findings.new.length})`} tone="text-err" items={data.findings.new.map((f) => ({ id: f.id, text: `[${f.severity}] ${f.title}` }))} />
                  {data.findings.unclear.length > 0 && (
                    <FindingList title={`Unclear (${data.findings.unclear.length})`} tone="text-muted" items={data.findings.unclear.map((f) => ({ id: f.id, text: f.title, note: f.note, marked: baseMarks[f.id] }))} />
                  )}
                  {Object.values(baseMarks).some(Boolean) && <p className="text-[11.5px] text-faint">"you marked fixed" = you ticked "I fixed this" on #{seq(base)}; the reviewer's verdict decides.</p>}
                </div>
              )}
              <h3 className="mt-3 mb-1 text-[12.5px] font-semibold">Files</h3>
              <ul className="text-[12px]">
                {data.files.map((f) => (
                  <li key={f.path}>
                    <button className={clsx('flex w-full gap-2 rounded-[3px] px-1 py-0.5 text-left', file === f.path ? 'bg-select' : 'hover:bg-sunken')} onClick={() => setFile(f.path)}>
                      <span className={clsx('w-16 shrink-0', f.status === 'added' ? 'text-ok' : f.status === 'removed' ? 'text-err' : f.status === 'modified' ? 'text-accent' : 'text-faint')}>{f.status}</span>
                      <span className="truncate font-mono">{f.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex min-h-0 flex-col">
              <div className="mb-1 text-[12px] text-muted">
                {file ? (
                  <>
                    <span className="font-mono">{file}</span>: #{seq(base)} on the left, #{seq(head)} on the right
                  </>
                ) : (
                  'Select a file'
                )}
              </div>
              {file && <DiffView baseId={base} headId={head} path={file} status={data.files.find((f) => f.path === file)?.status ?? 'unchanged'} />}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function FindingList({ title, tone, items }: { title: string; tone: string; items: { id: string; text: string; note?: string; marked?: boolean }[] }) {
  return (
    <div>
      <div className={clsx('font-medium', tone)}>{title}</div>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {items.map((i) => (
          <li key={i.id} title={i.note}>
            {i.text}
            {i.marked && <span className="ml-1 rounded-[3px] bg-sunken px-1 text-[11px] text-muted">you marked fixed</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiffView({ baseId, headId, path, status }: { baseId: string; headId: string; path: string; status: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const editor = monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 13,
      scrollBeyondLastLine: false,
    });
    const load = (id: string) =>
      get<{ content: string }>(`/api/submissions/${id}/file?path=${encodeURIComponent(path)}`)
        .then((r) => r.content)
        .catch(() => '');
    const models: monaco.editor.ITextModel[] = [];
    Promise.all([status === 'added' ? Promise.resolve('') : load(baseId), status === 'removed' ? Promise.resolve('') : load(headId)])
      .then(([a, b]) => {
        if (disposed) return;
        const lang = languageFor(path);
        const original = monaco.editor.createModel(a, lang);
        const modified = monaco.editor.createModel(b, lang);
        models.push(original, modified);
        editor.setModel({ original, modified });
      })
      .catch((e) => setErr(String(e)));
    return () => {
      disposed = true;
      editor.dispose();
      models.forEach((m) => m.dispose());
    };
  }, [baseId, headId, path, status]);
  return (
    <>
      {err && <ErrorNote>{err}</ErrorNote>}
      <div ref={host} className="min-h-0 flex-1 rounded-[4px] border border-line" />
    </>
  );
}

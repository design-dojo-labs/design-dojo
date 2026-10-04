import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { ToggleResizeHandle, usePanelToggle } from '../components/PanelToggle';
import clsx from 'clsx';
import { Pause, Play, Send, Timer as TimerIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { HldDocument, HldSession, HldSubmission, Job } from '@lld/shared';
import { errorMessage, get, post } from '../lib/api';
import { ensureNotificationPermission } from '../lib/notify';
import { useQc, useSettings } from '../lib/queries';
import { formatDuration } from '../lib/format';
import { Badge, Button, ErrorNote, IconButton, Spinner, useToast } from '../components/ui';
import { Logo, StatusChips } from '../components/Shell';
import { elapsed } from '../workspace/timer';
import { HldProblemView } from './HldProblemView';
import { HldReviewPanel } from './HldReviewPanel';
import { ApiStage, EntitiesStage, EstimatesStage, NotesStage, RequirementsStage } from './StageEditors';
import { hk, useHldSession } from './queries';
import { useHldDoc, type DocSaveState } from './useHldDoc';
import type { HighlightRequest } from './DiagramCanvas';
import { ChecksPanel, ChecksToggle, StageWarnBadge, useChecksOpen, useHldChecks } from './ChecksPanel';
import { countHldChecks } from '@lld/shared';

const DiagramCanvas = lazy(() => import('./DiagramCanvas'));

type Stage = 'requirements' | 'estimates' | 'api' | 'entities' | 'diagram' | 'notes';
const STAGES: { id: Stage; label: string; count: (d: HldDocument) => number }[] = [
  { id: 'requirements', label: 'Requirements', count: (d) => d.functional.filter((x) => x.text.trim()).length + d.nonFunctional.filter((x) => x.text.trim()).length },
  { id: 'estimates', label: 'Estimates', count: (d) => (d.estimates.trim() ? 1 : 0) },
  { id: 'api', label: 'API', count: (d) => d.apis.filter((a) => a.path.trim()).length },
  { id: 'entities', label: 'Data model', count: (d) => d.entities.filter((e) => e.name.trim()).length },
  { id: 'diagram', label: 'Architecture', count: (d) => d.diagram.elements.filter((e) => ['rectangle', 'ellipse', 'diamond'].includes(String(e.type))).length },
  { id: 'notes', label: 'Deep dives', count: (d) => (d.notes.trim() ? 1 : 0) },
];

export function HldWorkspace() {
  const { id = '' } = useParams();
  const session = useHldSession(id);
  if (session.isLoading) return <Spinner className="m-6" />;
  if (session.error || !session.data)
    return (
      <div className="p-6">
        <ErrorNote>{errorMessage(session.error ?? 'Session not found')}</ErrorNote>
        <Link to="/hld" className="mt-3 inline-block text-focus underline">
          Back to HLD practice
        </Link>
      </div>
    );
  return <Workspace session={session.data} />;
}

function Workspace({ session }: { session: HldSession }) {
  const store = useHldDoc(session);
  const problemPanel = usePanelToggle();
  const reviewPanel = usePanelToggle();
  const { doc, update } = store;
  const [stage, setStage] = useState<Stage>(() => (localStorage.getItem(`lld.hld.stage.${session.id}`) as Stage) || 'requirements');
  const [highlight, setHighlight] = useState<HighlightRequest | null>(null);
  const checks = useHldChecks(doc);
  const checkCounts = countHldChecks(checks);
  const [checksOpen, setChecksOpen] = useChecksOpen(session.mode !== 'interview');
  const canvasFlush = useRef<(() => void) | null>(null);
  const flushAll = async () => {
    canvasFlush.current?.();
    return store.flush();
  };
  const dark = useSettings().data?.editor.theme !== 'light';
  // Problem metadata refreshes after a submission so the evaluation guide appears.
  const meta = useQuery({ queryKey: ['hld-session-meta', session.id], queryFn: () => get<HldSession>(`/api/hld/sessions/${session.id}`), initialData: session });
  useHeartbeat(session.id);

  useEffect(() => {
    try {
      localStorage.setItem(`lld.hld.stage.${session.id}`, stage);
    } catch {
      /* ignore */
    }
  }, [stage, session.id]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        canvasFlush.current?.();
        void store.flush();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [store]);

  const showOnCanvas = (labels: string[]) => {
    setStage('diagram');
    setTimeout(() => setHighlight({ labels, nonce: Date.now() }), 150);
  };

  return (
    <div className="flex h-full flex-col">
      <TopBar session={meta.data ?? session} store={store} flushAll={flushAll} />
      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="lld.hld.columns">
          <Panel id="problem" order={1} defaultSize={22} minSize={12} collapsible {...problemPanel.panelProps}>
            <div className="h-full overflow-auto bg-panel px-4 py-3">
              <h2 className="text-[16px] font-semibold tracking-tight">{session.problem.content.title}</h2>
              <div className="mt-2">
                <HldProblemView problem={(meta.data ?? session).problem} dense />
              </div>
            </div>
          </Panel>
          <ToggleResizeHandle side="before" collapsed={problemPanel.collapsed} onToggle={problemPanel.toggle} label="problem panel" />
          <Panel id="design" order={2} minSize={30}>
            <div className="flex h-full min-h-0 flex-col">
              <div role="tablist" aria-label="Design stages" className="flex h-10 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-line bg-canvas px-2">
                {STAGES.map((s, i) => {
                  const n = s.count(doc);
                  const warns = checkCounts[s.id].warn;
                  return (
                    <button
                      key={s.id}
                      role="tab"
                      aria-selected={stage === s.id}
                      onClick={() => setStage(s.id)}
                      className={clsx(
                        'flex items-center gap-1.5 px-3 text-[13px] whitespace-nowrap',
                        stage === s.id ? 'text-ink shadow-[inset_0_-2px_0_var(--c-accent)]' : 'text-muted hover:text-ink',
                      )}
                    >
                      <span className="tabular text-[11.5px] text-faint">{i + 1}</span>
                      {s.label}
                      {n > 0 && <span className={clsx('size-1.5 rounded-full', 'bg-ok')} aria-label="has content" />}
                      <StageWarnBadge count={warns} />
                    </button>
                  );
                })}
                <ChecksToggle checks={checks} open={checksOpen} onToggle={() => setChecksOpen(!checksOpen)} />
              </div>
              {checksOpen && (
                <ChecksPanel checks={checks} stage={stage} onGoToStage={setStage} onShowOnCanvas={showOnCanvas} onClose={() => setChecksOpen(false)} />
              )}
              {store.state === 'conflict' && (
                <div className="flex items-center gap-2 border-b border-err/40 bg-err-soft px-3 py-1.5 text-[12.5px] text-err">
                  This design was changed in another tab or window. Autosave is paused.
                  <span className="ml-auto flex gap-1.5">
                    <Button size="sm" variant="primary" onClick={() => store.keepMine()}>
                      Keep this version
                    </Button>
                    <Button size="sm" onClick={store.useTheirs}>
                      Load the other version
                    </Button>
                  </span>
                </div>
              )}
              {store.state === 'error' && (
                <div className="flex items-center gap-2 border-b border-err/40 bg-err-soft px-3 py-1.5 text-[12.5px] text-err">
                  Could not save: {store.error}
                  <Button size="sm" className="ml-auto" onClick={() => store.save()}>
                    Retry save
                  </Button>
                </div>
              )}
              <div className="min-h-0 flex-1 bg-panel">
                {stage === 'diagram' ? (
                  <Suspense fallback={<Spinner className="m-6" />}>
                    <DiagramCanvas
                      key={`${session.id}:${store.docRevision}`}
                      elements={doc.diagram.elements}
                      dark={dark}
                      highlight={highlight}
                      onDirty={store.markDirty}
                      flushRef={canvasFlush}
                      onChange={(elements) => update((d) => ({ ...d, diagram: { ...d.diagram, elements } }))}
                    />
                  </Suspense>
                ) : (
                  <div className="h-full overflow-auto px-6 py-5">
                    <div className="max-w-[1000px]">
                      {stage === 'requirements' && <RequirementsStage doc={doc} update={update} />}
                      {stage === 'estimates' && <EstimatesStage doc={doc} update={update} />}
                      {stage === 'api' && <ApiStage doc={doc} update={update} />}
                      {stage === 'entities' && <EntitiesStage doc={doc} update={update} />}
                      {stage === 'notes' && <NotesStage doc={doc} update={update} />}
                      <StageNav stage={stage} setStage={setStage} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Panel>
          <ToggleResizeHandle side="after" collapsed={reviewPanel.collapsed} onToggle={reviewPanel.toggle} label="reviews panel" />
          <Panel id="review" order={3} defaultSize={28} minSize={16} collapsible {...reviewPanel.panelProps}>
            <HldReviewPanel sessionId={session.id} onHighlight={showOnCanvas} />
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}

function StageNav({ stage, setStage }: { stage: Stage; setStage: (s: Stage) => void }) {
  const i = STAGES.findIndex((s) => s.id === stage);
  return (
    <div className="mt-8 flex gap-2 border-t border-line pt-4">
      {i > 0 && <Button onClick={() => setStage(STAGES[i - 1].id)}>Back: {STAGES[i - 1].label}</Button>}
      {i < STAGES.length - 1 && (
        <Button variant="primary" onClick={() => setStage(STAGES[i + 1].id)}>
          Next: {STAGES[i + 1].label}
        </Button>
      )}
    </div>
  );
}

function TopBar({ session, store, flushAll }: { session: HldSession; store: ReturnType<typeof useHldDoc>; flushAll: () => Promise<boolean> }) {
  const qc = useQc();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    // Asked on a user gesture so the browser allows the prompt; the review-done notice needs it.
    void ensureNotificationPermission();
    try {
      if (!(await flushAll())) {
        toast('err', 'Resolve the save problem before submitting.');
        return;
      }
      const res = await post<{ submission: HldSubmission; job: Job | null; duplicate: boolean }>(`/api/hld/sessions/${session.id}/submissions`);
      qc.invalidateQueries({ queryKey: hk.submissions(session.id) });
      toast(res.duplicate ? 'info' : 'ok', res.duplicate ? `No changes since design #${res.submission.seq}; showing it.` : `Submitted design #${res.submission.seq} for review.`);
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-canvas px-3">
      <Logo />
      <span className="h-5 w-px bg-line" aria-hidden />
      <span className="truncate font-medium">{session.problemTitle}</span>
      <Badge tone="info">HLD</Badge>
      <Badge tone={session.mode === 'interview' ? 'accent' : 'neutral'}>{session.mode === 'interview' ? 'Interview' : 'Practice'}</Badge>
      <Timer session={session} />
      <SaveState state={store.state} />
      {store.otherTabs > 0 && (
        <Badge tone="info" title="Saves from either tab are picked up automatically. If both tabs change the design, you'll be asked which version to keep.">
          Also open in {store.otherTabs === 1 ? 'another tab' : `${store.otherTabs} other tabs`}
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} busy={busy} onClick={submit} data-testid="hld-submit">
          Submit for review
        </Button>
        <span className="hidden xl:block">
          <StatusChips />
        </span>
      </div>
    </header>
  );
}

function SaveState({ state }: { state: DocSaveState }) {
  const map: Record<DocSaveState, [string, string]> = {
    saved: ['All changes saved', 'text-faint'],
    dirty: ['Unsaved changes', 'text-accent'],
    saving: ['Saving…', 'text-muted'],
    error: ['Save failed', 'text-err'],
    conflict: ['Conflict: needs your decision', 'text-err'],
  };
  const [t, c] = map[state];
  return (
    <span className={clsx('text-[12px] whitespace-nowrap', c)} role="status" data-testid="hld-save-state">
      {t}
    </span>
  );
}

function Timer({ session }: { session: HldSession }) {
  const qc = useQc();
  const toast = useToast();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const t = session.timer;
  const ms = elapsed(t);
  const limit = t.durationMinutes ? t.durationMinutes * 60_000 : null;
  const remaining = limit != null ? limit - ms : null;
  const over = remaining != null && remaining < 0;
  const low = remaining != null && remaining >= 0 && remaining < 5 * 60_000;
  const toggle = async () => {
    try {
      const s = await post<HldSession>(`/api/hld/sessions/${session.id}/timer`, { action: t.runningSince ? 'pause' : 'resume' });
      qc.setQueryData(['hld-session-meta', session.id], s);
    } catch (e) {
      toast('err', errorMessage(e));
    }
  };
  return (
    <div className="flex items-center gap-1">
      <TimerIcon className={clsx('size-3.5', over || low ? 'text-err' : 'text-accent')} aria-hidden />
      <span className={clsx('tabular font-mono text-[15px] font-medium', over || low ? 'text-err' : 'text-accent', !t.runningSince && 'opacity-60')} role="timer">
        {remaining != null ? (over ? `+${formatDuration(-remaining)}` : formatDuration(remaining)) : formatDuration(ms)}
      </span>
      {!t.runningSince && <span className="text-[11.5px] text-faint">{t.autoPaused ? 'paused while away' : 'paused'}</span>}
      {session.mode === 'practice' && (
        <IconButton label={t.runningSince ? 'Pause timer' : 'Resume timer'} onClick={toggle}>
          {t.runningSince ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </IconButton>
      )}
    </div>
  );
}

function useHeartbeat(sessionId: string) {
  const qc = useQc();
  useEffect(() => {
    const beat = () =>
      void post(`/api/hld/sessions/${sessionId}/heartbeat`)
        .then((timer) => qc.setQueryData<HldSession>(['hld-session-meta', sessionId], (s) => (s ? { ...s, timer: timer as HldSession['timer'] } : s)))
        .catch(() => {});
    beat();
    const t = setInterval(beat, 30_000);
    return () => clearInterval(t);
  }, [sessionId, qc]);
}

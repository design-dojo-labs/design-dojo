import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { ToggleResizeHandle, usePanelToggle } from '../components/PanelToggle';
import clsx from 'clsx';
import { BookText, FolderTree, Hammer, Lightbulb, Minus, Moon, Pause, Play, Plus, Search, Send, Square, Sun, TestTube2, Timer as TimerIcon } from 'lucide-react';
import type { ExecKind, Session, Settings, SubmissionSummary, Job } from '@lld/shared';
import { CLIENT_ID, errorMessage, post, put } from '../lib/api';
import { useEventsConnected, useServerEvents } from '../lib/events';
import { broadcastSaved, lldScope, onPeerSaved, usePeerTabs } from '../lib/tabsync';
import { ensureNotificationPermission } from '../lib/notify';
import { qk, useQc, useSession, useSettings } from '../lib/queries';
import { formatDuration } from '../lib/format';
import { Badge, Button, ErrorNote, IconButton, Spinner, useToast } from '../components/ui';
import { Logo, StatusChips } from '../components/Shell';
import { WorkspaceFiles, type SaveState } from './buffers';
import { useFilesVersion, useWorkspace, WorkspaceProvider, type LeftView } from './context';
import { ExecProvider, useExec } from './exec';
import { EditorArea } from './EditorArea';
import { FileTree, treeKey, useTree } from './FileTree';
import { BottomPanel } from './BottomPanel';
import { HintsPanel, ProblemPanel, SearchPanel } from './SidePanels';
import { ReviewPanel } from './ReviewPanel';
import { elapsed } from './timer';

export function WorkspacePage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const session = useSession(id);
  const settings = useSettings();
  const delayRef = useRef(800);
  delayRef.current = settings.data?.editor.autosaveDelayMs ?? 800;
  const files = useMemo(() => new WorkspaceFiles(id, () => delayRef.current), [id]);
  useEffect(() => () => files.dispose(), [files]);

  if (session.isLoading) return <Spinner className="m-6" />;
  if (session.error || !session.data)
    return (
      <div className="p-6">
        <ErrorNote>{errorMessage(session.error ?? 'Session not found')}</ErrorNote>
        <Link to="/lld" className="mt-3 inline-block text-focus underline">
          Back to LLD practice
        </Link>
      </div>
    );
  return (
    <WorkspaceProvider session={session.data} files={files} initialSubmission={params.get('submission')}>
      <ExecProvider sessionId={id}>
        <Workspace />
      </ExecProvider>
    </WorkspaceProvider>
  );
}

function Workspace() {
  const leftPanel = usePanelToggle();
  const consolePanel = usePanelToggle();
  const rightPanel = usePanelToggle();
  const ws = useWorkspace();
  const { session, files } = ws;
  const toast = useToast();
  useHeartbeat(session.id);
  useEffect(() => {
    files.onExternalReload = (p) => toast('info', `${p} changed on disk and was reloaded.`);
  }, [files, toast]);
  // Poll the tree (always, not only when the Files panel is open) to catch edits made in other editors.
  const tree = useTree(session.id);
  useEffect(() => {
    if (tree.data) void files.checkExternal(tree.data.entries);
  }, [tree.data, files]);
  // Changes made through the studio by another tab (or an import) arrive as events: refresh at once
  // instead of waiting for the next poll, so this tab never autosaves on top of a stale version.
  const qc = useQc();
  const refreshTree = useCallback(() => void qc.invalidateQueries({ queryKey: treeKey(session.id) }), [qc, session.id]);
  useServerEvents((ev) => {
    if (ev.type === 'fs-changed' && ev.sessionId === session.id && ev.clientId !== CLIENT_ID) refreshTree();
  });
  useEffect(() => {
    files.onSaved = (path, hash) => broadcastSaved(lldScope(session.id), { path, hash });
    const off = onPeerSaved(lldScope(session.id), refreshTree);
    return () => {
      off();
      files.onSaved = () => {};
    };
  }, [files, session.id, refreshTree]);
  // Events missed while the stream was disconnected are caught by re-reading the tree on reconnect.
  const connected = useEventsConnected();
  useEffect(() => {
    if (connected) refreshTree();
  }, [connected, refreshTree]);
  // Restore previously open tabs.
  useEffect(() => {
    for (const t of ws.tabs) if (t.kind === 'ws') void files.open(t.path).catch(() => ws.closeTab(t.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (files.aggregate() !== 'saved') e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [files]);
  // Cmd/Ctrl+S outside the editor saves everything instead of opening the browser's save dialog.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void files.flushAll();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [files]);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="lld.ws.columns">
          <Panel id="left" order={1} defaultSize={24} minSize={14} collapsible {...leftPanel.panelProps}>
            <LeftSidebar />
          </Panel>
          <ToggleResizeHandle side="before" collapsed={leftPanel.collapsed} onToggle={leftPanel.toggle} label="side panel" />
          <Panel id="center" order={2} minSize={30}>
            <PanelGroup direction="vertical" autoSaveId="lld.ws.center">
              <Panel id="editor" order={1} minSize={25}>
                <EditorArea />
              </Panel>
              <ToggleResizeHandle direction="vertical" side="after" collapsed={consolePanel.collapsed} onToggle={consolePanel.toggle} label="console" />
              <Panel id="console" order={2} defaultSize={30} minSize={8} collapsible {...consolePanel.panelProps}>
                <BottomPanel />
              </Panel>
            </PanelGroup>
          </Panel>
          <ToggleResizeHandle side="after" collapsed={rightPanel.collapsed} onToggle={rightPanel.toggle} label="reviews panel" />
          <Panel id="right" order={3} defaultSize={28} minSize={18} collapsible {...rightPanel.panelProps}>
            <ReviewPanel />
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}

function LeftSidebar() {
  const ws = useWorkspace();
  const items: { id: LeftView; label: string; icon: React.ReactNode; disabled?: boolean }[] = [
    { id: 'problem', label: 'Problem', icon: <BookText className="size-4" /> },
    { id: 'files', label: 'Files', icon: <FolderTree className="size-4" /> },
    { id: 'search', label: 'Search', icon: <Search className="size-4" /> },
    { id: 'hints', label: ws.session.mode === 'interview' ? 'Hints (off in interview mode)' : 'Hints', icon: <Lightbulb className="size-4" /> },
  ];
  return (
    <div className="flex h-full bg-canvas">
      <nav className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-line py-2" aria-label="Side panels">
        {items.map((i) => (
          <button
            key={i.id}
            aria-label={i.label}
            title={i.label}
            aria-pressed={ws.leftView === i.id}
            onClick={() => ws.setLeftView(i.id)}
            className={clsx('flex size-8 items-center justify-center rounded-[5px]', ws.leftView === i.id ? 'bg-select text-ink' : 'text-muted hover:bg-sunken hover:text-ink')}
          >
            {i.icon}
          </button>
        ))}
        <button
          aria-label="Open design notes"
          title="Design notes (DESIGN_NOTES.md)"
          onClick={() => ws.openFile('DESIGN_NOTES.md').catch(() => {})}
          className="mt-auto flex size-8 items-center justify-center rounded-[5px] font-mono text-[11px] text-muted hover:bg-sunken hover:text-ink"
        >
          MD
        </button>
      </nav>
      <div className="min-w-0 flex-1 bg-panel">
        {ws.leftView === 'problem' && <ProblemPanel />}
        {ws.leftView === 'files' && <FileTree />}
        {ws.leftView === 'search' && <SearchPanel />}
        {ws.leftView === 'hints' && <HintsPanel />}
      </div>
    </div>
  );
}

function TopBar() {
  const ws = useWorkspace();
  const { session, files } = ws;
  const exec = useExec();
  const toast = useToast();
  const qc = useQc();
  const settings = useSettings().data;
  useFilesVersion(files);
  const save = files.aggregate();
  const otherTabs = usePeerTabs(lldScope(session.id));
  const [submitting, setSubmitting] = useState(false);
  const busy = !!exec.running;

  const runKind = async (kind: ExecKind) => {
    const unsaved = await files.flushAll();
    if (unsaved.length) {
      toast('err', `Resolve unsaved changes first: ${unsaved.join(', ')}`);
      return;
    }
    try {
      ws.setBottomView('output');
      await exec.start(kind, kind === 'run' ? { mainClass: session.runConfig.mainClass, args: session.runConfig.args, stdin: session.runConfig.stdin } : {});
    } catch (e) {
      toast('err', errorMessage(e));
    }
  };

  const submit = async () => {
    void ensureNotificationPermission(); // asked once, from this click, so "review ready" can notify later
    setSubmitting(true);
    try {
      const unsaved = await files.flushAll();
      if (unsaved.length) {
        toast('err', `Can't submit until these files are saved: ${unsaved.join(', ')}`);
        return;
      }
      const res = await post<{ submission: SubmissionSummary; job: Job | null; duplicate: boolean }>(`/api/sessions/${session.id}/submissions`);
      ws.selectSubmission(res.submission.id);
      qc.invalidateQueries({ queryKey: qk.submissions(session.id) });
      qc.invalidateQueries({ queryKey: qk.session(session.id) });
      toast(res.duplicate ? 'info' : 'ok', res.duplicate ? `No changes since submission #${res.submission.seq}; showing it instead of creating a duplicate.` : `Submitted snapshot #${res.submission.seq}. Building, testing, then reviewing.`);
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const setEditor = async (patch: Partial<Settings['editor']>) => {
    try {
      qc.setQueryData(qk.settings, await put<Settings>('/api/settings', { editor: patch }));
    } catch (e) {
      toast('err', errorMessage(e));
    }
  };

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-canvas px-3">
      <Logo />
      <span className="h-5 w-px bg-line" aria-hidden />
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium" title={session.problemTitle}>
          {session.problemTitle}
        </span>
        <Badge tone={session.mode === 'interview' ? 'accent' : 'neutral'}>{session.mode === 'interview' ? 'Interview' : 'Practice'}</Badge>
        {session.solutionRevealed && <Badge tone="warn">reference revealed</Badge>}
      </div>
      <Timer />
      <SaveIndicator state={save} />
      {otherTabs > 0 && (
        <Badge
          tone="info"
          title="Saves from either tab are picked up automatically. If both tabs change the same file, you'll be asked which version to keep."
        >
          Also open in {otherTabs === 1 ? 'another tab' : `${otherTabs} other tabs`}
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <Button size="sm" icon={<Hammer className="size-3.5" />} disabled={busy} onClick={() => runKind('compile')} title="Compile main and test sources">
          Compile
        </Button>
        <Button size="sm" icon={<Play className="size-3.5" />} disabled={busy} onClick={() => runKind('run')} title={`Run ${session.runConfig.mainClass ?? 'the main class'} (configure in Run settings)`}>
          Run
        </Button>
        <Button size="sm" icon={<TestTube2 className="size-3.5" />} disabled={busy} onClick={() => runKind('test')}>
          Run tests
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon={<Square className="size-3 fill-current" />}
          disabled={!busy}
          onClick={() => exec.stop().catch((e) => toast('err', errorMessage(e)))}
          title="Stop the running process"
        >
          Stop
        </Button>
        <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} busy={submitting} onClick={submit} data-testid="submit">
          Submit for review
        </Button>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <IconButton label="Smaller editor font" onClick={() => settings && setEditor({ fontSize: Math.max(10, settings.editor.fontSize - 1) })}>
          <Minus className="size-3.5" />
        </IconButton>
        <span className="tabular w-5 text-center text-[11.5px] text-faint">{settings?.editor.fontSize}</span>
        <IconButton label="Larger editor font" onClick={() => settings && setEditor({ fontSize: Math.min(28, settings.editor.fontSize + 1) })}>
          <Plus className="size-3.5" />
        </IconButton>
        <IconButton label="Toggle light/dark theme" onClick={() => settings && setEditor({ theme: settings.editor.theme === 'dark' ? 'light' : 'dark' })}>
          {settings?.editor.theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
        </IconButton>
        <span className="hidden xl:block">
          <StatusChips />
        </span>
      </div>
    </header>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const { files, openFile } = useWorkspace();
  const toast = useToast();
  const map: Record<SaveState, [string, string]> = {
    saved: ['All changes saved', 'text-faint'],
    dirty: ['Unsaved changes', 'text-accent'],
    saving: ['Saving…', 'text-muted'],
    error: ['Save failed — retry', 'text-err'],
    conflict: ['Conflict: needs your decision', 'text-err'],
  };
  const [text, cls] = map[state];
  if (state === 'conflict') {
    // Autosave pauses for a file that changed elsewhere while it had edits here; jump to its banner.
    const paths = files.conflictPaths();
    const name = paths.length === 1 ? paths[0].split('/').pop() : `${paths.length} files`;
    return (
      <button
        className={clsx('rounded-[4px] text-[12px] whitespace-nowrap underline decoration-dotted underline-offset-2', cls)}
        role="status"
        aria-live="polite"
        data-testid="save-state"
        title={`Changed in another tab or outside the studio while you had unsaved edits: ${paths.join(', ')}. Autosave is paused for ${paths.length === 1 ? 'this file' : 'these files'} until you choose a version.`}
        onClick={() => paths[0] && openFile(paths[0]).catch((e) => toast('err', errorMessage(e)))}
      >
        Conflict in {name}: choose a version
      </button>
    );
  }
  if (state === 'error') {
    return (
      <button
        className={clsx('rounded-[4px] text-[12px] whitespace-nowrap underline decoration-dotted underline-offset-2', cls)}
        role="status"
        aria-live="polite"
        data-testid="save-state"
        onClick={() =>
          void files.flushAll().then((left) => {
            if (left.length) toast('err', `Still not saved: ${left.join(', ')}`);
          })
        }
      >
        {text}
      </button>
    );
  }
  return (
    <span className={clsx('text-[12px] whitespace-nowrap', cls)} role="status" aria-live="polite" data-testid="save-state">
      {text}
    </span>
  );
}

function Timer() {
  const { session } = useWorkspace();
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
      const s = await post<Session>(`/api/sessions/${session.id}/timer`, { action: t.runningSince ? 'pause' : 'resume' });
      qc.setQueryData(qk.session(session.id), s);
    } catch (e) {
      toast('err', errorMessage(e));
    }
  };
  return (
    <div className="flex items-center gap-1">
      <TimerIcon className={clsx('size-3.5', over || low ? 'text-err' : 'text-accent')} aria-hidden />
      <span
        className={clsx('tabular font-mono text-[15px] font-medium', over ? 'text-err' : low ? 'text-err' : 'text-accent', !t.runningSince && 'opacity-60')}
        aria-label={remaining != null ? (over ? `Over time by ${formatDuration(-remaining)}` : `${formatDuration(remaining)} remaining`) : `${formatDuration(ms)} elapsed`}
        role="timer"
      >
        {remaining != null ? (over ? `+${formatDuration(-remaining)}` : formatDuration(remaining)) : formatDuration(ms)}
      </span>
      {over && <span className="text-[11.5px] text-err">over time</span>}
      {!t.runningSince && <span className="text-[11.5px] text-faint">{t.autoPaused ? 'paused while away' : 'paused'}</span>}
      {session.mode === 'practice' && (
        <IconButton label={t.runningSince ? 'Pause timer' : 'Resume timer'} onClick={toggle}>
          {t.runningSince ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </IconButton>
      )}
    </div>
  );
}

/**
 * Keeps the session timer honest: it advances while this workspace page is open (even in a background
 * tab, like a real interview clock) and auto-pauses only when no page has been open for a few minutes.
 */
function useHeartbeat(sessionId: string) {
  const qc = useQc();
  useEffect(() => {
    const beat = () => {
      void post(`/api/sessions/${sessionId}/heartbeat`)
        .then((timer) => qc.setQueryData<Session>(qk.session(sessionId), (s) => (s ? { ...s, timer: timer as Session['timer'] } : s)))
        .catch(() => {});
    };
    beat();
    const t = setInterval(beat, 30_000);
    document.addEventListener('visibilitychange', beat);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [sessionId, qc]);
}

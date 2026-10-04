import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Circle, Lock, X } from 'lucide-react';
import { get } from '../lib/api';
import { basename } from '../lib/format';
import { useSettings } from '../lib/queries';
import { Button, useToast } from '../components/ui';
import { applyMonacoTheme, monaco } from './monaco';
import { useFilesVersion, useWorkspace, type Tab } from './context';

export function EditorArea() {
  const ws = useWorkspace();
  const { files, tabs, activeTabId, reveal } = ws;
  useFilesVersion(files);
  const settings = useSettings().data;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const currentTab = useRef<string | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toast = useToast();
  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  // Create the editor once.
  useEffect(() => {
    if (!host.current) return;
    applyMonacoTheme(document.documentElement.classList.contains('dark'));
    const ed = monaco.editor.create(host.current, {
      automaticLayout: true,
      fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      matchBrackets: 'always',
      tabSize: 4,
      insertSpaces: true,
      detectIndentation: true,
      autoClosingBrackets: 'languageDefined',
      autoIndent: 'full',
      formatOnType: false,
      quickSuggestions: false, // word-based suggestions only; no Java language server is attached
      wordBasedSuggestions: 'currentDocument',
      fixedOverflowWidgets: true,
      padding: { top: 8 },
      model: null,
    });
    editor.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const id = currentTab.current;
      if (id?.startsWith('ws:')) void files.save(id.slice(3));
    });
    decorations.current = ed.createDecorationsCollection();
    return () => {
      ed.dispose();
      editor.current = null;
    };
  }, [files]);

  // Theme + font size follow settings.
  useEffect(() => {
    if (!settings) return;
    applyMonacoTheme(settings.editor.theme === 'dark');
    editor.current?.updateOptions({ fontSize: settings.editor.fontSize });
  }, [settings?.editor.theme, settings?.editor.fontSize, settings]);

  // Switch models when the active tab changes, preserving each tab's scroll/cursor state.
  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    let cancelled = false;
    const prev = currentTab.current;
    if (prev && prev !== active?.id) viewStates.current.set(prev, ed.saveViewState());
    if (!active) {
      ed.setModel(null);
      currentTab.current = null;
      return;
    }
    setLoadError(null);
    modelFor(active)
      .then((model) => {
        if (cancelled || !editor.current) return;
        if (ed.getModel() !== model) {
          ed.setModel(model);
          const vs = viewStates.current.get(active.id);
          if (vs) ed.restoreViewState(vs);
        }
        ed.updateOptions({ readOnly: active.kind !== 'ws' || !!files.get(active.path)?.locked });
        currentTab.current = active.id;
        decorations.current?.clear();
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // Reveal + highlight a cited range (e.g. from a review finding).
  useEffect(() => {
    if (!reveal || !active || reveal.tabId !== active.id) return;
    let tries = 0;
    const apply = () => {
      const ed = editor.current;
      const model = ed?.getModel();
      if (!ed || !model || currentTab.current !== reveal.tabId) {
        if (tries++ < 20) setTimeout(apply, 50);
        return;
      }
      const end = Math.min(reveal.lineEnd, model.getLineCount());
      const start = Math.min(reveal.lineStart, end);
      ed.revealLinesInCenter(start, end);
      ed.setSelection(new monaco.Range(start, 1, start, 1));
      decorations.current?.set([
        { range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)), options: { isWholeLine: true, className: 'finding-highlight', linesDecorationsClassName: 'finding-glyph' } },
      ]);
      ed.focus();
    };
    apply();
  }, [reveal, active]);

  function modelFor(tab: Tab): Promise<monaco.editor.ITextModel> {
    if (tab.kind === 'ws') return files.open(tab.path).then((b) => b.model);
    if (tab.kind === 'snap') {
      return files.readonlyModel(`snap/${tab.submissionId}/${tab.path}`, tab.path, () =>
        get<{ content: string }>(`/api/submissions/${tab.submissionId}/file?path=${encodeURIComponent(tab.path)}`).then((r) => r.content),
      );
    }
    return files.readonlyModel(`ref/${tab.referenceId}/${tab.path}`, tab.path, () =>
      get<{ content: string }>(`/api/references/${tab.referenceId}/file?path=${encodeURIComponent(tab.path)}`).then((r) => r.content),
    );
  }

  const buf = active?.kind === 'ws' ? files.get(active.path) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div role="tablist" aria-label="Open files" className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-canvas">
        {tabs.map((t) => (
          <TabButton key={t.id} tab={t} active={t.id === activeTabId} />
        ))}
        {!tabs.length && <span className="self-center px-3 text-[12.5px] text-faint">No file open. Pick one in the Files panel.</span>}
      </div>
      {active && active.kind !== 'ws' && (
        <div className="flex items-center gap-2 border-b border-line bg-accent-soft px-3 py-1 text-[12.5px]">
          <Lock className="size-3.5" aria-hidden />
          {active.kind === 'snap' ? (
            <>
              <span>
                Submitted snapshot #{active.seq}, read-only. This is the exact code that was reviewed.
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  const line = editor.current?.getPosition()?.lineNumber;
                  ws.openFile(active.path, line).catch((e) => toast('err', `The working copy of ${active.path} can't be opened: ${e.message}`));
                }}
              >
                Open working copy
              </Button>
            </>
          ) : (
            <span>Reference solution, read-only and kept separate from your workspace.</span>
          )}
        </div>
      )}
      {buf?.locked && (
        <div className="flex items-center gap-2 border-b border-line bg-sunken px-3 py-1 text-[12.5px] text-muted">
          <Lock className="size-3.5" aria-hidden /> Managed build file. The studio keeps it identical to the template so builds stay controlled.
        </div>
      )}
      {buf?.state === 'conflict' && <ConflictBanner path={buf.path} diskDeleted={buf.conflict?.diskContent == null} />}
      {buf?.state === 'error' && (
        <div className="flex items-center gap-2 border-b border-err/40 bg-err-soft px-3 py-1 text-[12.5px] text-err">
          Could not save: {buf.error}
          <Button size="sm" className="ml-auto" onClick={() => files.save(buf.path)}>
            Retry save
          </Button>
        </div>
      )}
      {loadError && <div className="border-b border-err/40 bg-err-soft px-3 py-1 text-[12.5px] text-err">{loadError}</div>}
      <div ref={host} className="min-h-0 flex-1" data-testid="editor" />
    </div>
  );
}

function TabButton({ tab, active }: { tab: Tab; active: boolean }) {
  const ws = useWorkspace();
  const b = tab.kind === 'ws' ? ws.files.get(tab.path) : undefined;
  const label = basename(tab.path);
  const unsaved = b && (b.state === 'dirty' || b.state === 'saving' || b.state === 'error' || b.state === 'conflict');
  return (
    <div
      role="tab"
      aria-selected={active}
      title={tab.kind === 'snap' ? `Snapshot #${tab.seq}: ${tab.path}` : tab.path}
      className={clsx(
        'group flex max-w-[16rem] shrink-0 items-center gap-1.5 border-r border-line pr-1 pl-3 text-[12.5px]',
        active ? 'bg-panel text-ink shadow-[inset_0_2px_0_var(--c-accent)]' : 'text-muted hover:bg-sunken',
      )}
    >
      <button className="flex min-w-0 items-center gap-1.5 py-1.5" onClick={() => ws.activate(tab.id)} onAuxClick={(e) => e.button === 1 && ws.closeTab(tab.id)}>
        {tab.kind === 'snap' && <span className="rounded-[3px] bg-accent-soft px-1 text-[10.5px] text-accent">#{tab.seq}</span>}
        {tab.kind === 'ref' && <span className="rounded-[3px] bg-select px-1 text-[10.5px]">ref</span>}
        <span className={clsx('truncate', tab.kind !== 'ws' && 'italic')}>{label}</span>
      </button>
      <button
        aria-label={unsaved ? `${label} has unsaved changes. Close tab` : `Close ${label}`}
        className="relative flex size-5 items-center justify-center rounded-[3px] hover:bg-sunken"
        onClick={() => ws.closeTab(tab.id)}
      >
        {unsaved ? (
          <>
            <Circle className={clsx('size-2.5 fill-current group-hover:hidden', b?.state === 'conflict' || b?.state === 'error' ? 'text-err' : 'text-accent')} aria-hidden />
            <X className="hidden size-3.5 group-hover:block" aria-hidden />
          </>
        ) : (
          <X className="size-3.5 opacity-60 group-hover:opacity-100" aria-hidden />
        )}
      </button>
    </div>
  );
}

function ConflictBanner({ path, diskDeleted }: { path: string; diskDeleted: boolean }) {
  const { files, closeTab } = useWorkspace();
  const [showDisk, setShowDisk] = useState(false);
  const b = files.get(path);
  return (
    <div className="border-b border-err/40 bg-err-soft px-3 py-1.5 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-err">
          {diskDeleted ? `${path} was deleted or moved outside the studio.` : `${path} changed on disk while you had unsaved edits. Autosave is paused for this file.`}
        </span>
        <span className="ml-auto flex gap-1.5">
          <Button size="sm" variant="primary" onClick={() => files.keepMine(path)}>
            {diskDeleted ? 'Recreate with my version' : 'Keep my version'}
          </Button>
          {diskDeleted ? (
            <Button size="sm" onClick={() => closeTab(`ws:${path}`)}>
              Close tab
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={() => files.loadFromDisk(path)}>
                Use disk version
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowDisk((v) => !v)}>
                {showDisk ? 'Hide disk version' : 'Show disk version'}
              </Button>
            </>
          )}
        </span>
      </div>
      {showDisk && b?.conflict?.diskContent != null && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-[4px] border border-line bg-panel p-2 font-mono text-[12px] text-ink">{b.conflict.diskContent}</pre>
      )}
    </div>
  );
}

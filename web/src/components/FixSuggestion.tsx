import { useEffect, useRef, useState } from 'react';
import { Copy, Wand2 } from 'lucide-react';
import type { FileContent, FixSuggestion as Fix, StoredFinding, Submission } from '@lld/shared';
import { ApiError, errorMessage, get, put } from '../lib/api';
import { requestFix, useAnswerPartial } from '../lib/interactive';
import { isActiveJob, useJob } from '../lib/queries';
import { useWorkspace } from '../workspace/context';
import { languageFor, monaco } from '../workspace/monaco';
import { JobEta } from './JobEta';
import { Badge, Button, ErrorNote, Markdown, Spinner, useToast } from './ui';

type Edit = Fix['edits'][number];

/**
 * "Suggest a fix" for one LLD finding: the AI proposes complete new versions of the cited file (and
 * maybe a test). Shown as a diff against the submitted snapshot. Nothing is written until the
 * learner applies an edit, and applying checks the CURRENT working copy first.
 */
export function FixSuggestion({
  submission,
  finding,
  fix,
  pendingJobId,
  disabledReason,
  onChanged,
}: {
  submission: Submission;
  finding: StoredFinding;
  fix: Fix | undefined;
  pendingJobId: string | undefined;
  disabledReason: string | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const toast = useToast();
  const jobId = pendingJobId ?? startedJobId;
  const job = useJob(jobId).data;
  const pending = isActiveJob(job) || (!!pendingJobId && !job);
  const partial = useAnswerPartial(pending ? jobId : null);

  const request = async () => {
    setOpen(true);
    setBusy(true);
    try {
      const j = await requestFix(submission.id, finding.id);
      setStartedJobId(j.id);
      onChanged();
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open && !pending) {
    return (
      <button
        className={disabledReason ? 'inline-flex cursor-not-allowed items-center gap-1 text-[12px] text-faint' : 'inline-flex items-center gap-1 text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline'}
        onClick={() => !disabledReason && (fix ? setOpen(true) : void request())}
        title={disabledReason ?? 'Ask the reviewer for a focused fix you can compare and apply'}
        aria-disabled={!!disabledReason}
        data-testid="fix-open"
      >
        <Wand2 className="size-3.5" aria-hidden />
        {fix ? 'Show suggested fix' : 'Suggest a fix'}
      </button>
    );
  }

  return (
    <div className="mt-1 w-full basis-full rounded-[5px] border border-line bg-sunken p-2 text-[12.5px]" data-testid="fix-suggestion">
      <div className="flex items-center gap-2">
        <span className="font-medium">Suggested fix</span>
        {fix?.isMock && <Badge tone="warn">MOCK</Badge>}
        <span className="text-[11.5px] text-faint">Compare it with your own approach; nothing is applied automatically.</span>
        <button className="ml-auto text-[12px] text-muted hover:text-ink" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      {pending && (
        <div className="mt-2" aria-live="polite">
          <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
            <Spinner className="size-3" /> Writing a fix…
          </div>
          {typeof partial?.explanation === 'string' && partial.explanation && <p className="mt-1 text-muted">{partial.explanation}</p>}
          {job && <JobEta job={job} className="mt-1" />}
        </div>
      )}
      {!pending && job?.state === 'failed' && <ErrorNote>{job.error?.message ?? 'The fix suggestion failed.'}</ErrorNote>}
      {fix && !pending && (
        <>
          <Markdown className="mt-1.5 text-muted">{fix.explanation}</Markdown>
          {fix.edits.map((e) => (
            <EditView key={e.path} edit={e} submission={submission} />
          ))}
          <Button className="mt-2" size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />} busy={busy} onClick={() => void request()}>
            Suggest again
          </Button>
        </>
      )}
    </div>
  );
}

function EditView({ edit, submission }: { edit: Edit; submission: Submission }) {
  const ws = useWorkspace();
  const toast = useToast();
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'diverged'; current: FileContent | null } | { kind: 'applied' } | { kind: 'error'; message: string }>({ kind: 'idle' });

  const write = async (current: FileContent | null) => {
    setState({ kind: 'busy' });
    try {
      await put(`/api/sessions/${ws.session.id}/file`, { path: edit.path, content: edit.newContent, baseHash: current?.hash ?? null });
      // This tab caused the change, so its own editor buffer has to pick it up explicitly.
      if (ws.files.get(edit.path)) await ws.files.loadFromDisk(edit.path);
      setState({ kind: 'applied' });
      toast('ok', `Applied the suggested ${edit.path.split('/').pop()} to your working copy.`);
    } catch (e) {
      setState({ kind: 'error', message: e instanceof ApiError && e.status === 409 ? `${edit.path} changed again meanwhile. Try Apply once more.` : errorMessage(e) });
    }
  };

  const apply = async () => {
    const buffer = ws.files.get(edit.path);
    if (buffer && buffer.state !== 'saved') {
      setState({ kind: 'error', message: `${edit.path} has unsaved edits in the editor. Save them (or undo them) first.` });
      return;
    }
    setState({ kind: 'busy' });
    let current: FileContent | null = null;
    try {
      current = await get<FileContent>(`/api/sessions/${ws.session.id}/file?path=${encodeURIComponent(edit.path)}`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) {
        setState({ kind: 'error', message: errorMessage(e) });
        return;
      }
    }
    // Only a working copy that still matches the reviewed snapshot is replaced without asking.
    if ((current?.content ?? null) !== edit.originalContent) setState({ kind: 'diverged', current });
    else await write(current);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(edit.newContent);
      toast('ok', 'Suggested code copied.');
    } catch {
      toast('err', 'Could not access the clipboard.');
    }
  };

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[12px]">{edit.path}</span>
        {edit.originalContent == null && <Badge tone="info">new file</Badge>}
        <span className="text-[11px] text-faint">snapshot #{submission.seq} → suggested</span>
      </div>
      <SuggestionDiff path={edit.path} original={edit.originalContent ?? ''} modified={edit.newContent} />
      {state.kind === 'diverged' && (
        <div className="mt-1.5 rounded-[4px] border border-accent/50 bg-panel px-2 py-1.5" role="alert">
          {state.current
            ? `Your working copy of ${edit.path} has changed since snapshot #${submission.seq}. Applying replaces the whole file with the suggestion, including your newer edits.`
            : `${edit.path} no longer exists in your working copy. Applying creates it again.`}
          <div className="mt-1.5 flex gap-1.5">
            <Button size="sm" variant="danger" onClick={() => void write(state.current)}>
              Apply anyway (overwrite)
            </Button>
            <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => void copy()}>
              Copy instead
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setState({ kind: 'idle' })}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {state.kind === 'error' && <p className="mt-1 text-err">{state.message}</p>}
      {state.kind !== 'diverged' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Button size="sm" busy={state.kind === 'busy'} onClick={() => void apply()} data-testid="fix-apply">
            Apply to working copy
          </Button>
          <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copy()}>
            Copy
          </Button>
          {state.kind === 'applied' && (
            <button className="text-[12px] text-focus underline-offset-2 hover:underline" onClick={() => void ws.openFile(edit.path).catch(() => {})}>
              Applied — open {edit.path.split('/').pop()}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SuggestionDiff({ path, original, modified }: { path: string; original: string; modified: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const editor = monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: false,
      minimap: { enabled: false },
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 12,
      scrollBeyondLastLine: false,
      hideUnchangedRegions: { enabled: true },
    });
    const lang = languageFor(path);
    const a = monaco.editor.createModel(original, lang);
    const b = monaco.editor.createModel(modified, lang);
    editor.setModel({ original: a, modified: b });
    return () => {
      editor.dispose();
      a.dispose();
      b.dispose();
    };
  }, [path, original, modified]);
  return <div ref={host} className="mt-1 h-[260px] rounded-[4px] border border-line" data-testid="fix-diff" />;
}

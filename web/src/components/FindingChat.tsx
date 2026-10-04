import { useState } from 'react';
import clsx from 'clsx';
import { MessageSquare, RotateCcw, Send } from 'lucide-react';
import type { ReviewThread, ReviewTrack } from '@lld/shared';
import { errorMessage } from '../lib/api';
import { askAbout, useAnswerPartial } from '../lib/interactive';
import { isActiveJob, useJob } from '../lib/queries';
import { JobEta } from './JobEta';
import { Button, Markdown, Spinner, useToast } from './ui';

/**
 * "Ask about this": a follow-up thread scoped to one finding (LLD) or improvement (HLD). Answers are
 * background AI jobs; the answer streams in while it is written.
 */
export function FindingChat({
  track,
  submissionId,
  itemKey,
  thread,
  disabledReason,
  onChanged,
}: {
  track: ReviewTrack;
  submissionId: string;
  itemKey: string;
  thread: ReviewThread | undefined;
  /** Set when chat is unavailable (e.g. interview mode); the button explains why. */
  disabledReason: string | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const toast = useToast();
  const pendingId = thread?.pendingJobId ?? startedJobId;
  const job = useJob(pendingId).data;
  const pending = isActiveJob(job) || (!!thread?.pendingJobId && !job);
  const partial = useAnswerPartial(pending ? pendingId : null);
  const messages = thread?.messages ?? [];
  const last = messages[messages.length - 1];
  const failed = !pending && job?.state === 'failed' && last?.role === 'user';
  const unanswered = !pending && last?.role === 'user';

  const send = async (message: string) => {
    setBusy(true);
    try {
      const res = await askAbout(track, submissionId, itemKey, message);
      setStartedJobId(res.job.id);
      setDraft('');
      onChanged();
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        className={clsx('inline-flex items-center gap-1 text-[12px] underline-offset-2', disabledReason ? 'cursor-not-allowed text-faint' : 'text-muted hover:text-ink hover:underline')}
        onClick={() => !disabledReason && setOpen(true)}
        title={disabledReason ?? 'Ask the reviewer a follow-up question about this point'}
        aria-disabled={!!disabledReason}
        data-testid="ask-open"
      >
        <MessageSquare className="size-3.5" aria-hidden />
        Ask{messages.length ? ` (${messages.filter((m) => m.role === 'assistant').length})` : ''}
      </button>
    );
  }

  return (
    <div className="mt-1 w-full basis-full rounded-[5px] border border-line bg-sunken p-2 text-[12.5px]" data-testid="finding-chat">
      <div className="flex items-center gap-2">
        <span className="font-medium">Follow-up</span>
        <span className="text-[11.5px] text-faint">Scores don't change; this is for understanding.</span>
        <button className="ml-auto text-[12px] text-muted hover:text-ink" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      {messages.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {messages.map((m) => (
            <li key={m.id} className={clsx('rounded-[4px] px-2 py-1.5', m.role === 'user' ? 'ml-6 bg-panel' : 'mr-6 border border-line bg-panel')}>
              <div className="mb-0.5 text-[11px] text-faint">
                {m.role === 'user' ? 'You' : `Reviewer${m.isMock ? ' (MOCK)' : ''}`}
              </div>
              {m.role === 'user' ? <p className="whitespace-pre-wrap">{m.text}</p> : <Markdown>{m.text}</Markdown>}
              {m.codeSnippet && <pre className="mt-1 max-h-60 overflow-auto rounded-[4px] border border-line bg-sunken p-2 font-mono text-[11.5px]">{m.codeSnippet}</pre>}
            </li>
          ))}
        </ul>
      )}
      {pending && (
        <div className="mt-2 mr-6 rounded-[4px] border border-dashed border-line bg-panel px-2 py-1.5" aria-live="polite">
          <div className="flex items-center gap-1.5 text-[11px] text-faint">
            <Spinner className="size-3" /> Reviewer is writing…
          </div>
          {typeof partial?.answer === 'string' && partial.answer && <Markdown className="mt-1">{partial.answer}</Markdown>}
          {job && <JobEta job={job} className="mt-1" />}
        </div>
      )}
      {failed && <p className="mt-2 text-err">The answer failed: {job?.error?.message ?? 'unknown error'}.</p>}
      {unanswered && (
        <Button className="mt-2" size="sm" icon={<RotateCcw className="size-3.5" />} busy={busy} onClick={() => void send('')}>
          Retry the last question
        </Button>
      )}
      {!unanswered && (
        <form
          className="mt-2 flex items-end gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void send(draft);
          }}
        >
          <textarea
            className="min-h-[52px] flex-1 resize-y rounded-[4px] border border-line bg-panel px-2 py-1 text-[12.5px]"
            placeholder={messages.length ? 'Ask a follow-up…' : 'e.g. Why is this a problem? How would you fix it?'}
            value={draft}
            maxLength={2000}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) {
                e.preventDefault();
                void send(draft);
              }
            }}
            aria-label="Your question"
          />
          <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} busy={busy} disabled={pending || !draft.trim()} type="submit">
            Ask
          </Button>
        </form>
      )}
    </div>
  );
}

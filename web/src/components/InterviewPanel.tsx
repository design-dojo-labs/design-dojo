import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Mic, RotateCcw, Send, Square } from 'lucide-react';
import type { InterviewSession, ReviewTrack } from '@lld/shared';
import { errorMessage } from '../lib/api';
import { answerInterview, endInterview, startInterview, useAnswerPartial } from '../lib/interactive';
import { isActiveJob, useJob } from '../lib/queries';
import { JobEta } from './JobEta';
import { Badge, Button, Spinner, useToast } from './ui';

const SCORE_TONE = { strong: 'ok', ok: 'warn', weak: 'err' } as const;

/**
 * Mock interviewer: walks through the review's follow-up questions one at a time, judges each
 * typed answer, may probe once per topic, and ends with a short summary.
 */
export function InterviewPanel({
  track,
  submissionId,
  interview,
  questionCount,
  unavailableReason,
  onChanged,
}: {
  track: ReviewTrack;
  submissionId: string;
  interview: InterviewSession | null;
  questionCount: number;
  /** Set while the follow-up questions don't exist yet (e.g. review detail still running). */
  unavailableReason: string | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const toast = useToast();
  const jobId = interview?.pendingJobId ?? startedJobId;
  const job = useJob(jobId).data;
  const pending = isActiveJob(job) || (!!interview?.pendingJobId && !job);
  const partial = useAnswerPartial(pending ? jobId : null);
  const failed = !pending && job?.state === 'failed';
  // Keep the typed answer until the interviewer has accepted it, so a failed turn can be resent.
  const [sentAtTurns, setSentAtTurns] = useState<number | null>(null);
  const answered = interview?.turns.length ?? 0;
  useEffect(() => {
    if (sentAtTurns !== null && answered > sentAtTurns) {
      setDraft('');
      setSentAtTurns(null);
    }
  }, [answered, sentAtTurns]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const begin = (restart = false) =>
    run(async () => {
      await startInterview(track, submissionId, restart);
      setOpen(true);
      setStartedJobId(null);
    });
  const send = () =>
    interview &&
    run(async () => {
      const res = await answerInterview(interview.id, draft);
      setStartedJobId(res.job.id);
      setSentAtTurns(interview.turns.length);
    });

  if (!open) {
    return (
      <div className="mt-5 flex flex-wrap items-center gap-2 rounded-[5px] border border-line px-3 py-2 text-[12.5px]" data-testid="interview-entry">
        <Mic className="size-4 text-muted" aria-hidden />
        <span className="text-muted">
          {interview?.state === 'active'
            ? `Practice round in progress (${interview.turns.length} answered).`
            : interview?.state === 'ended'
              ? `Last practice round: ${interview.summary ?? 'ended'}`
              : `Practise the ${questionCount || ''} follow-up question${questionCount === 1 ? '' : 's'} with a mock interviewer.`}
        </span>
        <Button
          size="sm"
          className="ml-auto"
          busy={busy}
          disabled={!!unavailableReason || !questionCount}
          title={unavailableReason ?? undefined}
          onClick={() => (interview?.state === 'active' ? setOpen(true) : void begin(interview?.state === 'ended'))}
        >
          {interview?.state === 'active' ? 'Continue' : interview?.state === 'ended' ? 'Practise again' : 'Practice follow-up questions'}
        </Button>
        {interview?.state === 'ended' && (
          <button className="text-[12px] text-muted hover:text-ink" onClick={() => setOpen(true)}>
            View transcript
          </button>
        )}
      </div>
    );
  }

  const ended = !interview || interview.state === 'ended';
  return (
    <section className="mt-5 rounded-[5px] border border-line bg-panel p-3 text-[13px]" data-testid="interview-panel" aria-label="Mock interview">
      <div className="flex items-center gap-2">
        <Mic className="size-4 text-muted" aria-hidden />
        <h3 className="text-[13px] font-semibold">Mock interviewer</h3>
        {interview && (
          <span className="text-[11.5px] text-faint">
            {interview.turns.length} of at most {interview.maxTurns} answers
          </span>
        )}
        <button className="ml-auto text-[12px] text-muted hover:text-ink" onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>
      {interview && interview.turns.length > 0 && (
        <ol className="mt-2 flex flex-col gap-2.5">
          {interview.turns.map((t) => (
            <li key={t.idx}>
              <div className="font-medium">
                Q{t.idx}. {t.question}
              </div>
              <p className="mt-0.5 rounded-[4px] bg-sunken px-2 py-1 whitespace-pre-wrap">{t.answer}</p>
              <div className="mt-0.5 flex items-start gap-1.5 text-muted">
                <Badge tone={SCORE_TONE[t.score]}>{t.score}</Badge>
                <span>{t.feedback}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {!ended && interview?.currentQuestion && (
        <div className="mt-3">
          <div className="font-medium">
            Q{interview.turns.length + 1}. {interview.currentQuestion}
          </div>
          {pending ? (
            <div className="mt-1.5 rounded-[4px] border border-dashed border-line px-2 py-1.5" aria-live="polite">
              <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
                <Spinner className="size-3" /> The interviewer is reading your answer…
              </div>
              {typeof partial?.feedback === 'string' && partial.feedback && <p className="mt-1 text-muted">{partial.feedback}</p>}
              {job && <JobEta job={job} className="mt-1" />}
            </div>
          ) : (
            <form
              className="mt-1.5 flex flex-col gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) void send();
              }}
            >
              {failed && <p className="text-err">The interviewer could not respond: {job?.error?.message ?? 'unknown error'}. Your answer is still below; send it again.</p>}
              <textarea
                className="min-h-[90px] resize-y rounded-[4px] border border-line bg-canvas px-2 py-1.5 text-[13px]"
                placeholder="Answer as you would out loud in an interview. Ctrl/Cmd+Enter to send."
                value={draft}
                maxLength={4000}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) {
                    e.preventDefault();
                    void send();
                  }
                }}
                aria-label="Your answer"
              />
              <div className="flex gap-1.5">
                <Button size="sm" variant="primary" type="submit" icon={<Send className="size-3.5" />} busy={busy} disabled={!draft.trim()}>
                  Send answer
                </Button>
                <Button size="sm" variant="ghost" type="button" icon={<Square className="size-3.5" />} onClick={() => void run(() => endInterview(interview.id))}>
                  End round
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
      {ended && interview && (
        <div className={clsx('mt-3 rounded-[4px] border border-line bg-sunken px-2.5 py-2')} data-testid="interview-summary">
          <div className="font-medium">Round summary</div>
          <p className="mt-0.5 text-muted">{interview.summary ?? 'Round ended.'}</p>
          <div className="mt-1 flex gap-1.5 text-[12px]">
            {(['strong', 'ok', 'weak'] as const).map((s) => (
              <Badge key={s} tone={SCORE_TONE[s]}>
                {interview.turns.filter((t) => t.score === s).length} {s}
              </Badge>
            ))}
          </div>
          <Button className="mt-2" size="sm" icon={<RotateCcw className="size-3.5" />} busy={busy} onClick={() => void begin(true)}>
            Practise again
          </Button>
        </div>
      )}
    </section>
  );
}

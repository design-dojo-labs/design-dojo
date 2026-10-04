import { randomUUID } from 'node:crypto';
import {
  AiChatAnswer,
  AiFixSuggestion,
  AiInterviewTurn,
  HLD_IMPROVEMENT_KEY,
  STORAGE_LABELS,
  graphToText,
  parsePartialJson,
  type FixSuggestion,
  type HldSubmission,
  type InterviewSession,
  type InterviewTurn,
  type Job,
  type ReviewInteractive,
  type ReviewThread,
  type ReviewTrack,
  type StoredFinding,
  type StoredHldReview,
  type ThreadMessage,
} from '@lld/shared';
import type { AppContext } from './app.js';
import { type DB, json, now } from './db.js';
import type { EventBus } from './events.js';
import { HttpError, normalizeRelPath } from './fs/paths.js';
import { isManaged } from './fs/workspace.js';
import type { HldService } from './hld/service.js';
import { JobFailure, type JobContext, type JobManager } from './jobs.js';
import { filesToText, problemToText, Prompts } from './prompts.js';
import type { Providers } from './providers/index.js';
import type { SessionStore } from './sessions.js';
import type { SubmissionService } from './submissions.js';

export const INTERACTIVE_PROMPTS = { chat: 'chat.v1', fix: 'fix.v1', interview: 'interview.v1' } as const;

const MAX_THREAD_MESSAGES = 40;
const MAX_INTERVIEW_TURNS = 16;
/** Above this, chat context carries only the files the finding cites (plus design notes). */
const FULL_CONTEXT_BYTES = 80 * 1024;
const DESIGN_NOTES = 'DESIGN_NOTES.md';

/** What a chat/interview prompt needs about one reviewed submission, independent of the track. */
interface ReviewContext {
  track: ReviewTrack;
  submissionId: string;
  sessionId: string;
  seq: number;
  interviewMode: boolean;
  reviewId: string;
  score: number;
  summary: string;
  problemTitle: string;
  problemText: string;
  followUpQuestions: string[];
  detailPending: boolean;
  /** Renders the submission for a prompt, optionally focused on the files a finding cites. */
  submissionText: (focusPaths?: string[]) => string;
  itemText: (itemKey: string) => string | null;
}

interface ThreadRow {
  id: string;
  track: ReviewTrack;
  review_id: string;
  submission_id: string;
  session_id: string;
  item_key: string;
  created_at: string;
}
interface MessageRow {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  text: string;
  code_snippet: string | null;
  job_id: string | null;
  provider: string | null;
  model: string | null;
  is_mock: number;
  created_at: string;
}
interface InterviewRow {
  id: string;
  track: ReviewTrack;
  review_id: string;
  submission_id: string;
  session_id: string;
  state: 'active' | 'ended';
  questions_json: string;
  remaining_json: string;
  current_question: string | null;
  last_kind: string | null;
  max_turns: number;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Follow-up work on a finished review: a chat thread per finding/improvement, fix suggestions for
 * LLD findings, "I fixed this" marks, and a mock interviewer that walks through the review's
 * follow-up questions. All AI calls are ordinary background jobs with validated structured output.
 */
export class InteractiveService {
  constructor(
    private db: DB,
    private bus: EventBus,
    private jobs: JobManager,
    private providers: Providers,
    private prompts: Prompts,
    private sessions: SessionStore,
    private submissions: SubmissionService,
    private hld: HldService,
  ) {}

  // ───────────────────────── context ─────────────────────────

  private context(track: ReviewTrack, submissionId: string): ReviewContext {
    return track === 'lld' ? this.lldContext(submissionId) : this.hldContext(submissionId);
  }

  private lldContext(submissionId: string): ReviewContext {
    const sub = this.submissions.get(submissionId);
    const review = sub.review;
    if (!review) throw new HttpError(409, 'This submission has no completed review yet.');
    const session = this.sessions.get(sub.sessionId);
    const files = sub.manifest.filter((m) => !isManaged(m.path)).map((m) => m.path);
    const read = (p: string) => this.submissions.readFile(submissionId, p).content;
    return {
      track: 'lld',
      submissionId,
      sessionId: sub.sessionId,
      seq: sub.seq,
      interviewMode: session.mode === 'interview',
      reviewId: review.id,
      score: review.totalScore,
      summary: review.summary,
      problemTitle: session.problem.content.title,
      problemText: problemToText(session.problem.content),
      followUpQuestions: review.followUpQuestions,
      detailPending: review.reviewMode === 'fast' && review.detail?.status !== 'completed',
      submissionText: (focus) => {
        const sources = files.filter((p) => p !== DESIGN_NOTES).map((p) => ({ path: p, content: read(p) }));
        const total = sources.reduce((s, f) => s + f.content.length, 0);
        const shown = focus?.length && total > FULL_CONTEXT_BYTES ? sources.filter((f) => focus.includes(f.path)) : sources;
        const notes = files.includes(DESIGN_NOTES) ? read(DESIGN_NOTES).trim() : '';
        const omitted = sources.length - shown.length;
        return [
          `<candidate_design_notes>\n${notes || '(none)'}\n</candidate_design_notes>`,
          omitted ? `(${omitted} other file(s) omitted to keep this request small.)` : '',
          filesToText(shown, 'candidate_file'),
        ]
          .filter(Boolean)
          .join('\n\n');
      },
      itemText: (key) => {
        const f = review.findings.find((x) => x.id === key);
        return f ? findingText(f) : null;
      },
    };
  }

  private hldContext(submissionId: string): ReviewContext {
    const sub = this.hld.getSubmission(submissionId);
    const review = sub.review;
    if (!review) throw new HttpError(409, 'This design has no completed review yet.');
    const session = this.hld.getSession(sub.sessionId);
    const c = session.problem.content;
    return {
      track: 'hld',
      submissionId,
      sessionId: sub.sessionId,
      seq: sub.seq,
      interviewMode: session.mode === 'interview',
      reviewId: review.id,
      score: review.totalScore,
      summary: review.summary,
      problemTitle: c.title,
      problemText: [c.statement, '', 'Scale:', ...c.scaleHints.map((s) => `- ${s}`), 'Constraints:', ...c.constraints.map((s) => `- ${s}`), 'Out of scope:', ...c.outOfScope.map((s) => `- ${s}`)].join('\n'),
      followUpQuestions: review.followUpQuestions,
      detailPending: review.reviewMode === 'fast' && review.detail?.status !== 'completed',
      submissionText: () => hldDocText(this.hld.submissionDoc(submissionId), sub),
      itemText: (key) => {
        const m = key.match(HLD_IMPROVEMENT_KEY);
        const im = m ? review.improvements[Number(m[1])] : undefined;
        return im ? improvementText(im, review) : null;
      },
    };
  }

  private publishPartial(ctx: JobContext, rc: ReviewContext, phase: string) {
    return (text: string) => {
      const data = parsePartialJson(text);
      if (data && typeof data === 'object') this.bus.publish({ type: 'job-partial', jobId: ctx.jobId, sessionId: rc.sessionId, submissionId: rc.submissionId, phase, data });
    };
  }

  private activeJobId(dedupeKey: string): string | null {
    const r = this.db.prepare(`SELECT id FROM jobs WHERE dedupe_key = ? AND state IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).get(dedupeKey) as { id: string } | undefined;
    return r?.id ?? null;
  }

  // ───────────────────────── state bundle ─────────────────────────

  state(track: ReviewTrack, submissionId: string): ReviewInteractive {
    let rc: ReviewContext;
    try {
      rc = this.context(track, submissionId);
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        return { track, submissionId, reviewId: null, interviewMode: false, threads: [], marks: {}, fixes: [], pendingFixes: {}, interview: null };
      }
      throw e;
    }
    const threads = (this.db.prepare('SELECT * FROM review_threads WHERE review_id = ? ORDER BY created_at').all(rc.reviewId) as ThreadRow[]).map((t) => this.thread(t));
    const marks = Object.fromEntries(
      (this.db.prepare('SELECT item_key, resolved FROM review_marks WHERE review_id = ?').all(rc.reviewId) as { item_key: string; resolved: number }[]).map((m) => [m.item_key, !!m.resolved]),
    );
    const fixes = this.fixes(rc.reviewId);
    const pendingFixes: Record<string, string> = {};
    for (const r of this.db.prepare(`SELECT dedupe_key, id FROM jobs WHERE dedupe_key LIKE ? AND state IN ('queued','running')`).all(`fix:${rc.reviewId}:%`) as { dedupe_key: string; id: string }[]) {
      pendingFixes[r.dedupe_key.slice(`fix:${rc.reviewId}:`.length)] = r.id;
    }
    const iv = this.db.prepare('SELECT * FROM interview_sessions WHERE review_id = ? ORDER BY created_at DESC LIMIT 1').get(rc.reviewId) as InterviewRow | undefined;
    return { track, submissionId, reviewId: rc.reviewId, interviewMode: rc.interviewMode, threads, marks, fixes, pendingFixes, interview: iv ? this.interview(iv) : null };
  }

  private thread(t: ThreadRow): ReviewThread {
    const messages = (this.db.prepare('SELECT * FROM review_thread_messages WHERE thread_id = ? ORDER BY created_at, rowid').all(t.id) as MessageRow[]).map(
      (m): ThreadMessage => ({
        id: m.id,
        role: m.role,
        text: m.text,
        codeSnippet: m.code_snippet,
        jobId: m.job_id,
        provider: m.provider,
        model: m.model,
        isMock: !!m.is_mock,
        createdAt: m.created_at,
      }),
    );
    return { id: t.id, track: t.track, reviewId: t.review_id, submissionId: t.submission_id, itemKey: t.item_key, messages, pendingJobId: this.activeJobId(chatKey(t.review_id, t.item_key)) };
  }

  // ───────────────────────── A. follow-up chat ─────────────────────────

  /** Appends the candidate's question (or retries the last unanswered one) and starts an answer job. */
  ask(track: ReviewTrack, submissionId: string, input: { itemKey: string; message: string }): { thread: ReviewThread; job: Job } {
    const rc = this.context(track, submissionId);
    if (rc.interviewMode) throw new HttpError(403, 'Follow-up chat is disabled in interview mode.');
    const item = rc.itemText(input.itemKey);
    if (!item) throw new HttpError(404, `No ${track === 'lld' ? 'finding' : 'improvement'} "${input.itemKey}" in the latest review.`);
    const key = chatKey(rc.reviewId, input.itemKey);
    if (this.activeJobId(key)) throw new HttpError(409, 'An answer is still being written for this thread.');
    let t = this.db.prepare('SELECT * FROM review_threads WHERE review_id = ? AND item_key = ?').get(rc.reviewId, input.itemKey) as ThreadRow | undefined;
    if (!t) {
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO review_threads (id, track, review_id, submission_id, session_id, item_key, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, track, rc.reviewId, submissionId, rc.sessionId, input.itemKey, now());
      t = this.db.prepare('SELECT * FROM review_threads WHERE id = ?').get(id) as ThreadRow;
    }
    const before = this.thread(t).messages;
    const message = input.message.trim();
    let question: string;
    if (message) {
      if (before.length >= MAX_THREAD_MESSAGES) throw new HttpError(409, 'This thread is at its length limit.');
      if (before.length && before[before.length - 1].role === 'user') throw new HttpError(409, 'The previous question has no answer yet. Retry it first.');
      this.db
        .prepare('INSERT INTO review_thread_messages (id, thread_id, role, text, code_snippet, job_id, provider, model, is_mock, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), t.id, 'user', message, null, null, null, null, 0, now());
      question = message;
    } else {
      const last = before[before.length - 1];
      if (!last || last.role !== 'user') throw new HttpError(400, 'Type a question.');
      question = last.text;
    }
    const conversation = this.thread(t).messages.slice(0, -1);
    const provider = this.providers.selected();
    const threadId = t.id;
    const { job } = this.jobs.create({ kind: 'chat', provider, sessionId: rc.sessionId, submissionId, dedupeKey: key, params: { track, itemKey: input.itemKey } });
    void this.jobs
      .run(job.id, async (ctx) => {
        const focus = track === 'lld' ? this.citedPaths(submissionId, input.itemKey) : undefined;
        const prompt = this.prompts.render(INTERACTIVE_PROMPTS.chat, {
          trackLabel: track === 'lld' ? 'low-level design (Java machine coding)' : 'system design (HLD)',
          problemTitle: rc.problemTitle,
          problem: rc.problemText,
          item,
          score: String(rc.score),
          reviewSummary: rc.summary,
          submission: rc.submissionText(focus),
          conversation: conversation.length ? conversation.map((m) => `${m.role === 'user' ? 'Candidate' : 'Reviewer'}: ${m.text}${m.codeSnippet ? `\n\`\`\`\n${m.codeSnippet}\n\`\`\`` : ''}`).join('\n\n') : '(this is the first question)',
          question,
        });
        ctx.progress(`Asking ${provider} about this point…`);
        const { data, result } = await this.providers.runValidated(provider, 'chat', prompt, AiChatAnswer, ctx, {
          mockContext: { question },
          onPartial: this.publishPartial(ctx, rc, 'answer'),
        });
        this.db
          .prepare('INSERT INTO review_thread_messages (id, thread_id, role, text, code_snippet, job_id, provider, model, is_mock, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(), threadId, 'assistant', data.answer, data.codeSnippet?.trim() || null, ctx.jobId, result.provider, result.model, result.provider === 'mock' ? 1 : 0, now());
        return { threadId };
      })
      .catch(() => {});
    return { thread: this.thread(t), job };
  }

  private citedPaths(submissionId: string, findingId: string): string[] {
    const f = this.submissions.get(submissionId).review?.findings.find((x) => x.id === findingId);
    return f?.filePath ? [f.filePath] : [];
  }

  // ───────────────────────── B. fix suggestions (LLD) ─────────────────────────

  suggestFix(submissionId: string, findingId: string): Job {
    const sub = this.submissions.get(submissionId);
    const review = sub.review;
    if (!review) throw new HttpError(409, 'This submission has no completed review yet.');
    const session = this.sessions.get(sub.sessionId);
    if (session.mode === 'interview') throw new HttpError(403, 'Fix suggestions are disabled in interview mode.');
    const finding = review.findings.find((f) => f.id === findingId);
    if (!finding) throw new HttpError(404, `No finding "${findingId}" in the latest review.`);
    const provider = this.providers.selected();
    const { job, existing } = this.jobs.create({ kind: 'fix-suggestion', provider, sessionId: sub.sessionId, submissionId, dedupeKey: `fix:${review.id}:${findingId}`, params: { findingId } });
    if (existing) return job;
    const snapshot = new Map<string, string>();
    for (const m of sub.manifest) if (!isManaged(m.path)) snapshot.set(m.path, this.submissions.readFile(submissionId, m.path).content);
    const cited = finding.filePath && snapshot.has(finding.filePath) ? finding.filePath : null;
    void this.jobs
      .run(job.id, async (ctx) => {
        const sources = [...snapshot].filter(([p]) => p !== DESIGN_NOTES).map(([path, content]) => ({ path, content }));
        const prompt = this.prompts.render(INTERACTIVE_PROMPTS.fix, {
          javaRelease: '21',
          problemTitle: session.problem.content.title,
          problem: problemToText(session.problem.content),
          finding: findingText(finding),
          allowedFiles: cited ? `\`${cited}\` (the file the finding cites)` : 'the one existing file that the fix needs (the finding cites no file)',
          seq: String(sub.seq),
          designNotes: snapshot.get(DESIGN_NOTES)?.trim() || '(none)',
          files: filesToText(sources),
        });
        ctx.progress(`Asking ${provider} for a fix…`);
        const { data, result } = await this.providers.runValidated(provider, 'fix-suggestion', prompt, AiFixSuggestion, ctx, {
          mockContext: (() => {
            const path = cited ?? sources.find((s) => s.path.endsWith('.java'))?.path ?? null;
            return { path, original: path ? snapshot.get(path) : null };
          })(),
          check: (d) => fixIssues(d, snapshot, cited),
          onPartial: (text) => {
            // Only the explanation is useful while streaming; file contents arrive whole at the end.
            const p = parsePartialJson(text) as { explanation?: unknown } | undefined;
            if (p && typeof p.explanation === 'string') {
              this.bus.publish({ type: 'job-partial', jobId: ctx.jobId, sessionId: sub.sessionId, submissionId, phase: 'answer', data: { explanation: p.explanation } });
            }
          },
        });
        const edits = data.edits.map((e) => {
          const path = normalizeRelPath(e.path);
          return { path, newContent: e.newContent, originalContent: snapshot.get(path) ?? null };
        });
        const id = randomUUID();
        this.db
          .prepare(
            'INSERT INTO fix_suggestions (id, review_id, submission_id, session_id, finding_id, job_id, suggestion_json, provider, model, is_mock, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(id, review.id, submissionId, sub.sessionId, findingId, ctx.jobId, JSON.stringify({ explanation: data.explanation, edits }), result.provider, result.model, result.provider === 'mock' ? 1 : 0, now());
        return { fixId: id };
      })
      .catch(() => {});
    return job;
  }

  /** Latest fix suggestion per finding for one review. */
  private fixes(reviewId: string): FixSuggestion[] {
    const rows = this.db.prepare('SELECT * FROM fix_suggestions WHERE review_id = ? ORDER BY created_at DESC').all(reviewId) as {
      id: string;
      review_id: string;
      submission_id: string;
      finding_id: string;
      job_id: string;
      suggestion_json: string;
      provider: string;
      model: string | null;
      is_mock: number;
      created_at: string;
    }[];
    const seen = new Set<string>();
    const out: FixSuggestion[] = [];
    for (const r of rows) {
      if (seen.has(r.finding_id)) continue;
      seen.add(r.finding_id);
      const s = json<{ explanation: string; edits: FixSuggestion['edits'] }>(r.suggestion_json, { explanation: '', edits: [] });
      out.push({
        id: r.id,
        reviewId: r.review_id,
        submissionId: r.submission_id,
        findingId: r.finding_id,
        jobId: r.job_id,
        explanation: s.explanation,
        edits: s.edits,
        provider: r.provider,
        model: r.model,
        isMock: !!r.is_mock,
        createdAt: r.created_at,
      });
    }
    return out;
  }

  // ───────────────────────── C. resolved marks ─────────────────────────

  mark(track: ReviewTrack, submissionId: string, input: { itemKey: string; resolved: boolean }): Record<string, boolean> {
    const rc = this.context(track, submissionId);
    if (!rc.itemText(input.itemKey)) throw new HttpError(404, `No ${track === 'lld' ? 'finding' : 'improvement'} "${input.itemKey}" in the latest review.`);
    this.db
      .prepare(
        `INSERT INTO review_marks (review_id, item_key, track, submission_id, resolved, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(review_id, item_key) DO UPDATE SET resolved = excluded.resolved, updated_at = excluded.updated_at`,
      )
      .run(rc.reviewId, input.itemKey, track, submissionId, input.resolved ? 1 : 0, now());
    return this.state(track, submissionId).marks;
  }

  // ───────────────────────── D. mock interviewer ─────────────────────────

  /** Starts (or returns the active) interview round over the latest review's follow-up questions. */
  startInterview(track: ReviewTrack, submissionId: string, restart = false): InterviewSession {
    const rc = this.context(track, submissionId);
    if (rc.detailPending) throw new HttpError(409, 'The follow-up questions are still being written. Try again when the review detail is complete.');
    const questions = rc.followUpQuestions.map((q) => q.trim()).filter(Boolean);
    if (!questions.length) throw new HttpError(409, 'This review has no follow-up questions to practise.');
    const active = this.db.prepare(`SELECT * FROM interview_sessions WHERE review_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1`).get(rc.reviewId) as InterviewRow | undefined;
    if (active && !restart) return this.interview(active);
    if (active) this.db.prepare(`UPDATE interview_sessions SET state = 'ended', updated_at = ? WHERE id = ?`).run(now(), active.id);
    const id = randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO interview_sessions (id, track, review_id, submission_id, session_id, state, questions_json, remaining_json, current_question, last_kind, max_turns, summary, created_at, updated_at)
         VALUES (?,?,?,?,?, 'active', ?,?,?, 'listed', ?, NULL, ?, ?)`,
      )
      .run(id, track, rc.reviewId, submissionId, rc.sessionId, JSON.stringify(questions), JSON.stringify(questions.slice(1)), questions[0], Math.min(MAX_INTERVIEW_TURNS, questions.length * 2), t, t);
    return this.interviewById(id);
  }

  answerInterview(interviewId: string, answer: string): { interview: InterviewSession; job: Job } {
    const row = this.interviewRow(interviewId);
    if (row.state !== 'active' || !row.current_question) throw new HttpError(409, 'This interview round has ended.');
    const key = `interview:${interviewId}`;
    if (this.activeJobId(key)) throw new HttpError(409, 'The interviewer is still responding.');
    const rc = this.context(row.track, row.submission_id);
    const turns = this.turns(interviewId);
    const remaining = json<string[]>(row.remaining_json, []);
    const turn = turns.length + 1;
    const finalTurn = turn >= row.max_turns;
    const question = row.current_question;
    const provider = this.providers.selected();
    const { job } = this.jobs.create({ kind: 'interview', provider, sessionId: rc.sessionId, submissionId: row.submission_id, dedupeKey: key, params: { interviewId } });
    void this.jobs
      .run(job.id, async (ctx) => {
        const prompt = this.prompts.render(INTERACTIVE_PROMPTS.interview, {
          trackLabel: row.track === 'lld' ? 'low-level design' : 'system design',
          problemTitle: rc.problemTitle,
          problem: rc.problemText,
          score: String(rc.score),
          reviewSummary: rc.summary,
          transcript: turns.length ? turns.map((x) => `Q${x.idx}: ${x.question}\nA${x.idx}: ${x.answer}\nFeedback (${x.score}): ${x.feedback}`).join('\n\n') : '(none yet)',
          question,
          answer,
          remaining: remaining.length ? remaining.map((q, i) => `${i + 1}. ${q}`).join('\n') : '(none — this is the last listed question)',
          turn: String(turn),
          maxTurns: String(row.max_turns),
          followUpRule: row.last_kind === 'follow-up' ? 'The current question already was a follow-up, so do NOT ask another one now.' : 'At most one follow-up per listed question.',
          finalTurnRule: finalTurn ? ', or now, because this is the final turn' : '',
        });
        ctx.progress(`The interviewer (${provider}) is reading your answer…`);
        const { data } = await this.providers.runValidated(provider, 'interview', prompt, AiInterviewTurn, ctx, {
          mockContext: { remaining },
          check: (d) => interviewIssues(d, remaining.length, row.last_kind === 'follow-up', finalTurn),
          onPartial: this.publishPartial(ctx, rc, 'answer'),
        });
        const fresh = this.interviewRow(interviewId);
        if (fresh.state !== 'active') return { interviewId }; // ended while the answer was being judged
        const done = finalTurn || data.done || data.nextKind === 'none' || !data.nextQuestion;
        const nextRemaining = data.nextKind === 'listed' && !done ? remaining.slice(1) : remaining;
        this.db.transaction(() => {
          this.db
            .prepare('INSERT INTO interview_turns (id, interview_id, idx, question, answer, feedback, score, job_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(randomUUID(), interviewId, turn, question, answer, data.feedback, data.score, ctx.jobId, now());
          this.db
            .prepare('UPDATE interview_sessions SET state = ?, remaining_json = ?, current_question = ?, last_kind = ?, summary = ?, updated_at = ? WHERE id = ?')
            .run(
              done ? 'ended' : 'active',
              JSON.stringify(nextRemaining),
              done ? null : data.nextQuestion,
              done ? null : data.nextKind,
              done ? (data.summary?.trim() || scoreSummary([...this.turns(interviewId)])) : null,
              now(),
              interviewId,
            );
        })();
        return { interviewId, done };
      })
      .catch(() => {});
    return { interview: this.interviewById(interviewId), job };
  }

  endInterview(interviewId: string): InterviewSession {
    const row = this.interviewRow(interviewId);
    if (row.state === 'active') {
      const active = this.activeJobId(`interview:${interviewId}`);
      if (active) this.jobs.cancel(active);
      this.db.prepare(`UPDATE interview_sessions SET state = 'ended', current_question = NULL, summary = ?, updated_at = ? WHERE id = ?`).run(scoreSummary(this.turns(interviewId)), now(), interviewId);
    }
    return this.interviewById(interviewId);
  }

  private interviewRow(id: string): InterviewRow {
    const r = this.db.prepare('SELECT * FROM interview_sessions WHERE id = ?').get(id) as InterviewRow | undefined;
    if (!r) throw new HttpError(404, 'interview not found');
    return r;
  }

  private interviewById(id: string): InterviewSession {
    return this.interview(this.interviewRow(id));
  }

  private turns(interviewId: string): InterviewTurn[] {
    return (
      this.db.prepare('SELECT idx, question, answer, feedback, score, created_at FROM interview_turns WHERE interview_id = ? ORDER BY idx').all(interviewId) as {
        idx: number;
        question: string;
        answer: string;
        feedback: string;
        score: InterviewTurn['score'];
        created_at: string;
      }[]
    ).map((t) => ({ idx: t.idx, question: t.question, answer: t.answer, feedback: t.feedback, score: t.score, createdAt: t.created_at }));
  }

  private interview(r: InterviewRow): InterviewSession {
    return {
      id: r.id,
      track: r.track,
      reviewId: r.review_id,
      submissionId: r.submission_id,
      state: r.state,
      currentQuestion: r.current_question,
      remaining: json<string[]>(r.remaining_json, []),
      turns: this.turns(r.id),
      summary: r.summary,
      maxTurns: r.max_turns,
      pendingJobId: this.activeJobId(`interview:${r.id}`),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

const chatKey = (reviewId: string, itemKey: string) => `chat:${reviewId}:${itemKey}`;

function findingText(f: StoredFinding): string {
  const loc = f.filePath ? `${f.filePath}${f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ''}` : ''}` : 'no specific location';
  return [
    `[${f.severity} · ${f.category} · ${f.kind}] ${f.title}`,
    `Location: ${loc}`,
    f.requirementId ? `Requirement: ${f.requirementId}` : '',
    `Explanation: ${f.explanation}`,
    f.evidence ? `Evidence:\n${f.evidence}` : '',
    `Suggestion: ${f.suggestion}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function improvementText(im: StoredHldReview['improvements'][number], review: StoredHldReview): string {
  return [
    `[${im.priority} priority · ${review.categories.find((c) => c.key === im.area)?.label ?? im.area}] ${im.title}`,
    `Explanation: ${im.explanation}`,
    `Suggestion: ${im.suggestion}`,
    im.components.length ? `Components: ${im.components.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function hldDocText(doc: ReturnType<HldService['submissionDoc']>, sub: HldSubmission): string {
  const empty = '(left empty)';
  return [
    `<candidate_functional_requirements>\n${doc.functional.filter((f) => f.text.trim()).map((f, i) => `${i + 1}. ${f.text.trim()}`).join('\n') || empty}\n</candidate_functional_requirements>`,
    `<candidate_non_functional_requirements>\n${doc.nonFunctional.filter((f) => f.text.trim()).map((f, i) => `${i + 1}. [${f.category}] ${f.text.trim()}`).join('\n') || empty}\n</candidate_non_functional_requirements>`,
    `<candidate_estimates>\n${doc.estimates.trim() || empty}\n</candidate_estimates>`,
    `<candidate_api>\n${doc.apis.filter((a) => a.path.trim() || a.description.trim()).map((a) => `${a.method} ${a.path}\n  Purpose: ${a.description || '-'}\n  Request: ${a.request || '-'}\n  Response: ${a.response || '-'}`).join('\n\n') || empty}\n</candidate_api>`,
    `<candidate_data_model>\n${doc.entities.filter((e) => e.name.trim()).map((e) => `${e.name} [${STORAGE_LABELS[e.storage]}]\n${e.fields}${e.notes ? `\n  Notes: ${e.notes}` : ''}`).join('\n\n') || empty}\n</candidate_data_model>`,
    `<candidate_diagram>\n${graphToText(sub.graph)}\n</candidate_diagram>`,
    `<candidate_deep_dives_and_tradeoffs>\n${doc.notes.trim() || empty}\n</candidate_deep_dives_and_tradeoffs>`,
  ].join('\n\n');
}

/** A fix may change the cited file, at most one other existing file, and add new test files. */
export function fixIssues(d: AiFixSuggestion, snapshot: Map<string, string>, cited: string | null): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  let others = 0;
  for (const [i, e] of d.edits.entries()) {
    let p: string;
    try {
      p = normalizeRelPath(e.path);
    } catch {
      issues.push(`edits.${i}.path: "${e.path.slice(0, 120)}" is not a valid relative path`);
      continue;
    }
    if (seen.has(p)) issues.push(`edits.${i}.path: ${p} appears more than once`);
    seen.add(p);
    if (isManaged(p) || p === 'pom.xml' || p === DESIGN_NOTES) {
      issues.push(`edits.${i}.path: ${p} must not be edited by a fix`);
      continue;
    }
    if (snapshot.has(p)) {
      if (snapshot.get(p) === e.newContent) issues.push(`edits.${i}: ${p} is unchanged; leave it out`);
      if (p !== cited) others++;
    } else if (!/^src\/test\/java\/.+\.java$/.test(p)) {
      issues.push(`edits.${i}.path: new files are only allowed as tests under src/test/java/ (got ${p})`);
    }
    if (/^```/.test(e.newContent.trim())) issues.push(`edits.${i}.newContent: must be plain file content, not a Markdown code block`);
  }
  if (others > 1) issues.push(`edits: at most one existing file besides ${cited ?? 'the main one'} may change (got ${others})`);
  if (!cited && others === 0 && ![...seen].some((p) => /^src\/test\//.test(p))) issues.push('edits: change the file that needs the fix');
  return issues;
}

/** Keeps the interviewer's choices consistent with the state the server tracks. */
export function interviewIssues(d: AiInterviewTurn, remaining: number, lastWasFollowUp: boolean, finalTurn: boolean): string[] {
  const issues: string[] = [];
  if (d.done !== (d.nextKind === 'none')) issues.push('done must be true exactly when nextKind is "none"');
  if (d.nextKind === 'none' && d.nextQuestion) issues.push('nextQuestion must be null when nextKind is "none"');
  if (d.nextKind !== 'none' && !d.nextQuestion?.trim()) issues.push('nextQuestion is required unless nextKind is "none"');
  if (d.nextKind === 'listed' && remaining === 0) issues.push('no listed questions remain: use "follow-up" or "none"');
  if (d.nextKind === 'follow-up' && lastWasFollowUp) issues.push('the current question was already a follow-up: ask the next listed question or end');
  if (d.nextKind === 'none' && remaining > 0 && !finalTurn) issues.push(`${remaining} listed question(s) remain: ask the next one with nextKind "listed"`);
  if (d.done && !d.summary?.trim()) issues.push('summary is required when done is true');
  if (!d.done && d.summary) issues.push('summary must be null until done is true');
  return issues;
}

function scoreSummary(turns: InterviewTurn[]): string {
  if (!turns.length) return 'Ended before any answer was given.';
  const n = (s: InterviewTurn['score']) => turns.filter((t) => t.score === s).length;
  return `${turns.length} answer${turns.length === 1 ? '' : 's'}: ${n('strong')} strong, ${n('ok')} ok, ${n('weak')} weak.`;
}

/** Finding ids the candidate marked "I fixed this" on a review (reported to the next review as claims to verify). */
export function markedFixed(db: DB, reviewId: string): Set<string> {
  return new Set((db.prepare('SELECT item_key FROM review_marks WHERE review_id = ? AND resolved = 1').all(reviewId) as { item_key: string }[]).map((r) => r.item_key));
}

const services = new WeakMap<AppContext, InteractiveService>();

/** One InteractiveService per app instance (created lazily so app wiring stays unchanged). */
export function interactiveFor(ctx: AppContext): InteractiveService {
  let s = services.get(ctx);
  if (!s) {
    s = new InteractiveService(ctx.db, ctx.bus, ctx.jobs, ctx.providers, new Prompts(ctx.config.resources.prompts), ctx.sessions, ctx.submissions, ctx.hld);
    services.set(ctx, s);
  }
  return s;
}

import { z } from 'zod';

// ───────────── Interactive review: follow-up chat, fix suggestions, resolved marks, mock interviewer ─────────────

const text = (max: number) => z.string().trim().min(1).max(max);

/** 'lld' items are finding ids; 'hld' items are `improvement:<index>` into the stored improvements. */
export type ReviewTrack = 'lld' | 'hld';
export const HLD_IMPROVEMENT_KEY = /^improvement:(\d{1,3})$/;
export const improvementKey = (index: number) => `improvement:${index}`;

/** AI answer to a follow-up question about one review finding/improvement. */
export const AiChatAnswer = z.object({
  answer: text(4000),
  codeSnippet: z.string().max(2000).nullable(),
});
export type AiChatAnswer = z.infer<typeof AiChatAnswer>;

/** AI fix proposal for one LLD finding: complete new contents of a few files. */
export const AiFixSuggestion = z.object({
  explanation: text(2000),
  edits: z
    .array(z.object({ path: z.string().trim().min(1).max(300), newContent: z.string().min(1).max(60_000) }))
    .min(1)
    .max(4),
});
export type AiFixSuggestion = z.infer<typeof AiFixSuggestion>;

/** One interviewer turn: feedback on the latest answer and what to ask next. */
export const AiInterviewTurn = z.object({
  feedback: text(1200),
  score: z.enum(['strong', 'ok', 'weak']),
  /** 'listed': the next question from the remaining list; 'follow-up': a probe on the same topic; 'none': the round ends. */
  nextKind: z.enum(['listed', 'follow-up', 'none']),
  nextQuestion: z.string().max(600).nullable(),
  done: z.boolean(),
  summary: z.string().max(1200).nullable(),
});
export type AiInterviewTurn = z.infer<typeof AiInterviewTurn>;

export const AskRequest = z.object({
  itemKey: z.string().min(1).max(80),
  /** Empty: retry the last unanswered question in this thread. */
  message: z.string().max(2000),
});
export type AskRequest = z.infer<typeof AskRequest>;

export const MarkRequest = z.object({ itemKey: z.string().min(1).max(80), resolved: z.boolean() });
export type MarkRequest = z.infer<typeof MarkRequest>;

export const InterviewAnswerRequest = z.object({ answer: z.string().trim().min(1).max(4000) });

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  codeSnippet: string | null;
  jobId: string | null;
  provider: string | null;
  model: string | null;
  isMock: boolean;
  createdAt: string;
}

export interface ReviewThread {
  id: string;
  track: ReviewTrack;
  reviewId: string;
  submissionId: string;
  itemKey: string;
  messages: ThreadMessage[];
  /** Running chat job for this thread, if any. */
  pendingJobId: string | null;
}

export interface FixSuggestion {
  id: string;
  reviewId: string;
  submissionId: string;
  findingId: string;
  jobId: string;
  explanation: string;
  /** originalContent is the snapshot version (null for a new file). */
  edits: { path: string; newContent: string; originalContent: string | null }[];
  provider: string;
  model: string | null;
  isMock: boolean;
  createdAt: string;
}

export interface InterviewTurn {
  idx: number;
  question: string;
  answer: string;
  feedback: string;
  score: AiInterviewTurn['score'];
  createdAt: string;
}

export interface InterviewSession {
  id: string;
  track: ReviewTrack;
  reviewId: string;
  submissionId: string;
  state: 'active' | 'ended';
  currentQuestion: string | null;
  /** Listed questions not asked yet. */
  remaining: string[];
  turns: InterviewTurn[];
  summary: string | null;
  maxTurns: number;
  pendingJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Everything interactive attached to the latest review of one submission. */
export interface ReviewInteractive {
  track: ReviewTrack;
  submissionId: string;
  reviewId: string | null;
  /** Chat and fix suggestions are disabled in interview-mode sessions. */
  interviewMode: boolean;
  threads: ReviewThread[];
  marks: Record<string, boolean>;
  fixes: FixSuggestion[];
  /** Running fix-suggestion jobs keyed by finding id. */
  pendingFixes: Record<string, string>;
  interview: InterviewSession | null;
}

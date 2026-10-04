import { useCallback, useEffect, useState } from 'react';
import type { Job, JobKind, ServerEvent } from '@lld/shared';
import { subscribe } from './events';

/**
 * Announces finished AI jobs: an in-app toast, a short chime and (when the tab is in the background)
 * a browser notification. Only jobs that started while this tab was open are announced, and only one
 * tab of the browser announces each job.
 */

export const NOTIFY_KINDS: ReadonlySet<JobKind> = new Set<JobKind>([
  'review',
  'review-detail',
  'hld-review',
  'hld-review-detail',
  'generate',
  'hld-generate',
  'reference',
  'chat',
  'fix-suggestion',
  'interview',
]);

const KIND_LABEL: Partial<Record<JobKind, string>> = {
  review: 'Review',
  'review-detail': 'Review details',
  'hld-review': 'Design review',
  'hld-review-detail': 'Design review details',
  generate: 'New problem',
  'hld-generate': 'New design question',
  reference: 'Reference solution',
  chat: 'Answer',
  'fix-suggestion': 'Fix suggestion',
  interview: 'Interviewer reply',
};

export interface NotifyPlan {
  toast: boolean;
  desktop: boolean;
  sound: boolean;
}

export type PermissionState = NotificationPermission | 'unsupported';

/**
 * Pure decision for one job event. `seenActive` means this tab saw the job queued or running;
 * jobs created while the tab was open count too (e.g. started from another tab).
 * Someone looking at the job's own page in a focused tab gets only the toast.
 */
export function planJobNotification(input: {
  job: Pick<Job, 'kind' | 'state' | 'createdAt'>;
  tabOpenedAt: number;
  seenActive: boolean;
  visible: boolean;
  focused: boolean;
  onJobPage: boolean;
  settings: { desktop: boolean; sound: boolean };
  permission: PermissionState;
}): NotifyPlan | null {
  const { job } = input;
  if (!NOTIFY_KINDS.has(job.kind)) return null;
  if (job.state !== 'completed' && job.state !== 'failed') return null;
  const created = Date.parse(job.createdAt);
  const startedWhileOpen = input.seenActive || (Number.isFinite(created) && created >= input.tabOpenedAt - 2000);
  if (!startedWhileOpen) return null;
  const attending = input.visible && input.focused && input.onJobPage;
  return {
    toast: true,
    desktop: !attending && input.settings.desktop && input.permission === 'granted' && (!input.visible || !input.focused),
    sound: !attending && input.settings.sound,
  };
}

/** Title/body for a finished job, using the score or title in the job result when there is one. */
export function jobMessage(job: Pick<Job, 'kind' | 'state' | 'result' | 'error'>): { title: string; body: string; ok: boolean } {
  const label = KIND_LABEL[job.kind] ?? 'AI job';
  if (job.state === 'failed') return { title: `${label} failed`, body: job.error?.message ?? 'See the job details for the reason.', ok: false };
  const r = (job.result ?? {}) as Record<string, unknown>;
  if (typeof r.score === 'number') return { title: `${label} ready`, body: `Score ${r.score}/100`, ok: true };
  if (typeof r.title === 'string' && r.title) return { title: `${label} ready`, body: r.title, ok: true };
  return { title: `${label} ready`, body: '', ok: true };
}

/** Where a finished job's result is shown, if that can be told from the job alone. */
export function jobHref(job: Pick<Job, 'kind' | 'sessionId' | 'submissionId' | 'result'>): string | null {
  const r = (job.result ?? {}) as Record<string, unknown>;
  switch (job.kind) {
    case 'review':
    case 'review-detail':
    case 'reference':
    case 'fix-suggestion':
      if (!job.sessionId) return null;
      return `/session/${job.sessionId}${job.submissionId ? `?submission=${encodeURIComponent(job.submissionId)}` : ''}`;
    case 'hld-review':
    case 'hld-review-detail':
      return job.sessionId ? `/hld/session/${job.sessionId}` : null;
    case 'generate':
      return typeof r.problemId === 'string' ? `/problems/${encodeURIComponent(r.problemId)}` : null;
    case 'hld-generate':
      return typeof r.problemId === 'string' ? `/hld/problems/${encodeURIComponent(r.problemId)}` : null;
    default:
      return null;
  }
}

/** Whether the current page is where the job was started (and shows its result). */
export function isOnJobPage(job: Pick<Job, 'kind' | 'sessionId'>, pathname: string): boolean {
  if (job.sessionId) return pathname.includes(job.sessionId);
  if (job.kind === 'generate') return pathname === '/lld' || pathname.startsWith('/problems/');
  if (job.kind === 'hld-generate') return pathname === '/hld' || pathname.startsWith('/hld/problems/');
  return false;
}

// ───────────── browser side effects ─────────────

export function notificationPermission(): PermissionState {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** Asks for notification permission if it was never asked. Call from a click handler (user gesture). */
export function ensureNotificationPermission(): Promise<PermissionState> {
  if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
  if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
  return Notification.requestPermission().catch(() => Notification.permission);
}

let audio: AudioContext | null = null;

/** Two short sine tones: rising when a job succeeded, falling when it failed. */
export function playChime(ok = true): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    const ctx = audio;
    void ctx.resume?.().catch(() => {});
    const t0 = ctx.currentTime + 0.02;
    const tones: [number, number][] = ok
      ? [
          [880, 0],
          [1318.5, 0.14],
        ]
      : [
          [523.25, 0],
          [392, 0.16],
        ];
    for (const [freq, offset] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.32);
    }
  } catch {
    /* audio is a nicety */
  }
}

const CLAIM_KEY = 'lld.notified';
const CLAIM_TTL_MS = 24 * 3600_000;

/** First tab to claim a job announces it; the others stay quiet. Falls back to "claimed" without storage. */
function claim(jobId: string): boolean {
  try {
    const now = Date.now();
    const map = JSON.parse(localStorage.getItem(CLAIM_KEY) ?? '{}') as Record<string, number>;
    if (map[jobId]) return false;
    for (const [k, at] of Object.entries(map)) if (now - at > CLAIM_TTL_MS) delete map[k];
    map[jobId] = now;
    localStorage.setItem(CLAIM_KEY, JSON.stringify(map));
    return true;
  } catch {
    return true;
  }
}

/** Where announcements go: supplied by the mounted UI (toast, router navigation, user preferences). */
export interface NotificationSink {
  toast: (tone: 'ok' | 'err' | 'info', text: string) => void;
  navigate: (to: string) => void;
  settings: { desktop: boolean; sound: boolean };
}

const notifier = {
  refs: 0,
  off: null as (() => void) | null,
  tabOpenedAt: Date.now(),
  active: new Set<string>(),
  sinks: [] as NotificationSink[],
};

function announce(job: Job, plan: NotifyPlan, sink: NotificationSink): void {
  const msg = jobMessage(job);
  const href = jobHref(job);
  if (plan.toast) sink.toast(msg.ok ? 'ok' : 'err', msg.body ? `${msg.title}: ${msg.body}` : msg.title);
  if (plan.sound) playChime(msg.ok);
  if (plan.desktop) {
    try {
      const n = new Notification(msg.title, { body: msg.body || undefined, tag: job.id, icon: '/favicon.svg' });
      n.onclick = () => {
        window.focus();
        n.close();
        if (href && !isOnJobPage(job, window.location.pathname)) sink.navigate(href);
      };
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }
}

function handle(ev: ServerEvent): void {
  if (ev.type !== 'job') return;
  const job = ev.job;
  if (job.state === 'queued' || job.state === 'running') {
    notifier.active.add(job.id);
    return;
  }
  const seenActive = notifier.active.delete(job.id);
  const sink = notifier.sinks[notifier.sinks.length - 1];
  if (!sink) return;
  const visible = document.visibilityState === 'visible';
  const focused = document.hasFocus();
  const onJobPage = isOnJobPage(job, window.location.pathname);
  const plan = planJobNotification({
    job,
    tabOpenedAt: notifier.tabOpenedAt,
    seenActive,
    visible,
    focused,
    onJobPage,
    settings: sink.settings,
    permission: notificationPermission(),
  });
  if (!plan) return;
  // A tab where the user is looking at the job claims it at once; background tabs wait a moment
  // so the attended tab wins the claim and the user is not notified twice.
  const attending = visible && focused && onJobPage;
  const go = () => {
    if (claim(job.id)) announce(job, plan, notifier.sinks[notifier.sinks.length - 1] ?? sink);
  };
  if (attending) go();
  else setTimeout(go, 350);
}

/**
 * Starts announcing finished jobs through `sink` until the returned function is called. Registrations
 * are reference-counted (one event subscription however many are mounted); the most recent sink wins.
 */
export function registerNotificationSink(sink: NotificationSink): () => void {
  notifier.sinks.push(sink);
  if (notifier.refs++ === 0) notifier.off = subscribe(handle);
  return () => {
    notifier.sinks = notifier.sinks.filter((s) => s !== sink);
    if (--notifier.refs === 0) {
      notifier.off?.();
      notifier.off = null;
    }
  };
}

/** Current permission plus a request function that updates it (for an "Enable notifications" prompt). */
export function useNotificationPermission(): [PermissionState, () => Promise<void>] {
  const [perm, setPerm] = useState<PermissionState>(notificationPermission);
  const request = useCallback(async () => setPerm(await ensureNotificationPermission()), []);
  useEffect(() => {
    // Permission can change in the browser's site settings; re-read when the tab regains focus.
    const h = () => setPerm(notificationPermission());
    window.addEventListener('focus', h);
    return () => window.removeEventListener('focus', h);
  }, []);
  return [perm, request];
}

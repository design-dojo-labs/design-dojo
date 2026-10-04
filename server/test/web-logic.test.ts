import { describe, expect, it, vi } from 'vitest';
import type { Job, JobDurationStats } from '@lld/shared';

// The pure functions under test live next to React hooks. React itself is installed only in the web
// workspace, so the UI-side imports are stubbed; nothing here renders.
vi.mock('react', () => ({ useCallback: (f: unknown) => f, useEffect: () => {}, useRef: (v: unknown) => ({ current: v }), useState: (v: unknown) => [v, () => {}] }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({}) }));
vi.mock('../../web/src/lib/events', () => ({ subscribe: () => () => {} }));

import { estimateFor, etaView, formatRemaining } from '../../web/src/lib/jobEta';
import { decideRemoteChange } from '../../web/src/lib/tabsync';
import { isOnJobPage, jobHref, jobMessage, planJobNotification } from '../../web/src/lib/notify';

const stats: JobDurationStats[] = [
  { kind: 'review', provider: 'claude', samples: 5, medianMs: 100_000, p90Ms: 160_000 },
  { kind: 'review', provider: 'codex', samples: 2, medianMs: 60_000, p90Ms: 70_000 },
  { kind: 'hld-review', provider: 'codex', samples: 3, medianMs: 120_000, p90Ms: 100_000 },
];

describe('ETA estimates', () => {
  it('prefers the same kind and provider, then the kind with most samples, else nothing', () => {
    expect(estimateFor(stats, 'review', 'claude')).toMatchObject({ medianMs: 100_000, basis: 'provider' });
    expect(estimateFor(stats, 'review', 'gemini')).toMatchObject({ medianMs: 100_000, samples: 5, basis: 'kind' });
    expect(estimateFor(stats, 'generate', 'claude')).toBeNull();
    expect(estimateFor(undefined, 'review', 'claude')).toBeNull();
  });

  it('never lets p90 fall below the median', () => {
    expect(estimateFor(stats, 'hld-review', 'codex')?.p90Ms).toBe(120_000);
  });

  it('fills to 90% at the median, creeps until p90, then reports overdue', () => {
    const est = estimateFor(stats, 'review', 'claude');
    expect(etaView(0, est)).toMatchObject({ fraction: 0, overdue: false, label: '~2 min left' });
    expect(etaView(40_000, est).label).toBe('~60s left');
    expect(etaView(50_000, est).fraction).toBeCloseTo(0.45);
    expect(etaView(100_000, est)).toMatchObject({ label: 'almost done', overdue: false });
    expect(etaView(130_000, est).fraction).toBeCloseTo(0.935);
    expect(etaView(200_000, est)).toMatchObject({ fraction: 0.97, overdue: true, label: 'taking longer than usual' });
    expect(etaView(10_000, null)).toEqual({ fraction: null, label: '', overdue: false });
  });

  it('formats remaining time in seconds, then minutes', () => {
    expect(formatRemaining(45_000)).toBe('~45s left');
    expect(formatRemaining(150_000)).toBe('~3 min left');
    expect(formatRemaining(0)).toBe('~1s left');
  });
});

describe('remote change decision', () => {
  const base = { ownClientId: 'me', baseHash: 'h1', hasUnsavedEdits: false };
  it('ignores its own saves and versions it already has', () => {
    expect(decideRemoteChange({ ...base, eventClientId: 'me', eventHash: 'h2' })).toBe('ignore');
    expect(decideRemoteChange({ ...base, eventClientId: 'other', eventHash: 'h1' })).toBe('ignore');
  });
  it('reloads a clean copy and flags a conflict when there are unsaved edits', () => {
    expect(decideRemoteChange({ ...base, eventClientId: 'other', eventHash: 'h2' })).toBe('reload');
    expect(decideRemoteChange({ ...base, eventClientId: null, eventHash: null })).toBe('reload');
    expect(decideRemoteChange({ ...base, hasUnsavedEdits: true, eventClientId: 'other', eventHash: 'h2' })).toBe('conflict');
  });
});

describe('job notifications', () => {
  const now = Date.parse('2026-10-03T10:00:00Z');
  const job = (over: Partial<Job> = {}): Job => ({
    id: 'j1',
    kind: 'review',
    state: 'completed',
    provider: 'claude',
    sessionId: 's1',
    submissionId: 'sub1',
    createdAt: '2026-10-03T10:01:00Z',
    startedAt: '2026-10-03T10:01:01Z',
    finishedAt: '2026-10-03T10:03:00Z',
    progress: [],
    error: null,
    result: { reviewId: 'r1', score: 89 },
    ...over,
  });
  const ctx = { tabOpenedAt: now, seenActive: false, visible: false, focused: false, onJobPage: false, settings: { desktop: true, sound: true }, permission: 'granted' as const };

  it('announces a finished job started while the tab was open, with desktop + sound in the background', () => {
    expect(planJobNotification({ ...ctx, job: job() })).toEqual({ toast: true, desktop: true, sound: true });
  });
  it('stays quiet for old jobs, running jobs, cancellations and non-AI kinds', () => {
    expect(planJobNotification({ ...ctx, job: job({ createdAt: '2026-10-03T09:00:00Z' }) })).toBeNull();
    expect(planJobNotification({ ...ctx, job: job({ createdAt: '2026-10-03T09:00:00Z' }), seenActive: true })).not.toBeNull();
    expect(planJobNotification({ ...ctx, job: job({ state: 'running' }) })).toBeNull();
    expect(planJobNotification({ ...ctx, job: job({ state: 'cancelled' }) })).toBeNull();
    expect(planJobNotification({ ...ctx, job: job({ kind: 'toolchain-bootstrap' }) })).toBeNull();
  });
  it('only toasts for someone watching the job page, and respects settings and permission', () => {
    expect(planJobNotification({ ...ctx, job: job(), visible: true, focused: true, onJobPage: true })).toEqual({ toast: true, desktop: false, sound: false });
    expect(planJobNotification({ ...ctx, job: job(), visible: true, focused: true, onJobPage: false })).toEqual({ toast: true, desktop: false, sound: true });
    expect(planJobNotification({ ...ctx, job: job(), permission: 'default' })?.desktop).toBe(false);
    expect(planJobNotification({ ...ctx, job: job(), settings: { desktop: false, sound: false } })).toEqual({ toast: true, desktop: false, sound: false });
  });
  it('builds messages and links from the job', () => {
    expect(jobMessage(job())).toEqual({ title: 'Review ready', body: 'Score 89/100', ok: true });
    expect(jobMessage(job({ kind: 'hld-generate', result: { problemId: 'p', title: 'Chat app' } })).body).toBe('Chat app');
    expect(jobMessage(job({ state: 'failed', result: null, error: { code: 'timeout', message: 'Too slow' } }))).toEqual({ title: 'Review failed', body: 'Too slow', ok: false });
    expect(jobHref(job())).toBe('/session/s1?submission=sub1');
    expect(jobHref(job({ kind: 'hld-review' }))).toBe('/hld/session/s1');
    expect(jobHref(job({ kind: 'generate', sessionId: null, result: { problemId: 'gen-x' } }))).toBe('/problems/gen-x');
    expect(jobHref(job({ kind: 'chat' }))).toBeNull();
    expect(isOnJobPage(job(), '/session/s1')).toBe(true);
    expect(isOnJobPage(job({ kind: 'hld-generate', sessionId: null }), '/hld')).toBe(true);
    expect(isOnJobPage(job(), '/lld')).toBe(false);
  });
});

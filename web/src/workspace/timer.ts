import type { TimerState } from '@lld/shared';

export function elapsed(t: TimerState, at = Date.now()): number {
  return t.accumulatedMs + (t.runningSince ? Math.max(0, at - Date.parse(t.runningSince)) : 0);
}

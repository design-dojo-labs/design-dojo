export function formatDuration(ms: number): string {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return neg ? `-${body}` : body;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = Date.now() - Date.parse(iso);
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 14) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function scoreTone(score: number | null | undefined): 'ok' | 'warn' | 'err' | 'none' {
  if (score == null) return 'none';
  if (score >= 75) return 'ok';
  if (score >= 50) return 'warn';
  return 'err';
}

export const DIFFICULTY_LABEL: Record<string, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

export function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

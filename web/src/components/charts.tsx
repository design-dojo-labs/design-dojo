import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Stats } from '@lld/shared';
import { shortDate } from '../lib/format';

/**
 * Score history: one series (total score out of 100) over review order. 2px line, 8px markers,
 * recessive grid at 25/50/75, crosshair + tooltip on hover/focus, and a table view.
 */
export function ScoreHistoryChart({ history }: { history: Stats['history'] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(520);
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 170;
  const pad = { l: 30, r: 12, t: 10, b: 22 };
  const n = history.length;
  const x = (i: number) => pad.l + (n <= 1 ? (width - pad.l - pad.r) / 2 : (i / (n - 1)) * (width - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);
  const path = history.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(h.score).toFixed(1)}`).join(' ');
  const h = hover != null ? history[hover] : null;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium">Score history</h3>
        <button className="text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-[220px] overflow-auto rounded-[5px] border border-line">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-sunken text-left text-muted">
              <tr>
                <th className="px-2 py-1 font-medium">When</th>
                <th className="px-2 py-1 font-medium">Problem</th>
                <th className="px-2 py-1 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {[...history].reverse().map((r) => (
                <tr key={r.submissionId} className="border-t border-line">
                  <td className="px-2 py-1 text-muted">{shortDate(r.at)}</td>
                  <td className="px-2 py-1">
                    <Link className="hover:underline" to={`/session/${r.sessionId}?submission=${r.submissionId}`}>
                      {r.problemTitle}
                    </Link>
                  </td>
                  <td className="tabular px-2 py-1 text-right">{r.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrap} className="relative">
          <svg
            width={width}
            height={H}
            role="img"
            aria-label={`Score history, ${n} reviews, latest ${history[n - 1]?.score ?? '–'} out of 100`}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => {
              const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const px = e.clientX - rect.left;
              let best = 0;
              for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
              setHover(n ? best : null);
            }}
          >
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={v}>
                <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke="var(--c-line)" strokeWidth={1} />
                <text x={pad.l - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="var(--c-faint)" className="tabular">
                  {v}
                </text>
              </g>
            ))}
            {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--c-line-strong)" strokeWidth={1} />}
            <path d={path} fill="none" stroke="var(--c-series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {history.map((p, i) => (
              <circle
                key={p.submissionId}
                cx={x(i)}
                cy={y(p.score)}
                r={hover === i ? 5 : 4}
                fill="var(--c-series)"
                stroke="var(--c-panel)"
                strokeWidth={2}
                tabIndex={0}
                aria-label={`${p.problemTitle}: ${p.score}`}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            ))}
            {n > 0 && (
              <text x={x(n - 1)} y={y(history[n - 1].score) - 9} textAnchor={n > 1 ? 'end' : 'middle'} fontSize={11} fill="var(--c-ink)" className="tabular">
                {history[n - 1].score}
              </text>
            )}
            <text x={pad.l} y={H - 6} fontSize={10} fill="var(--c-faint)">
              {n ? shortDate(history[0].at) : ''}
            </text>
            <text x={width - pad.r} y={H - 6} fontSize={10} fill="var(--c-faint)" textAnchor="end">
              {n > 1 ? shortDate(history[n - 1].at) : ''}
            </text>
          </svg>
          {h && hover != null && (
            <div
              className="pointer-events-none absolute z-10 rounded-[5px] border border-line-strong bg-raised px-2 py-1 text-[12px] shadow-md"
              style={{ left: Math.min(Math.max(0, x(hover) - 80), width - 180), top: Math.max(0, y(h.score) - 58) }}
            >
              <div className="font-medium">{h.problemTitle}</div>
              <div className="text-muted">
                <span className="tabular text-ink">{h.score}</span>/100, {shortDate(h.at)}
              </div>
              <div className="text-faint">
                {h.provider}
                {h.model ? ` / ${h.model}` : ''}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Average share of each rubric category earned, across the latest review of every session. */
export function CategoryBars({ categories }: { categories: Stats['categories'] }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[13px] font-medium">Average by rubric category</h3>
      <ul className="flex flex-col gap-1.5">
        {categories.map((c) => (
          <li key={c.key} className="grid grid-cols-[minmax(0,10.5rem)_1fr_3rem] items-center gap-2 text-[12.5px]" title={`${c.label}: ${c.averagePct}% across ${c.samples} sessions`}>
            <span className="truncate text-muted">{c.label.split(' & ')[0].split(',')[0]}</span>
            <span className="h-2 overflow-hidden rounded-[2px] bg-sunken">
              <span className="block h-full rounded-r-[2px] bg-series" style={{ width: `${c.averagePct}%` }} />
            </span>
            <span className="tabular text-right">{Math.round(c.averagePct)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

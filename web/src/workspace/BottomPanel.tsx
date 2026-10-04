import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleSlash, XCircle, AlertTriangle } from 'lucide-react';
import type { ExecKind, ExecRun, RunConfig, Session, TestCaseResult } from '@lld/shared';
import { get, patch } from '../lib/api';
import { useQc, qk } from '../lib/queries';
import { inputClass, Spinner } from '../components/ui';
import { useExec } from './exec';
import { useWorkspace, type BottomView } from './context';

const KIND_LABEL: Record<ExecKind, string> = { compile: 'Compile', run: 'Run', test: 'Tests' };

export function runStateText(r: ExecRun): { text: string; tone: string } {
  switch (r.state) {
    case 'running':
      return { text: r.phase === 'run' ? 'running program…' : r.phase === 'test' || r.kind === 'test' ? 'building and testing…' : 'compiling…', tone: 'text-accent' };
    case 'succeeded':
      return { text: `succeeded${r.exitCode != null ? `, exit ${r.exitCode}` : ''}`, tone: 'text-ok' };
    case 'failed':
      return { text: r.phase === 'compile' ? 'compilation failed' : r.kind === 'test' ? 'tests failed' : `exit code ${r.exitCode}`, tone: 'text-err' };
    case 'timed-out':
      return { text: 'stopped: time limit', tone: 'text-err' };
    case 'output-limit':
      return { text: 'stopped: output limit', tone: 'text-err' };
    case 'cancelled':
      return { text: 'stopped', tone: 'text-muted' };
    case 'interrupted':
      return { text: 'interrupted by server restart', tone: 'text-err' };
  }
}

export function BottomPanel() {
  const ws = useWorkspace();
  const exec = useExec();
  const run = exec.shown ? exec.runs[exec.shown] : null;
  const diagRun = [exec.runs.test, exec.runs.compile, exec.runs.run].filter(Boolean).sort((a, b) => (b!.startedAt > a!.startedAt ? 1 : -1))[0] ?? null;
  const errors = diagRun?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;
  const t = exec.runs.test?.tests;
  const tabs: { id: BottomView; label: string }[] = [
    { id: 'output', label: 'Output' },
    { id: 'problems', label: `Problems${diagRun?.diagnostics.length ? ` (${diagRun.diagnostics.length})` : ''}` },
    { id: 'tests', label: t ? `Tests (${t.passed}/${t.total})` : 'Tests' },
    { id: 'config', label: 'Run settings' },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2" role="tablist" aria-label="Console">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            role="tab"
            aria-selected={ws.bottomView === tb.id}
            onClick={() => ws.setBottomView(tb.id)}
            className={clsx(
              'rounded-[4px] px-2 py-0.5 text-[12.5px]',
              ws.bottomView === tb.id ? 'bg-sunken text-ink' : 'text-muted hover:text-ink',
              tb.id === 'problems' && errors > 0 && 'text-err',
            )}
          >
            {tb.label}
          </button>
        ))}
        {ws.bottomView === 'output' && (
          <div className="ml-auto flex items-center gap-1 text-[12px]">
            {(['compile', 'run', 'test'] as const).map((k) =>
              exec.runs[k] ? (
                <button key={k} onClick={() => exec.setShown(k)} className={clsx('rounded-[4px] px-1.5 py-0.5', exec.shown === k ? 'bg-sunken text-ink' : 'text-muted hover:text-ink')}>
                  {KIND_LABEL[k]}
                </button>
              ) : null,
            )}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {ws.bottomView === 'output' && <Output run={run} />}
        {ws.bottomView === 'problems' && <Problems run={diagRun} />}
        {ws.bottomView === 'tests' && <Tests run={exec.runs.test} />}
        {ws.bottomView === 'config' && <RunSettings />}
      </div>
    </div>
  );
}

function Output({ run }: { run: ExecRun | null }) {
  const exec = useExec();
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const chunks = run ? exec.chunks(run.id) : [];
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [exec.tick, run?.id]);
  if (!run) return <div className="p-3 text-[12.5px] text-faint">Compile, run or test your project to see output here. Output is capped and long-running programs are stopped after the time limit.</div>;
  const st = runStateText(run);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[12px]">
        {run.state === 'running' && <Spinner className="size-3" />}
        <span className="font-medium">{KIND_LABEL[run.kind]}</span>
        <span className={st.tone}>{st.text}</span>
        {run.durationMs != null && <span className="tabular text-faint">{(run.durationMs / 1000).toFixed(2)} s</span>}
        {run.truncated && <span className="text-accent">output truncated</span>}
        <span className="ml-auto truncate font-mono text-[11px] text-faint">{run.command}</span>
      </div>
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[12.5px] leading-[1.45] whitespace-pre-wrap"
        aria-live="off"
        data-testid="console-output"
      >
        {chunks.map((c, i) => (
          <span key={i} className={c.stream === 'stderr' ? 'text-err' : c.stream === 'system' ? 'text-faint' : 'text-ink'}>
            {c.text}
          </span>
        ))}
      </pre>
    </div>
  );
}

function Problems({ run }: { run: ExecRun | null }) {
  const ws = useWorkspace();
  if (!run?.diagnostics.length) return <div className="p-3 text-[12.5px] text-faint">{run ? 'No compiler problems in the last build.' : 'No build yet.'}</div>;
  return (
    <ul className="h-full overflow-auto py-1 text-[12.5px]">
      {run.diagnostics.map((d, i) => (
        <li key={i}>
          <button
            className="flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-sunken disabled:cursor-default"
            disabled={!d.file}
            onClick={() => d.file && ws.openFile(d.file, d.line ?? undefined)}
          >
            {d.severity === 'error' ? <XCircle className="mt-0.5 size-3.5 shrink-0 text-err" aria-label="error" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-accent" aria-label="warning" />}
            <span className="min-w-0 flex-1">
              <span className="font-mono whitespace-pre-wrap">{d.message}</span>
              {d.file && (
                <span className="ml-2 text-faint">
                  {d.file}:{d.line}:{d.column}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Tests({ run }: { run: ExecRun | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!run) return <div className="p-3 text-[12.5px] text-faint">Run tests to see results by status. Results come from the Surefire reports of the last test run.</div>;
  if (run.state === 'running') return <div className="flex items-center gap-2 p-3 text-[12.5px] text-muted"><Spinner className="size-3" /> Running tests…</div>;
  const t = run.tests;
  if (!t) return <div className="p-3 text-[12.5px] text-muted">{run.phase === 'compile' ? 'Tests did not run because compilation failed. See Problems.' : `No test results were produced (${runStateText(run).text}).`}</div>;
  const groups: { status: TestCaseResult['status']; label: string; icon: React.ReactNode }[] = [
    { status: 'failed', label: 'Failed', icon: <XCircle className="size-3.5 text-err" /> },
    { status: 'errored', label: 'Errored', icon: <AlertTriangle className="size-3.5 text-err" /> },
    { status: 'skipped', label: 'Skipped', icon: <CircleSlash className="size-3.5 text-faint" /> },
    { status: 'passed', label: 'Passed', icon: <CheckCircle2 className="size-3.5 text-ok" /> },
  ];
  return (
    <div className="h-full overflow-auto text-[12.5px]">
      <div className="tabular flex gap-4 border-b border-line px-3 py-1.5">
        <span className="text-ok">{t.passed} passed</span>
        <span className={t.failed ? 'text-err' : 'text-muted'}>{t.failed} failed</span>
        <span className={t.errored ? 'text-err' : 'text-muted'}>{t.errored} errored</span>
        <span className="text-muted">{t.skipped} skipped</span>
        <span className="ml-auto text-faint">{run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString() : ''}</span>
      </div>
      {groups.map((g) => {
        const cases = t.cases.filter((c) => c.status === g.status);
        if (!cases.length) return null;
        return (
          <div key={g.status} className="py-1">
            <div className="px-3 py-0.5 text-[11.5px] font-medium text-muted">
              {g.label} ({cases.length})
            </div>
            {cases.map((c) => {
              const key = `${c.className}#${c.name}`;
              return (
                <div key={key}>
                  <button className="flex w-full items-center gap-2 px-3 py-0.5 text-left hover:bg-sunken" onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>
                    {g.icon}
                    <span className="truncate">
                      <span className="text-faint">{c.className.split('.').pop()}.</span>
                      {c.name}
                    </span>
                    <span className="tabular ml-auto text-faint">{c.timeMs} ms</span>
                  </button>
                  {open === key && (c.message || c.detail) && (
                    <pre className="mx-3 mb-1 max-h-60 overflow-auto rounded-[4px] border border-line bg-sunken p-2 font-mono text-[11.5px] whitespace-pre-wrap text-muted">
                      {c.message}
                      {c.detail ? `\n\n${c.detail}` : ''}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function RunSettings() {
  const { session } = useWorkspace();
  const qc = useQc();
  const mains = useQuery({ queryKey: ['mains', session.id], queryFn: () => get<string[]>(`/api/sessions/${session.id}/main-classes`) });
  const [cfg, setCfg] = useState<RunConfig>(session.runConfig);
  useEffect(() => {
    const h = setTimeout(() => {
      if (JSON.stringify(cfg) === JSON.stringify(session.runConfig)) return;
      void patch<Session>(`/api/sessions/${session.id}`, { runConfig: cfg }).then((s) => qc.setQueryData(qk.session(session.id), s));
    }, 500);
    return () => clearTimeout(h);
  }, [cfg, session.id, session.runConfig, qc]);
  const options = Array.from(new Set([...(mains.data ?? []), ...(cfg.mainClass ? [cfg.mainClass] : [])]));
  return (
    <div className="grid h-full grid-cols-[7rem_1fr] content-start items-start gap-x-3 gap-y-2 overflow-auto p-3 text-[12.5px]">
      <label htmlFor="main-class" className="pt-1.5 text-muted">
        Main class
      </label>
      <div className="flex items-center gap-2">
        <select id="main-class" className={clsx(inputClass, 'w-full max-w-md font-mono text-[12px]')} value={cfg.mainClass ?? ''} onChange={(e) => setCfg({ ...cfg, mainClass: e.target.value || null })} onFocus={() => mains.refetch()}>
          <option value="">First class with a main method</option>
          {options.map((m) => (
            <option key={m} value={m}>
              {m}
              {mains.data && !mains.data.includes(m) ? ' (no main method found)' : ''}
            </option>
          ))}
        </select>
      </div>
      <label htmlFor="prog-args" className="pt-1.5 text-muted">
        Arguments
      </label>
      <input
        id="prog-args"
        className={clsx(inputClass, 'w-full max-w-md font-mono text-[12px]')}
        placeholder='e.g. --floors 3 "two words"'
        value={cfg.args}
        onChange={(e) => setCfg({ ...cfg, args: e.target.value })}
      />
      <label htmlFor="prog-stdin" className="pt-1.5 text-muted">
        Standard input
      </label>
      <textarea
        id="prog-stdin"
        className={clsx(inputClass, 'h-24 w-full max-w-md resize-y py-1.5 font-mono text-[12px]')}
        placeholder="Text piped to System.in when you press Run"
        value={cfg.stdin}
        onChange={(e) => setCfg({ ...cfg, stdin: e.target.value })}
      />
      <span />
      <p className="max-w-md text-faint">Arguments are split like a shell would split them (quotes supported) but no shell is involved. Saved with this session.</p>
    </div>
  );
}

import { useState } from 'react';
import clsx from 'clsx';
import { Search as SearchIcon } from 'lucide-react';
import { HINT_LEVEL_LABELS, type Job, type SearchMatch } from '@lld/shared';
import { errorMessage, get, post, qs } from '../lib/api';
import { useHints, useProviders, useSettings } from '../lib/queries';
import { aiReadiness } from '../lib/practice';
import { Badge, Button, EmptyState, inputClass, Markdown, Spinner, useConfirm, useToast } from '../components/ui';
import { ProblemView } from '../components/ProblemView';
import { JobProgress } from '../components/JobProgress';
import { useWorkspace } from './context';
import { ChecksSection } from './ChecksPanel';

export function ProblemPanel() {
  const { session } = useWorkspace();
  return (
    <div className="h-full overflow-auto px-4 py-3">
      <ChecksSection />
      <h2 className="text-[16px] font-semibold tracking-tight">{session.problem.content.title}</h2>
      <div className="mt-2">
        <ProblemView problem={session.problem} dense />
      </div>
    </div>
  );
}

export function SearchPanel() {
  const ws = useWorkspace();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [regex, setRegex] = useState(false);
  const [cs, setCs] = useState(false);
  const [res, setRes] = useState<{ matches: SearchMatch[]; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!q) return;
    setBusy(true);
    try {
      await ws.files.flushAll();
      setRes(await get(`/api/sessions/${ws.session.id}/search${qs({ q, regex: regex ? 1 : undefined, caseSensitive: cs ? 1 : undefined })}`));
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const grouped = new Map<string, SearchMatch[]>();
  for (const m of res?.matches ?? []) grouped.set(m.path, [...(grouped.get(m.path) ?? []), m]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        className="flex flex-col gap-1.5 border-b border-line p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="flex gap-1.5">
          <input className={clsx(inputClass, 'min-w-0 flex-1 font-mono text-[12.5px]')} placeholder="Search the project" aria-label="Search text" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button size="sm" type="submit" busy={busy} icon={<SearchIcon className="size-3.5" />}>
            Find
          </Button>
        </div>
        <div className="flex gap-3 text-[12px] text-muted">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} /> Match case
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regular expression
          </label>
        </div>
        <span className="text-[11.5px] text-faint">Find and replace within a file: Cmd/Ctrl+F and Cmd/Ctrl+Alt+F in the editor.</span>
      </form>
      <div className="min-h-0 flex-1 overflow-auto text-[12.5px]">
        {res && !res.matches.length && <EmptyState title="No matches" />}
        {[...grouped].map(([path, ms]) => (
          <div key={path} className="border-b border-line py-1">
            <div className="truncate px-2 font-medium">{path}</div>
            {ms.map((m) => (
              <button key={`${m.line}:${m.column}`} className="flex w-full gap-2 px-2 py-0.5 text-left hover:bg-sunken" onClick={() => ws.openFile(m.path, m.line)}>
                <span className="tabular w-8 shrink-0 text-right text-faint">{m.line}</span>
                <span className="truncate font-mono text-[12px] text-muted">{m.preview.trim()}</span>
              </button>
            ))}
          </div>
        ))}
        {res?.truncated && <div className="px-2 py-1 text-faint">Showing the first 500 matches.</div>}
      </div>
    </div>
  );
}

export function HintsPanel() {
  const ws = useWorkspace();
  const { session } = ws;
  const hints = useHints(session.id);
  const settings = useSettings();
  const providers = useProviders();
  const ai = aiReadiness(settings.data, providers.data);
  const toast = useToast();
  const confirm = useConfirm();
  const used = hints.data ?? [];
  const maxLevel = used.reduce((m, h) => Math.max(m, h.requestedLevel), 0);
  const [level, setLevel] = useState(Math.min(4, maxLevel + 1));
  const [req, setReq] = useState('');
  const [question, setQuestion] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);

  if (session.mode === 'interview') {
    return (
      <div className="p-4 text-[13px] text-muted">
        <div className="font-medium text-ink">Hints are off in interview mode</div>
        <p className="mt-1">Work it through as you would in a real interview. Hints become available in practice-mode sessions.</p>
      </div>
    );
  }
  const ask = async () => {
    if (level === 4 && !(await confirm({ title: 'Ask for a small code example?', body: 'Level 4 hints can include a short code fragment. Hint usage is shown next to your assessment.', confirmLabel: 'Ask for example' })))
      return;
    try {
      await ws.files.flushAll();
      const job = await post<Job>(`/api/sessions/${session.id}/hints`, { level, requirementId: req || null, question: question.trim() || undefined });
      setJobId(job.id);
      setQuestion('');
    } catch (e) {
      toast('err', errorMessage(e));
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line p-3">
        <div className="text-[13px] font-medium">Progressive hints</div>
        <p className="mt-0.5 text-[12px] text-muted">Each level gives a little more. Start by clarifying; code appears only at level 4. Your current code is sent with the request.</p>
        <div className="mt-2 flex flex-col gap-1">
          {[1, 2, 3, 4].map((l) => (
            <label key={l} className={clsx('flex items-center gap-2 text-[12.5px]', l > maxLevel + 1 && 'text-faint')}>
              <input type="radio" name="hint-level" checked={level === l} disabled={l > maxLevel + 1} onChange={() => setLevel(l)} />
              <span className="tabular w-3">{l}</span> {HINT_LEVEL_LABELS[l]}
            </label>
          ))}
        </div>
        <select className={clsx(inputClass, 'mt-2 w-full')} value={req} onChange={(e) => setReq(e.target.value)} aria-label="Focus requirement">
          <option value="">Any requirement</option>
          {session.problem.content.requirements.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id}: {r.text.slice(0, 60)}
            </option>
          ))}
        </select>
        <textarea
          className={clsx(inputClass, 'mt-2 h-16 w-full resize-none py-1.5')}
          placeholder="What are you stuck on? (optional)"
          aria-label="Your question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button className="mt-2 w-full" size="sm" variant="primary" disabled={!ai.ready} title={ai.reason ?? undefined} onClick={ask}>
          Ask for a level {level} hint
        </Button>
        {!ai.ready && <p className="mt-1 text-[12px] text-faint">{ai.reason}</p>}
        {jobId && (
          <div className="mt-2">
            <JobProgress jobId={jobId} title="Hint" compact />
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {hints.isLoading && <Spinner />}
        {!used.length && !hints.isLoading && <p className="text-[12.5px] text-faint">No hints used in this session.</p>}
        <ol className="flex flex-col gap-3">
          {[...used].reverse().map((h) => (
            <li key={h.id} className="rounded-[5px] border border-line bg-panel p-2.5 text-[13px]">
              <div className="flex items-center gap-1.5">
                <Badge tone="accent">Level {h.requestedLevel}</Badge>
                {h.requirementId && <Badge>{h.requirementId}</Badge>}
                {h.isMock && <Badge tone="warn">MOCK</Badge>}
                <span className="ml-auto text-[11.5px] text-faint">{h.provider}</span>
              </div>
              <div className="mt-1.5 font-medium">{h.title}</div>
              <Markdown className="mt-1 text-muted">{h.content}</Markdown>
              {h.codeExample && <pre className="mt-1.5 overflow-auto rounded-[4px] border border-line bg-sunken p-2 font-mono text-[12px]">{h.codeExample}</pre>}
              <div className="mt-1.5 text-[12.5px] text-ink italic">{h.followUpQuestion}</div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

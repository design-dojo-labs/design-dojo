import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { HldSession } from '@lld/shared';
import { PageShell } from '../components/Shell';
import { Button, ErrorNote, Segmented, Spinner, useToast } from '../components/ui';
import { errorMessage, post } from '../lib/api';
import { HldProblemView } from './HldProblemView';
import { useHldProblem } from './queries';

export function HldProblemPage() {
  const { id = '' } = useParams();
  const problem = useHldProblem(id);
  const navigate = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState<'practice' | 'interview'>('practice');
  const [duration, setDuration] = useState(0);
  const [busy, setBusy] = useState(false);
  const p = problem.data;
  const minutes = duration || p?.content.estimatedMinutes || 60;
  const start = async () => {
    if (!p) return;
    setBusy(true);
    try {
      const s = await post<HldSession>('/api/hld/sessions', { problemId: p.id, problemVersion: p.version, mode, durationMinutes: mode === 'interview' || duration ? minutes : null });
      navigate(`/hld/session/${s.id}`);
    } catch (e) {
      toast('err', errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <PageShell>
      <Link to="/hld" className="text-[12.5px] text-muted hover:text-ink">
        Back to HLD practice
      </Link>
      {problem.isLoading ? (
        <Spinner className="mt-6" />
      ) : problem.error ? (
        <div className="mt-4">
          <ErrorNote>{errorMessage(problem.error)}</ErrorNote>
        </div>
      ) : p ? (
        <div className="mt-2 grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight">{p.content.title}</h1>
            <p className="mt-1 max-w-[70ch] text-muted">{p.content.summary}</p>
            <div className="mt-4">
              <HldProblemView problem={p} />
            </div>
          </div>
          <aside className="lg:sticky lg:top-16 lg:self-start">
            <div className="rounded-[6px] border border-line bg-panel p-4">
              <h2 className="text-[14px] font-semibold">Start this design</h2>
              <div className="mt-3 flex flex-col gap-3">
                <Segmented
                  label="Mode"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'practice', label: 'Practice' },
                    { value: 'interview', label: 'Interview' },
                  ]}
                />
                <Segmented
                  size="sm"
                  label="Time limit"
                  value={duration}
                  onChange={setDuration}
                  options={[
                    { value: 0, label: mode === 'interview' ? `${p.content.estimatedMinutes}m` : 'Untimed' },
                    { value: 30, label: '30m' },
                    { value: 45, label: '45m' },
                    { value: 60, label: '60m' },
                    { value: 90, label: '90m' },
                  ]}
                />
                <p className="text-[12.5px] text-muted">
                  You will work through requirements, estimates, API, data model, an architecture diagram and deep dives. Everything autosaves.
                </p>
                <Button variant="primary" busy={busy} onClick={start}>
                  Start designing
                </Button>
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </PageShell>
  );
}

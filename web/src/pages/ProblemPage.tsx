import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Session } from '@lld/shared';
import { PageShell } from '../components/Shell';
import { Button, ErrorNote, Segmented, Spinner, useToast } from '../components/ui';
import { ProblemView } from '../components/ProblemView';
import { errorMessage, post } from '../lib/api';
import { useProblem } from '../lib/queries';

export function ProblemPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const problem = useProblem(id);
  const initialDuration = params.get('duration');
  const [mode, setMode] = useState<'practice' | 'interview'>(params.get('mode') === 'interview' ? 'interview' : 'practice');
  const [duration, setDuration] = useState<number>(initialDuration === 'untimed' ? 0 : Number(initialDuration) || problem.data?.content.estimatedMinutes || 60);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!problem.data) return;
    setBusy(true);
    try {
      const s = await post<Session>('/api/sessions', {
        problemId: problem.data.id,
        problemVersion: problem.data.version,
        mode,
        durationMinutes: duration === 0 ? null : duration,
      });
      navigate(`/session/${s.id}`);
    } catch (e) {
      toast('err', errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <PageShell>
      <Link to="/lld" className="text-[12.5px] text-muted hover:text-ink">
        Back to LLD practice
      </Link>
      {problem.isLoading ? (
        <Spinner className="mt-6" />
      ) : problem.error ? (
        <div className="mt-4">
          <ErrorNote>{errorMessage(problem.error)}</ErrorNote>
        </div>
      ) : problem.data ? (
        <div className="mt-2 grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight">{problem.data.content.title}</h1>
            <p className="mt-1 max-w-[70ch] text-muted">{problem.data.content.summary}</p>
            <div className="mt-4">
              <ProblemView problem={problem.data} />
            </div>
          </div>
          <aside className="lg:sticky lg:top-16 lg:self-start">
            <div className="rounded-[6px] border border-line bg-panel p-4">
              <h2 className="text-[14px] font-semibold">Start this problem</h2>
              <div className="mt-3 flex flex-col gap-3">
                <div>
                  <div className="mb-1 text-[12.5px] text-muted">Mode</div>
                  <Segmented
                    label="Mode"
                    value={mode}
                    onChange={(v) => {
                      setMode(v);
                      if (v === 'interview' && duration === 0) setDuration(60);
                    }}
                    options={[
                      { value: 'practice', label: 'Practice' },
                      { value: 'interview', label: 'Interview' },
                    ]}
                  />
                </div>
                <div>
                  <div className="mb-1 text-[12.5px] text-muted">Time limit</div>
                  <Segmented
                    size="sm"
                    label="Time limit"
                    value={duration}
                    onChange={setDuration}
                    options={[30, 45, 60, 90]
                      .map((d) => ({ value: d, label: `${d}m` }))
                      .concat(mode === 'practice' ? [{ value: 0, label: 'Untimed' }] : [])}
                  />
                </div>
                <p className="text-[12.5px] text-muted">
                  {mode === 'practice'
                    ? 'You can pause the timer and ask for progressive hints. Hint usage is shown next to your assessment.'
                    : 'The timer cannot be paused and AI hints are off. Submit before time runs out.'}
                </p>
                <Button variant="primary" busy={busy} onClick={start}>
                  Start session
                </Button>
                <p className="text-[12px] text-faint">Creates a Maven project with a starter class and one demonstration test. The requirements and rubric above stay fixed for this attempt.</p>
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </PageShell>
  );
}

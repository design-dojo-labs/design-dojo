import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ExternalLink, KeyRound, LogIn, PlugZap, RefreshCw } from 'lucide-react';
import type { ApiKeyInfo, Bootstrap, Effort, Job, ProviderStatus, Settings, SettingsPatch } from '@lld/shared';
import { PageShell } from '../components/Shell';
import { Badge, Button, ErrorNote, Field, inputClass, Segmented, Spinner, useConfirm, useToast } from '../components/ui';
import { JobProgress } from '../components/JobProgress';
import { del, errorMessage, get, getBootstrap, post, put } from '../lib/api';
import { qk, useApiKey, useJava, useLogin, useProviders, useQc, useSettings } from '../lib/queries';
import { relativeTime } from '../lib/format';

export function SettingsPage() {
  const settings = useSettings();
  const qc = useQc();
  const toast = useToast();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  useEffect(() => {
    getBootstrap().then(setBoot, () => {});
  }, []);

  const save = async (patch: SettingsPatch) => {
    try {
      const next = await put<Settings>('/api/settings', patch);
      qc.setQueryData(qk.settings, next);
      qc.invalidateQueries({ queryKey: qk.providers });
      if (patch.java) qc.invalidateQueries({ queryKey: qk.java });
    } catch (e) {
      toast('err', errorMessage(e));
    }
  };

  if (!settings.data) return <PageShell>{settings.error ? <ErrorNote>{errorMessage(settings.error)}</ErrorNote> : <Spinner />}</PageShell>;
  const s = settings.data;
  return (
    <PageShell>
      <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
      <div className="mt-6 flex max-w-[860px] flex-col gap-10">
        <ProviderSection settings={s} save={save} mockAvailable={!!boot?.mockAvailable} />
        <JavaSection settings={s} save={save} />
        <Group title="Editor">
          <div className="grid grid-cols-[10rem_1fr] items-center gap-3">
            <span className="text-[13px] text-muted">Theme</span>
            <Segmented
              label="Theme"
              value={s.editor.theme}
              onChange={(v) => save({ editor: { theme: v } })}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
            />
            <span className="text-[13px] text-muted">Font size</span>
            <NumberInput value={s.editor.fontSize} min={10} max={28} onCommit={(v) => save({ editor: { fontSize: v } })} suffix="px" />
            <span className="text-[13px] text-muted">Autosave delay</span>
            <NumberInput value={s.editor.autosaveDelayMs} min={300} max={10000} step={100} onCommit={(v) => save({ editor: { autosaveDelayMs: v } })} suffix="ms" />
          </div>
        </Group>
        <Group title="Reviews">
          <div className="grid grid-cols-[10rem_1fr] items-center gap-3">
            <span className="text-[13px] text-muted">Review mode</span>
            <Segmented
              label="Review mode"
              value={s.review.mode}
              onChange={(v) => save({ review: { mode: v } })}
              options={[
                { value: 'fast', label: 'Fast (recommended)', title: 'Score pass and detail pass run in parallel; the score appears first' },
                { value: 'full', label: 'Full', title: 'One combined request, as before' },
              ]}
            />
            <span />
            <p className="text-[12.5px] text-faint">
              {s.review.mode === 'fast'
                ? 'Fast: the score, category breakdown and top findings come from one request while a second request writes the detailed design assessment in parallel, so the score shows up first. Uses two requests per review.'
                : 'Full: one combined request returns the whole review at once. Slower to first result, one request per review.'}
            </p>
            <span className="text-[13px] text-muted">Max source size</span>
            <NumberInput value={s.review.maxContextKb} min={32} max={2048} onCommit={(v) => save({ review: { maxContextKb: v } })} suffix="KB" />
          </div>
          <p className="mt-2 text-[12.5px] text-faint">
            Submissions larger than this are refused with a list of the largest files. Source files are never silently dropped from a review; build output, IDE files and the managed Maven
            Wrapper scripts are excluded and listed in each review.
          </p>
        </Group>
        <NotificationsSection settings={s} save={save} />
        <Group title="Data">
          <p className="text-[13px] text-muted">
            Everything is stored locally in <code className="font-mono text-ink">{boot?.dataRoot ?? '…'}</code>: the SQLite database, your workspaces (plain Maven projects you can open in
            any IDE), immutable submission snapshots, reference solutions and the isolated Maven cache. Deleted files go to the <code className="font-mono">trash</code> folder there.
          </p>
          <p className="mt-2 text-[12.5px] text-faint">
            Server bound to {boot?.bindHost}:{boot?.port}. Change the location with the LLD_STUDIO_HOME environment variable.
          </p>
        </Group>
      </div>
    </PageShell>
  );
}

function Group({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-labelledby={`${title}-h`}>
      <h2 id={`${title}-h`} className="mb-3 border-b border-line pb-1.5 text-[15px] font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function NumberInput({ value, min, max, step = 1, suffix, onCommit }: { value: number; min: number; max: number; step?: number; suffix?: string; onCommit: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) {
      setV(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="number"
        className={clsx(inputClass, 'tabular w-28')}
        value={v}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {suffix && <span className="text-[12px] text-faint">{suffix}</span>}
    </span>
  );
}

function TextSetting({ value, placeholder, onCommit, mono }: { value: string; placeholder?: string; onCommit: (v: string) => void; mono?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={clsx(inputClass, 'w-full', mono && 'font-mono text-[12.5px]')}
      value={v}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() !== value && onCommit(v.trim())}
      onKeyDown={(e) => e.key === 'Enter' && v.trim() !== value && onCommit(v.trim())}
    />
  );
}

// ───────────────────────── AI providers ─────────────────────────

const STATE_BADGE: Record<ProviderStatus['state'], { tone: 'ok' | 'err' | 'warn' | 'neutral'; text: string }> = {
  authenticated: { tone: 'ok', text: 'Logged in' },
  installed: { tone: 'warn', text: 'Installed, unverified' },
  'not-installed': { tone: 'err', text: 'Not installed' },
  unauthenticated: { tone: 'err', text: 'Not connected' },
  'auth-blocked': { tone: 'err', text: 'Blocked' },
  error: { tone: 'err', text: 'Error' },
  mock: { tone: 'warn', text: 'Mock' },
};

function ProviderSection({ settings, save, mockAvailable }: { settings: Settings; save: (p: SettingsPatch) => Promise<void>; mockAvailable: boolean }) {
  const providers = useProviders();
  const qc = useQc();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(qk.providers, await get<ProviderStatus[]>('/api/status/providers?refresh=1'));
    } finally {
      setRefreshing(false);
    }
  };
  const options: { value: Settings['provider']; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'gemini', label: 'Gemini' },
    ...(mockAvailable ? [{ value: 'mock' as const, label: 'Mock (tests)' }] : []),
  ];
  return (
    <Group title="AI provider">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="AI provider" value={settings.provider} onChange={(v) => save({ provider: v })} options={options} />
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} busy={refreshing} onClick={refresh}>
          Re-check
        </Button>
      </div>
      <p className="mt-2 max-w-[75ch] text-[12.5px] text-muted">
        AI features run through the official Claude Code, Codex or Gemini CLI installed on this machine, which needs internet access. Each request sends the problem, your code, design notes and test
        results to the selected provider. Problems, editing, history and Java builds work without it. Usage counts against your plan's limits; the studio never switches provider on its own.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        {providers.isLoading && <Spinner />}
        {providers.data
          ?.filter((p) => p.id !== 'mock')
          .map((p) => <ProviderCard key={p.id} status={p} settings={settings} save={save} selected={settings.provider === p.id} />)}
        {providers.data
          ?.filter((p) => p.id === 'mock')
          .map((p) => (
            <div key="mock" className="rounded-[6px] border border-dashed border-line-strong px-3 py-2 text-[12.5px] text-muted">
              <span className="font-medium text-ink">Mock provider is enabled</span> (server started with LLD_STUDIO_ENABLE_MOCK=1). It returns canned output for tests and demos, never
              reads your code, and its results are labelled MOCK and excluded from progress statistics. {p.detail}
            </div>
          ))}
      </div>
    </Group>
  );
}

type CliProvider = 'claude' | 'codex' | 'gemini';

const PROVIDER_META: Record<
  CliProvider,
  { cli: string; subscription: string; keyVar: string; keyVendor: string; keyLabel: string; keyPlaceholder: string; loginCommand: string; effortNote: string; modelHint: string }
> = {
  claude: {
    cli: 'Claude Code',
    subscription: 'Claude subscription',
    keyVar: 'ANTHROPIC_API_KEY',
    keyVendor: 'Anthropic',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-…',
    loginCommand: 'claude auth login --claudeai',
    effortNote: 'Claude Code: passed as --effort when your version lists it in --help.',
    modelHint: 'e.g. opus, sonnet, haiku',
  },
  codex: {
    cli: 'Codex',
    subscription: 'ChatGPT subscription',
    keyVar: 'CODEX_API_KEY',
    keyVendor: 'OpenAI',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    loginCommand: 'codex login',
    effortNote: 'Codex: passed as --config model_reasoning_effort=… when your version supports --config.',
    modelHint: 'a model your ChatGPT plan offers',
  },
  gemini: {
    cli: 'Gemini CLI',
    subscription: 'Google login',
    keyVar: 'GEMINI_API_KEY',
    keyVendor: 'Google',
    keyLabel: 'Gemini API key',
    keyPlaceholder: 'AIza…',
    loginCommand: 'gemini',
    effortNote: 'Gemini CLI has no effort flag (thinking is only configurable in its own settings.json), so effort is ignored for Gemini.',
    modelHint: 'e.g. pro, flash, flash-lite, gemini-2.5-pro',
  },
};

const EFFORT_OPTIONS: { value: Effort; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

function ProviderCard({ status, settings, save, selected }: { status: ProviderStatus; settings: Settings; save: (p: SettingsPatch) => Promise<void>; selected: boolean }) {
  const id = status.id as CliProvider;
  const cfg = settings[id];
  const meta = PROVIDER_META[id];
  const patch = (v: Partial<Settings[CliProvider]>) => save({ [id]: v } as SettingsPatch);
  const badge = STATE_BADGE[status.state];
  const toast = useToast();
  const [testJob, setTestJob] = useState<string | null>(null);
  const runTest = async () => {
    try {
      setTestJob((await post<Job>(`/api/providers/${id}/test`)).id);
    } catch (e) {
      toast('err', errorMessage(e));
    }
  };
  return (
    <div className={clsx('rounded-[6px] border bg-panel', selected ? 'border-line-strong' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-semibold">{status.label}</span>
        <Badge tone={badge.tone}>{badge.text}</Badge>
        {status.version && <span className="text-[12px] text-faint">{status.version}</span>}
        {selected && <Badge tone="info">Selected</Badge>}
      </div>
      <div className="flex flex-col gap-4 px-4 py-3">
        <p className="text-[13px] text-muted">{status.detail}</p>
        {status.lastConnectionTest && (
          <p className={clsx('text-[12.5px]', status.lastConnectionTest.ok ? 'text-ok' : 'text-err')}>
            Last connection test {relativeTime(status.lastConnectionTest.at)}: {status.lastConnectionTest.ok ? 'succeeded' : 'failed'}
            {status.lastConnectionTest.model ? ` (model ${status.lastConnectionTest.model})` : ''}. {status.lastConnectionTest.ok ? '' : status.lastConnectionTest.message}
          </p>
        )}

        <div>
          <div className="mb-1.5 text-[12.5px] font-medium text-muted">How to authenticate</div>
          <Segmented
            label={`${status.label} authentication`}
            value={cfg.authMode}
            onChange={(v) => patch({ authMode: v })}
            options={[
              { value: 'subscription', label: meta.subscription },
              { value: 'api-key', label: 'API key' },
            ]}
          />
          <p className="mt-1.5 text-[12px] text-faint">
            {cfg.authMode === 'subscription'
              ? id === 'gemini'
                ? 'Uses the Google login stored by the Gemini CLI (Google AI Pro/Ultra plans get higher limits). API-key, Vertex AI and gateway variables are blanked for each run, and jobs are refused if the CLI is set to any other auth type.'
                : `Uses the login stored by the ${meta.cli} CLI. API-key variables are removed from the CLI's environment, and the job is stopped if the CLI reports API-key auth.`
              : `Passes your key to the official CLI for each request (${meta.keyVar}). Usage is billed per token by ${meta.keyVendor} to that key's account.`}
          </p>
        </div>

        {cfg.authMode === 'subscription' ? <LoginControl provider={id} status={status} /> : <ApiKeyControl provider={id} />}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<PlugZap className="size-3.5" />} onClick={runTest} disabled={status.state === 'not-installed'}>
            Test connection
          </Button>
          <span className="text-[12px] text-faint">Sends one tiny request through the CLI (counts as one request on your plan or key).</span>
        </div>
        {testJob && <JobProgress jobId={testJob} title="Connection test" compact />}

        <details className="text-[13px]" open={!!(cfg.model || cfg.detailModel || cfg.assistModel || cfg.effort !== 'default')}>
          <summary className="cursor-pointer text-muted hover:text-ink">Models and speed</summary>
          <div className="mt-3 grid grid-cols-[10rem_1fr] items-center gap-3">
            <span className="text-[13px] text-muted">Review model</span>
            <TextSetting value={cfg.model} placeholder={`CLI default (${meta.modelHint})`} mono onCommit={(v) => patch({ model: v })} />
            <span className="text-[13px] text-muted">Detail model</span>
            <TextSetting value={cfg.detailModel} placeholder="same as review model" mono onCommit={(v) => patch({ detailModel: v })} />
            <span className="text-[13px] text-muted">Assist model</span>
            <TextSetting value={cfg.assistModel} placeholder="same as review model" mono onCommit={(v) => patch({ assistModel: v })} />
            <span className="text-[13px] text-muted">Effort</span>
            <Segmented size="sm" label={`${status.label} review effort`} value={cfg.effort} onChange={(v) => patch({ effort: v })} options={EFFORT_OPTIONS} />
            <span className="text-[13px] text-muted">Assist effort</span>
            <Segmented size="sm" label={`${status.label} assist effort`} value={cfg.assistEffort} onChange={(v) => patch({ assistEffort: v })} options={EFFORT_OPTIONS} />
          </div>
          <ul className="mt-2 flex flex-col gap-1 text-[12px] text-faint">
            <li>
              <span className="text-muted">Review model</span> scores reviews (and runs reference solutions and connection tests). <span className="text-muted">Detail model</span> writes the
              slower review detail (design assessment, follow-up questions). <span className="text-muted">Assist model</span> answers hints, chat and fix suggestions and generates
              problems. Each is passed as <code className="font-mono">--model</code>; empty fields fall back to the review model, then to the CLI default.
            </li>
            <li>
              Effort applies to reviews and review detail; assist effort to everything else. Default leaves the CLI's own setting. {meta.effortNote}
            </li>
          </ul>
        </details>

        <details className="text-[13px]">
          <summary className="cursor-pointer text-muted hover:text-ink">Advanced</summary>
          <div className="mt-3 grid grid-cols-[10rem_1fr] items-center gap-3">
            <span className="text-[13px] text-muted">Executable path</span>
            <TextSetting value={cfg.executablePath} placeholder={status.executable ?? `found on PATH`} mono onCommit={(v) => patch({ executablePath: v })} />
            <span className="text-[13px] text-muted">Request timeout</span>
            <NumberInput value={cfg.timeoutSec} min={30} max={1800} onCommit={(v) => patch({ timeoutSec: v })} suffix="seconds" />
          </div>
        </details>
      </div>
    </div>
  );
}

function LoginControl({ provider, status }: { provider: CliProvider; status: ProviderStatus }) {
  if (provider === 'gemini') return <GeminiLoginHelp status={status} />;
  return <CliLoginControl provider={provider} status={status} />;
}

/** The Gemini CLI signs in only from its interactive terminal UI, so this explains the steps instead of running a command. */
function GeminiLoginHelp({ status }: { status: ProviderStatus }) {
  const qc = useQc();
  const [busy, setBusy] = useState(false);
  const recheck = async () => {
    setBusy(true);
    try {
      qc.setQueryData(qk.providers, await get<ProviderStatus[]>('/api/status/providers?refresh=1'));
    } finally {
      setBusy(false);
    }
  };
  const loggedIn = status.state === 'authenticated';
  return (
    <div className="rounded-[5px] border border-line bg-sunken px-3 py-2 text-[12.5px]">
      {loggedIn ? (
        <p className="text-muted">Signed in with Google. To switch accounts, run <code className="font-mono">gemini</code> in a terminal and use <code className="font-mono">/auth</code>.</p>
      ) : (
        <ol className="list-decimal pl-5 text-muted">
          <li>
            Open a terminal and run <code className="font-mono text-ink">gemini</code> (install first with <code className="font-mono">npm i -g @google/gemini-cli</code>).
          </li>
          <li>Choose “Sign in with Google” and finish in the browser, using the account that has your Google AI Pro/Ultra plan.</li>
          <li>
            Type <code className="font-mono">/quit</code>, then press Re-check.
          </li>
        </ol>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant={loggedIn ? 'ghost' : 'primary'} icon={<RefreshCw className="size-3.5" />} busy={busy} onClick={recheck}>
          Re-check
        </Button>
        <span className="text-faint">The CLI keeps its own credentials in ~/.gemini; the studio never reads the tokens.</span>
      </div>
    </div>
  );
}

function CliLoginControl({ provider, status }: { provider: 'claude' | 'codex'; status: ProviderStatus }) {
  const login = useLogin(provider).data;
  const toast = useToast();
  const running = login?.state === 'running';
  const start = async () => {
    try {
      await post(`/api/providers/${provider}/login`);
    } catch (e) {
      toast('err', errorMessage(e));
    }
  };
  const loggedIn = status.state === 'authenticated';
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={loggedIn ? 'secondary' : 'primary'} icon={<LogIn className="size-3.5" />} busy={running} onClick={start} disabled={status.state === 'not-installed'}>
          {loggedIn ? 'Log in again' : 'Connect subscription'}
        </Button>
        {running && (
          <Button size="sm" variant="ghost" onClick={() => post(`/api/providers/${provider}/login/cancel`).catch(() => {})}>
            Cancel
          </Button>
        )}
        <span className="text-[12px] text-faint">
          Runs <code className="font-mono">{login?.command ?? PROVIDER_META[provider].loginCommand}</code>; the CLI stores its own credentials.
        </span>
      </div>
      {login && login.state !== 'idle' && (
        <div className="mt-2 rounded-[5px] border border-line bg-sunken px-3 py-2 text-[12.5px]">
          <div className={clsx(login.state === 'failed' ? 'text-err' : login.state === 'succeeded' ? 'text-ok' : 'text-muted')}>{login.message}</div>
          {login.urls.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {login.urls.slice(0, 3).map((u) => (
                <li key={u}>
                  <a href={u} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all text-focus underline">
                    Open sign-in page <ExternalLink className="size-3" />
                  </a>
                  <span className="ml-2 font-mono text-[11px] break-all text-faint">{new URL(u).host}</span>
                </li>
              ))}
            </ul>
          )}
          {login.output && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-faint">CLI output</summary>
              <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap text-muted">{login.output}</pre>
            </details>
          )}
          {login.state === 'failed' && (
            <p className="mt-1.5 text-faint">
              Some CLI versions need an interactive terminal to log in. Run <code className="font-mono">{login.command}</code> in a terminal, then press Re-check above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ApiKeyControl({ provider }: { provider: CliProvider }) {
  const info = useApiKey(provider);
  const qc = useQc();
  const toast = useToast();
  const confirm = useConfirm();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const saveKey = async () => {
    setBusy(true);
    try {
      qc.setQueryData(qk.apiKey(provider), await put<ApiKeyInfo>(`/api/providers/${provider}/api-key`, { apiKey: value }));
      qc.invalidateQueries({ queryKey: qk.providers });
      setValue('');
      toast('ok', 'API key saved.');
    } catch (e) {
      toast('err', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const removeKey = async () => {
    if (!(await confirm({ title: 'Remove saved API key?', body: 'The key stored in the studio data folder will be deleted. An environment variable key, if present, is not affected.', confirmLabel: 'Remove key', danger: true })))
      return;
    qc.setQueryData(qk.apiKey(provider), await del<ApiKeyInfo>(`/api/providers/${provider}/api-key`));
    qc.invalidateQueries({ queryKey: qk.providers });
  };
  const i = info.data;
  return (
    <div className="flex flex-col gap-2">
      {i?.configured ? (
        <p className="flex items-center gap-2 text-[13px]">
          <KeyRound className="size-4 text-muted" aria-hidden />
          Using key <code className="font-mono">{i.hint}</code> {i.source === 'env' ? `from $${i.envVar}` : 'saved in the studio'}.
          {i.source === 'stored' && (
            <Button size="sm" variant="ghost" onClick={removeKey}>
              Remove
            </Button>
          )}
        </p>
      ) : (
        <p className="text-[13px] text-err">No API key configured. AI jobs will fail until you add one or switch back to subscription login.</p>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void saveKey();
        }}
      >
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={PROVIDER_META[provider].keyLabel}
          placeholder={PROVIDER_META[provider].keyPlaceholder}
          className={clsx(inputClass, 'w-80 font-mono')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button size="sm" type="submit" busy={busy} disabled={!value.trim()}>
          {i?.source === 'stored' ? 'Replace key' : 'Save key'}
        </Button>
      </form>
      <p className="text-[12px] text-faint">
        Saved keys stay in an owner-only file (secrets.json, mode 600) in the studio data folder. Only the last four characters are ever shown. Keys never reach Java processes, logs or exports.
      </p>
    </div>
  );
}

// ───────────────────────── Notifications ─────────────────────────

function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';
}

function NotificationsSection({ settings, save }: { settings: Settings; save: (p: SettingsPatch) => Promise<void> }) {
  const [permission, setPermission] = useState(notificationPermission);
  const setDesktop = async (on: boolean) => {
    // Ask the browser only when the user turns this on; a denied permission is reported, never retried silently.
    if (on && permission === 'default') setPermission(await Notification.requestPermission());
    await save({ notifications: { desktop: on } });
  };
  const onOff = [
    { value: 'on' as const, label: 'On' },
    { value: 'off' as const, label: 'Off' },
  ];
  return (
    <Group title="Notifications">
      <div className="grid grid-cols-[10rem_1fr] items-center gap-3">
        <span className="text-[13px] text-muted">Desktop notification</span>
        <Segmented label="Desktop notification" value={settings.notifications.desktop ? 'on' : 'off'} onChange={(v) => void setDesktop(v === 'on')} options={onOff} />
        <span className="text-[13px] text-muted">Sound</span>
        <Segmented label="Sound" value={settings.notifications.sound ? 'on' : 'off'} onChange={(v) => save({ notifications: { sound: v === 'on' } })} options={onOff} />
      </div>
      <p className="mt-2 text-[12.5px] text-faint">
        When a review or another AI job finishes while you are in another tab or window, the studio can show a browser notification and play a short sound.
        {settings.notifications.desktop && permission === 'denied' && ' Your browser is blocking notifications for this page; allow them in the site settings to receive them.'}
        {settings.notifications.desktop && permission === 'unsupported' && ' This browser does not support notifications.'}
      </p>
    </Group>
  );
}

// ───────────────────────── Java ─────────────────────────

function JavaSection({ settings, save }: { settings: Settings; save: (p: SettingsPatch) => Promise<void> }) {
  const java = useJava();
  const qc = useQc();
  const toast = useToast();
  const [job, setJob] = useState<string | null>(null);
  const j = java.data;
  return (
    <Group title="Java toolchain" id="java">
      {!j ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={j.ok ? 'ok' : 'err'}>{j.ok ? 'JDK ready' : 'JDK not ready'}</Badge>
            <Badge tone={j.maven.distributionCached && j.maven.dependenciesCached ? 'ok' : 'warn'}>
              {j.maven.distributionCached && j.maven.dependenciesCached ? `Maven ${j.maven.mavenVersion} cached` : 'Maven not downloaded yet'}
            </Badge>
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={async () => qc.setQueryData(qk.java, await get('/api/status/java?refresh=1'))}>
              Re-check
            </Button>
          </div>
          <p className="text-[13px] text-muted">{j.detail}</p>
          {j.javaHome && (
            <p className="text-[12.5px] text-faint">
              Using <code className="font-mono text-muted">{j.javaHome}</code> (Java {j.javaVersion}, found via {j.source}). Projects compile with <code className="font-mono">--release {j.release}</code>.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={j.maven.dependenciesCached ? 'secondary' : 'primary'}
              disabled={!j.ok}
              onClick={async () => {
                try {
                  setJob((await post<Job>('/api/status/java/bootstrap')).id);
                } catch (e) {
                  toast('err', errorMessage(e));
                }
              }}
            >
              {j.maven.dependenciesCached ? 'Re-run toolchain preparation' : 'Prepare toolchain'}
            </Button>
            <span className="text-[12px] text-faint">
              Downloads Maven {j.maven.mavenVersion} (checksum-verified) and JUnit 5 into {j.maven.userHome}, about 25 MB, once.
            </span>
          </div>
          {job && <JobProgress jobId={job} title="Preparing toolchain" />}
          <details className="text-[13px]">
            <summary className="cursor-pointer text-muted hover:text-ink">Advanced</summary>
            <div className="mt-3 grid grid-cols-[10rem_1fr] items-center gap-3">
              <span className="text-[13px] text-muted">Java home</span>
              <TextSetting value={settings.java.javaHome} placeholder={j.javaHome ?? 'auto-detect'} mono onCommit={(v) => save({ java: { javaHome: v } })} />
              <span className="text-[13px] text-muted">Target release</span>
              <NumberInput value={settings.java.release} min={17} max={30} onCommit={(v) => save({ java: { release: v } })} />
              <span className="text-[13px] text-muted">Compile timeout</span>
              <NumberInput value={settings.java.compileTimeoutSec} min={10} max={900} onCommit={(v) => save({ java: { compileTimeoutSec: v } })} suffix="seconds" />
              <span className="text-[13px] text-muted">Run timeout</span>
              <NumberInput value={settings.java.runTimeoutSec} min={1} max={600} onCommit={(v) => save({ java: { runTimeoutSec: v } })} suffix="seconds" />
              <span className="text-[13px] text-muted">Test timeout</span>
              <NumberInput value={settings.java.testTimeoutSec} min={10} max={900} onCommit={(v) => save({ java: { testTimeoutSec: v } })} suffix="seconds" />
              <span className="text-[13px] text-muted">Output limit</span>
              <NumberInput value={settings.java.maxOutputKb} min={16} max={8192} onCommit={(v) => save({ java: { maxOutputKb: v } })} suffix="KB" />
              <span className="text-[13px] text-muted">Maven cache</span>
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={settings.java.useIsolatedMavenRepo} onChange={(e) => save({ java: { useIsolatedMavenRepo: e.target.checked } })} />
                Use an isolated cache in the studio data folder (ignores ~/.m2/settings.xml mirrors)
              </label>
            </div>
            {j.candidates.length > 1 && (
              <div className="mt-3 text-[12.5px] text-faint">
                Other JDKs found: {j.candidates.filter((c) => c.home !== j.javaHome).map((c) => `${c.version} (${c.home})`).join('; ')}
              </div>
            )}
          </details>
          <p className="text-[12px] text-faint">
            Your code runs as your user on this machine. Timeouts and output limits keep the studio responsive, but they are not a security sandbox. Only run code you wrote or trust.
          </p>
        </div>
      )}
    </Group>
  );
}

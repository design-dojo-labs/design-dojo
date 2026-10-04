import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import { Loader2, X } from 'lucide-react';

// ───────────────────────── Buttons ─────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-[5px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-ink text-canvas hover:opacity-90',
        variant === 'secondary' && 'border border-line-strong bg-panel text-ink hover:bg-sunken',
        variant === 'ghost' && 'text-muted hover:bg-sunken hover:text-ink',
        variant === 'danger' && 'border border-err/60 bg-panel text-err hover:bg-err-soft',
        className,
      )}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={clsx('inline-flex size-7 items-center justify-center rounded-[4px] text-muted hover:bg-sunken hover:text-ink disabled:opacity-40', className)}
    >
      {children}
    </button>
  );
}

// ───────────────────────── Segmented control ─────────────────────────

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  size = 'md',
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = options.findIndex((o) => o.value === value);
  const move = (d: number) => {
    const n = (idx + d + options.length) % options.length;
    onChange(options[n].value);
    refs.current[n]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex w-fit flex-wrap rounded-[6px] border border-line-strong bg-sunken p-0.5"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') (e.preventDefault(), move(1));
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') (e.preventDefault(), move(-1));
      }}
    >
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value || (idx < 0 && i === 0) ? 0 : -1}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-[4px] font-medium transition-colors',
            size === 'sm' ? 'px-2 py-0.5 text-[12px]' : 'px-2.5 py-1 text-[13px]',
            o.value === value ? 'bg-panel text-ink shadow-[0_0_0_1px_var(--c-line-strong)]' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── Form bits ─────────────────────────

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-muted">
        {label}
      </label>
      {children}
      {hint && <div className="text-[12px] text-faint">{hint}</div>}
    </div>
  );
}

export const inputClass =
  'h-8 rounded-[5px] border border-line-strong bg-panel px-2.5 text-[13px] text-ink placeholder:text-faint focus:border-focus focus:outline-none';

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'ok' | 'err' | 'warn' | 'accent' | 'info'; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1 rounded-[4px] px-1.5 py-[1px] text-[11.5px] font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-sunken text-muted',
        tone === 'ok' && 'bg-ok-soft text-ok',
        tone === 'err' && 'bg-err-soft text-err',
        tone === 'warn' && 'bg-accent-soft text-warn',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'info' && 'bg-select text-ink',
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-muted', className)} aria-label="Loading" />;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 px-4 py-6 text-[13px]">
      <div className="font-medium text-ink">{title}</div>
      {children && <div className="text-muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="rounded-[5px] border border-err/40 bg-err-soft px-3 py-2 text-[13px] text-err">{children}</div>;
}

// ───────────────────────── Markdown (safe) ─────────────────────────

/** Renders Markdown without raw HTML; react-markdown escapes HTML and sanitizes link URLs by default. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={clsx('prose-studio', className)}>
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {c}
            </a>
          ),
          img: () => null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// ───────────────────────── Rubric bar ─────────────────────────

const SEG_LABEL: Record<string, string> = {
  correctness: 'Correctness',
  modeling: 'Modeling',
  principles: 'Principles',
  extensibility: 'Extensibility',
  readability: 'Readability',
  edge_cases: 'Edge cases',
  tests: 'Tests',
  requirements: 'Requirements',
  api: 'API',
  data_model: 'Data model',
  architecture: 'Architecture',
  scalability: 'Scale & reliability',
  tradeoffs: 'Trade-offs',
};

/**
 * The rubric drawn to scale: each segment's width is the category's weight out of 100 and its fill
 * is the earned share. Unscored categories show only the outline.
 */
export function RubricBar({
  categories,
  height = 10,
  showLabels = false,
}: {
  categories: { key: string; max: number; score?: number | null; label?: string }[];
  height?: number;
  showLabels?: boolean;
}) {
  const total = categories.reduce((s, c) => s + c.max, 0) || 100;
  return (
    <div className="w-full">
      <div className="flex w-full gap-[2px]" style={{ height }} role="img" aria-label={categories.map((c) => `${SEG_LABEL[c.key] ?? c.key} ${c.score ?? '–'}/${c.max}`).join(', ')}>
        {categories.map((c) => {
          const pct = c.score == null ? 0 : Math.max(0, Math.min(1, c.score / c.max));
          return (
            <div
              key={c.key}
              title={`${c.label ?? SEG_LABEL[c.key] ?? c.key}: ${c.score ?? '–'}/${c.max}`}
              className="relative overflow-hidden rounded-[2px] bg-sunken shadow-[inset_0_0_0_1px_var(--c-line-strong)]"
              style={{ width: `${(c.max / total) * 100}%` }}
            >
              <div
                className={clsx('absolute inset-y-0 left-0', pct >= 0.75 ? 'bg-ok' : pct >= 0.5 ? 'bg-accent' : 'bg-err')}
                style={{ width: `${pct * 100}%`, opacity: c.score == null ? 0 : 0.9 }}
              />
            </div>
          );
        })}
      </div>
      {showLabels && (
        <div className="mt-1 flex w-full gap-[2px] text-[10.5px] text-faint">
          {categories.map((c) => (
            <div key={c.key} className="truncate" style={{ width: `${(c.max / total) * 100}%` }}>
              {SEG_LABEL[c.key] ?? c.key}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Modal & confirm ─────────────────────────

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean | 'full';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => [...(el?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])].filter((x) => !x.hasAttribute('disabled'));
    setTimeout(() => (focusables()[0] ?? el)?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (e.stopPropagation(), onClose());
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) (e.preventDefault(), f[f.length - 1].focus());
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) (e.preventDefault(), f[0].focus());
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={clsx(
          'flex max-h-full flex-col rounded-[8px] border border-line-strong bg-panel shadow-2xl',
          wide === 'full' ? 'h-[92vh] w-[96vw]' : wide ? 'w-[min(900px,96vw)]' : 'w-[min(520px,96vw)]',
        )}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 id={titleId} className="text-[15px] font-semibold">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">{footer}</div>}
      </div>
    </div>
  );
}

interface ConfirmOpts {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

interface PromptOpts {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  hint?: string;
}
const PromptCtx = createContext<(o: PromptOpts) => Promise<string | null>>(async () => null);
export const usePrompt = () => useContext(PromptCtx);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [confirm, setConfirm] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [prompt, setPrompt] = useState<(PromptOpts & { resolve: (v: string | null) => void }) | null>(null);
  const [value, setValue] = useState('');
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirm({ ...o, resolve })), []);
  const askText = useCallback(
    (o: PromptOpts) =>
      new Promise<string | null>((resolve) => {
        setValue(o.initial ?? '');
        setPrompt({ ...o, resolve });
      }),
    [],
  );
  const closeConfirm = (v: boolean) => {
    confirm?.resolve(v);
    setConfirm(null);
  };
  const closePrompt = (v: string | null) => {
    prompt?.resolve(v);
    setPrompt(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      <PromptCtx.Provider value={askText}>
        {children}
        <Modal
          open={!!confirm}
          title={confirm?.title ?? ''}
          onClose={() => closeConfirm(false)}
          footer={
            <>
              <Button onClick={() => closeConfirm(false)}>Cancel</Button>
              <Button variant={confirm?.danger ? 'danger' : 'primary'} onClick={() => closeConfirm(true)}>
                {confirm?.confirmLabel}
              </Button>
            </>
          }
        >
          <div className="text-[13.5px] text-muted">{confirm?.body}</div>
        </Modal>
        <Modal
          open={!!prompt}
          title={prompt?.title ?? ''}
          onClose={() => closePrompt(null)}
          footer={
            <>
              <Button onClick={() => closePrompt(null)}>Cancel</Button>
              <Button variant="primary" form="prompt-form" type="submit" disabled={!value.trim()}>
                {prompt?.confirmLabel}
              </Button>
            </>
          }
        >
          <form
            id="prompt-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) closePrompt(value.trim());
            }}
          >
            <Field label={prompt?.label ?? ''} hint={prompt?.hint} htmlFor="prompt-input">
              <input id="prompt-input" className={clsx(inputClass, 'font-mono')} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          </form>
        </Modal>
      </PromptCtx.Provider>
    </ConfirmCtx.Provider>
  );
}

// ───────────────────────── Toasts ─────────────────────────

interface Toast {
  id: number;
  tone: 'ok' | 'err' | 'info';
  text: string;
}
const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'err' ? 9000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(420px,90vw)] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'err' ? 'alert' : 'status'}
            className={clsx(
              'pointer-events-auto flex items-start gap-2 rounded-[6px] border bg-raised px-3 py-2 text-[13px] shadow-lg',
              t.tone === 'err' ? 'border-err/50 text-err' : t.tone === 'ok' ? 'border-ok/50 text-ink' : 'border-line-strong text-ink',
            )}
          >
            <span className="flex-1">{t.text}</span>
            <button className="text-muted hover:text-ink" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

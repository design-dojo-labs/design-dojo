import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import clsx from 'clsx';
import type { ProviderStatus } from '@lld/shared';
import { useJava, useProviders, useSettings } from '../lib/queries';
import { useEventsConnected } from '../lib/events';
import { registerNotificationSink, useNotificationPermission } from '../lib/notify';
import { useToast } from './ui';
import { APP_NAME } from '../lib/brand';

/** Announces finished AI jobs (toast, chime, browser notification) while mounted. */
function useJobNotifications(): void {
  const toast = useToast();
  const navigate = useNavigate();
  const prefs = useSettings().data?.notifications;
  const desktop = prefs?.desktop ?? true;
  const sound = prefs?.sound ?? true;
  useEffect(() => registerNotificationSink({ toast, navigate: (to) => void navigate(to), settings: { desktop, sound } }), [toast, navigate, desktop, sound]);
}

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight text-ink">
      <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
        <rect x="5" y="6" width="11" height="8" rx="1" fill="none" stroke="var(--c-accent)" strokeWidth="2.2" />
        <rect x="16" y="18" width="11" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path d="M10.5 14v8H16" fill="none" stroke="currentColor" strokeWidth="2.2" />
      </svg>
      <span>{APP_NAME}</span>
    </Link>
  );
}

const PROVIDER_STATE_TEXT: Record<ProviderStatus['state'], string> = {
  'not-installed': 'not installed',
  installed: 'unverified',
  authenticated: 'ready',
  'auth-blocked': 'blocked',
  unauthenticated: 'not logged in',
  error: 'error',
  mock: 'mock',
};

const DISMISS_KEY = 'lld.notify.prompt-dismissed';

/** Offers to turn on browser notifications for finished reviews (only while permission was never asked). */
function NotificationPrompt() {
  const settings = useSettings().data;
  const [perm, request] = useNotificationPermission();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed || perm !== 'default' || !settings?.notifications.desktop) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
  };
  return (
    <span className="inline-flex items-center rounded-[4px] border border-line bg-panel text-muted">
      <button className="px-2 py-0.5 hover:text-ink" onClick={() => void request()} title="Get a browser notification when a review or other AI job finishes while this tab is in the background">
        Enable notifications
      </button>
      <button className="border-l border-line px-1.5 py-0.5 hover:text-ink" onClick={dismiss} aria-label="Dismiss notification prompt" title="Don't ask again">
        ×
      </button>
    </span>
  );
}

export function StatusChips() {
  // Every page renders the status chips, so this is where finished-job announcements are mounted.
  useJobNotifications();
  const settings = useSettings();
  const providers = useProviders();
  const java = useJava();
  const connected = useEventsConnected();
  const sel = settings.data?.provider;
  const p = providers.data?.find((x) => x.id === sel);
  const provTone = !sel || sel === 'none' ? 'muted' : p?.state === 'authenticated' ? 'ok' : p?.state === 'installed' || p?.state === 'mock' ? 'warn' : 'err';
  const javaTone = !java.data ? 'muted' : java.data.ok && java.data.maven.dependenciesCached ? 'ok' : java.data.ok ? 'warn' : 'err';
  return (
    <div className="flex items-center gap-1.5 text-[12px]">
      {!connected && <Chip tone="err" text="Reconnecting to server…" />}
      <NotificationPrompt />
      <Link to="/settings" className="rounded-[4px] focus-visible:outline-2">
        <Chip
          tone={provTone}
          text={!sel || sel === 'none' ? 'AI: none selected' : `${p?.label ?? sel}: ${p ? PROVIDER_STATE_TEXT[p.state] : '…'}${p?.authMode === 'api-key' ? ' (API key)' : ''}`}
          title={p?.detail}
        />
      </Link>
      <Link to="/settings#java" className="rounded-[4px]">
        <Chip
          tone={javaTone}
          text={!java.data ? 'Java: checking…' : java.data.ok ? `Java ${java.data.javaMajor}${java.data.maven.dependenciesCached ? '' : ', Maven not prepared'}` : 'Java: not ready'}
          title={java.data?.detail}
        />
      </Link>
    </div>
  );
}

function Chip({ tone, text, title }: { tone: 'ok' | 'warn' | 'err' | 'muted'; text: string; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1.5 rounded-[4px] border border-line bg-panel px-2 py-0.5 text-muted">
      <span
        aria-hidden
        className={clsx('size-1.5 rounded-full', tone === 'ok' && 'bg-ok', tone === 'warn' && 'bg-accent', tone === 'err' && 'bg-err', tone === 'muted' && 'bg-faint')}
      />
      {text}
    </span>
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-[1280px] items-center gap-6 px-5">
          <Logo />
          <nav className="flex items-center gap-1 text-[13px]" aria-label="Main">
            {[
              ['/', 'Home'],
              ['/lld', 'LLD'],
              ['/hld', 'HLD'],
              ['/settings', 'Settings'],
            ].map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end
                className={({ isActive }) => clsx('rounded-[4px] px-2 py-1', isActive ? 'bg-sunken text-ink' : 'text-muted hover:text-ink')}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <StatusChips />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1280px] px-5 py-6">{children}</main>
    </div>
  );
}

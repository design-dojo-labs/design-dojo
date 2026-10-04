import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import { DialogProvider, ToastProvider } from './components/ui';
import { applyServerEvent, useSettings } from './lib/queries';
import { useServerEvents } from './lib/events';
import { Dashboard } from './pages/Dashboard';
import { Home } from './pages/Home';
import { HldDashboard } from './hld/HldDashboard';
import { HldProblemPage } from './hld/HldProblemPage';
import { HldWorkspace } from './hld/HldWorkspace';
import { applyHldEvent } from './hld/queries';
import { ProblemPage } from './pages/ProblemPage';
import { SettingsPage } from './pages/SettingsPage';
import { WorkspacePage } from './workspace/WorkspacePage';
import { NotFound } from './pages/NotFound';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

// Excalidraw fetches its fonts from here (served locally) instead of a public CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/';

// Apply the last-used theme before first paint to avoid a flash.
try {
  const t = localStorage.getItem('lld.theme');
  document.documentElement.classList.toggle('dark', t !== 'light');
} catch {
  document.documentElement.classList.add('dark');
}

function Effects() {
  const qc = useQueryClient();
  useServerEvents((ev) => {
    applyServerEvent(qc, ev);
    applyHldEvent(qc, ev);
  });
  const settings = useSettings();
  const theme = settings.data?.editor.theme;
  useEffect(() => {
    if (!theme) return;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('lld.theme', theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  return null;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <DialogProvider>
          <BrowserRouter>
            <Effects />
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/lld" element={<Dashboard />} />
              <Route path="/hld" element={<HldDashboard />} />
              <Route path="/hld/problems/:id" element={<HldProblemPage />} />
              <Route path="/hld/session/:id" element={<HldWorkspace />} />
              <Route path="/problems/:id" element={<ProblemPage />} />
              <Route path="/session/:id" element={<WorkspacePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </DialogProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);

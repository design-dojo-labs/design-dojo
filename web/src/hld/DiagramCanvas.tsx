import { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw, CaptureUpdateAction, convertToExcalidrawElements, hashElementsVersion, newElementWith } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import clsx from 'clsx';
import {
  ChevronDown,
  Cloud,
  Database,
  Globe,
  Grid3x3,
  HardDrive,
  Layers,
  LayoutTemplate,
  ListOrdered,
  Magnet,
  MonitorSmartphone,
  Network,
  Search,
  Server,
  Shield,
  Split,
  WandSparkles,
  Workflow,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { boundsOf, overlaps, tidyLayout, type LayoutElement } from './autoLayout';
import { KIND_STYLE, TEMPLATES, templateSize, templateSkeletons, type ComponentKind, type DiagramTemplate, type ShapeType } from './templates';

interface Preset {
  kind: ComponentKind;
  label: string;
  shape: ShapeType;
  bg: string;
  icon: ReactNode;
  dashed?: boolean;
}

const PRESET_META: { kind: ComponentKind; label: string; icon: ReactNode }[] = [
  { kind: 'client', label: 'Client', icon: <MonitorSmartphone className="size-3.5" /> },
  { kind: 'cdn', label: 'CDN', icon: <Globe className="size-3.5" /> },
  { kind: 'dns', label: 'DNS', icon: <Cloud className="size-3.5" /> },
  { kind: 'load-balancer', label: 'Load balancer', icon: <Split className="size-3.5" /> },
  { kind: 'api-gateway', label: 'API gateway', icon: <Shield className="size-3.5" /> },
  { kind: 'service', label: 'Service', icon: <Server className="size-3.5" /> },
  { kind: 'worker', label: 'Worker', icon: <Workflow className="size-3.5" /> },
  { kind: 'database', label: 'Database', icon: <Database className="size-3.5" /> },
  { kind: 'cache', label: 'Cache', icon: <Zap className="size-3.5" /> },
  { kind: 'queue', label: 'Queue / stream', icon: <ListOrdered className="size-3.5" /> },
  { kind: 'object-storage', label: 'Object storage', icon: <HardDrive className="size-3.5" /> },
  { kind: 'search-index', label: 'Search index', icon: <Search className="size-3.5" /> },
  { kind: 'external', label: 'External service', icon: <Network className="size-3.5" /> },
  { kind: 'region', label: 'Region / zone', icon: <Layers className="size-3.5" /> },
];

/** One-click system components. Each is a normal Excalidraw shape: recolour, resize, relabel freely. */
const PRESETS: Preset[] = PRESET_META.map((m) => ({ ...m, ...KIND_STYLE[m.kind] }));

const SNAP_KEY = 'lld.hld.canvas.snap';
const GRID_KEY = 'lld.hld.canvas.grid';
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export interface HighlightRequest {
  labels: string[];
  nonce: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export default function DiagramCanvas({
  elements,
  onChange,
  dark,
  readOnly,
  highlight,
  onDirty,
  flushRef,
}: {
  elements: Record<string, unknown>[];
  onChange?: (elements: Record<string, unknown>[]) => void;
  dark: boolean;
  readOnly?: boolean;
  highlight?: HighlightRequest | null;
  /** Called immediately on any edit, before the debounced onChange. */
  onDirty?: () => void;
  /** Receives a function that pushes any debounced edit to onChange right away. */
  flushRef?: { current: (() => void) | null };
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const lastHash = useRef<number | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inserted = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [snap, setSnap] = useState(() => readFlag(SNAP_KEY, true));
  const [grid, setGrid] = useState(() => readFlag(GRID_KEY, false));
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const templatesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!templatesOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !templatesRef.current?.contains(e.target as Node)) setTemplatesOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [templatesOpen]);

  const latestEls = useRef<readonly { isDeleted?: boolean }[] | null>(null);
  const push = useCallback(() => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    const els = latestEls.current;
    latestEls.current = null;
    if (els && onChange) onChange(els.filter((e) => !e.isDeleted).map((e) => ({ ...(e as Record<string, unknown>) })));
  }, [onChange]);

  const handleChange = useCallback(
    (els: readonly { isDeleted?: boolean }[]) => {
      if (readOnly || !onChange) return;
      const h = hashElementsVersion(els as never);
      if (lastHash.current === null) {
        lastHash.current = h; // initial load is not an edit
        return;
      }
      if (h === lastHash.current) return; // selection/scroll changes only
      lastHash.current = h;
      latestEls.current = els;
      onDirty?.();
      // Debounced so dragging doesn't re-render the workspace on every pointer move.
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(push, 250);
    },
    [onChange, onDirty, push, readOnly],
  );

  useEffect(() => {
    if (flushRef) flushRef.current = push;
    return () => {
      push(); // leaving the canvas (stage switch) must not drop the last edit
      if (flushRef) flushRef.current = null;
    };
  }, [push, flushRef]);

  const insert = (p: Preset) => {
    if (!api) return;
    const st = api.getAppState();
    const zoom = st.zoom.value;
    // Lay new components out on a grid inside the visible area so they never stack on each other.
    const left = -st.scrollX + 240 / zoom; // clear of the property panel that opens on the left
    const top = -st.scrollY + 110 / zoom;
    const cols = Math.max(1, Math.floor((st.width / zoom - 160) / 220));
    const n = inserted.current++;
    const big = p.kind === 'region';
    const w = big ? 420 : p.shape === 'diamond' ? 170 : 160;
    const h = big ? 280 : p.shape === 'diamond' ? 100 : 72;
    const gx = left + (n % cols) * 220;
    const gy = top + (Math.floor(n / cols) % 4) * 140;
    const created = convertToExcalidrawElements([
      {
        type: p.shape,
        x: gx,
        y: gy,
        width: w,
        height: h,
        backgroundColor: p.bg,
        fillStyle: 'solid',
        strokeStyle: p.dashed ? 'dashed' : 'solid',
        roundness: p.shape === 'rectangle' ? { type: 3 } : null,
        label: big ? undefined : { text: p.label },
        customData: { component: p.kind },
      } as never,
      ...(big ? [{ type: 'text', x: gx + 12, y: gy + 8, text: p.label, fontSize: 16 } as never] : []),
    ]);
    api.updateScene({
      elements: [...api.getSceneElements(), ...created],
      appState: { selectedElementIds: { [created[0].id]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  /** Inserts a pre-wired starter group in free space: in view if possible, else right of the drawing. */
  const insertTemplate = (t: DiagramTemplate) => {
    setTemplatesOpen(false);
    if (!api) return;
    const st = api.getAppState();
    const zoom = st.zoom.value;
    const size = templateSize(t);
    const existing = api.getSceneElements().filter((e) => !e.isDeleted);
    let ox = -st.scrollX + 240 / zoom;
    let oy = -st.scrollY + 110 / zoom;
    const spot = { x: ox, y: oy, ...size };
    if (existing.some((e) => overlaps(spot, e, 40))) {
      const b = boundsOf(existing)!;
      ox = b.x + b.width + 160;
      oy = b.y;
    }
    const created = convertToExcalidrawElements(templateSkeletons(t, ox, oy) as never);
    api.updateScene({
      elements: [...api.getSceneElements(), ...created],
      appState: { selectedElementIds: Object.fromEntries(created.filter((e) => e.type !== 'text').map((e) => [e.id, true])) },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    setNotice(`Added the “${t.name}” template. Rename its components to fit your design.`);
    api.scrollToContent(created, { fitToContent: false, animate: true });
  };

  /** Re-arranges components left to right by their connections; one undo step. */
  const tidy = () => {
    if (!api) return;
    const scene = api.getSceneElements();
    const updates = tidyLayout(scene as unknown as LayoutElement[]);
    if (!updates.size) {
      setNotice('Nothing to arrange: add at least two components.');
      return;
    }
    api.updateScene({
      elements: scene.map((e) => {
        const u = updates.get(e.id);
        return u ? newElementWith(e, u as never) : e;
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    setNotice('Arranged left to right by connections. Undo with Cmd/Ctrl+Z.');
    api.scrollToContent(undefined, { fitToContent: true, animate: true });
  };

  const toggleSnap = () =>
    setSnap((v) => {
      writeFlag(SNAP_KEY, !v);
      return !v;
    });
  const toggleGrid = () =>
    setGrid((v) => {
      writeFlag(GRID_KEY, !v);
      return !v;
    });

  // Select and scroll to the components a review finding refers to.
  useEffect(() => {
    if (!api || !highlight) return;
    const wanted = highlight.labels.map(norm).filter(Boolean);
    const all = api.getSceneElements();
    const texts = all.filter((e) => e.type === 'text') as unknown as { containerId: string | null; text: string }[];
    const matches = all.filter((e) => {
      if (!['rectangle', 'ellipse', 'diamond'].includes(e.type)) return false;
      const label = norm(texts.find((t) => t.containerId === e.id)?.text ?? '');
      return label && wanted.some((w) => label === w || label.includes(w) || w.includes(label));
    });
    if (!matches.length) {
      setNotice(`No component labelled “${highlight.labels.join('”, “')}” on the canvas.`);
      return;
    }
    setNotice(null);
    api.updateScene({ appState: { selectedElementIds: Object.fromEntries(matches.map((m) => [m.id, true])) }, captureUpdate: CaptureUpdateAction.NEVER });
    api.scrollToContent(matches, { fitToContent: false, animate: true });
  }, [api, highlight]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!readOnly && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-canvas px-2 py-1.5" aria-label="Add a system component">
          <span className="mr-1 text-[12px] text-muted">Add:</span>
          {PRESETS.map((p) => (
            <button
              key={p.kind}
              onClick={() => insert(p)}
              title={`Add ${p.label} (then double-click it to rename)`}
              className="inline-flex items-center gap-1 rounded-[4px] border border-line bg-panel px-1.5 py-0.5 text-[12px] hover:border-line-strong"
            >
              <span className="inline-block size-2.5 rounded-[2px] border border-line-strong" style={{ background: p.bg === 'transparent' ? 'none' : p.bg }} />
              {p.icon}
              {p.label}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-1" title="Use the toolbar for arrows, text and colours. Draw arrows from shape to shape so they attach.">
            <div className="relative" ref={templatesRef}>
              <button
                onClick={() => setTemplatesOpen((v) => !v)}
                aria-expanded={templatesOpen}
                aria-haspopup="menu"
                className="inline-flex items-center gap-1 rounded-[4px] border border-line bg-panel px-1.5 py-0.5 text-[12px] hover:border-line-strong"
              >
                <LayoutTemplate className="size-3.5" /> Templates <ChevronDown className="size-3" />
              </button>
              {templatesOpen && (
                <div role="menu" className="absolute right-0 z-20 mt-1 w-[300px] rounded-[6px] border border-line bg-panel p-1 shadow-lg">
                  {TEMPLATES.map((t) => (
                    <button key={t.id} role="menuitem" onClick={() => insertTemplate(t)} className="block w-full rounded-[4px] px-2 py-1.5 text-left hover:bg-sunken">
                      <span className="block text-[12.5px] font-medium">{t.name}</span>
                      <span className="block text-[11.5px] text-muted">{t.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={tidy}
              title="Arrange components left to right by their arrows (undo with Cmd/Ctrl+Z)"
              className="inline-flex items-center gap-1 rounded-[4px] border border-line bg-panel px-1.5 py-0.5 text-[12px] hover:border-line-strong"
            >
              <WandSparkles className="size-3.5" /> Tidy layout
            </button>
            <button
              onClick={toggleSnap}
              aria-pressed={snap}
              title="Snap shapes to other shapes' edges and centres while moving"
              className={clsx('inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[12px]', snap ? 'border-line-strong bg-select text-ink' : 'border-line bg-panel text-muted hover:border-line-strong')}
            >
              <Magnet className="size-3.5" /> Snap
            </button>
            <button
              onClick={toggleGrid}
              aria-pressed={grid}
              title="Show a grid and snap to it"
              className={clsx('inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[12px]', grid ? 'border-line-strong bg-select text-ink' : 'border-line bg-panel text-muted hover:border-line-strong')}
            >
              <Grid3x3 className="size-3.5" /> Grid
            </button>
          </span>
        </div>
      )}
      {notice && <div className="shrink-0 border-b border-line bg-accent-soft px-3 py-1 text-[12px]">{notice}</div>}
      <div className="relative min-h-0 flex-1" data-testid="diagram-canvas">
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={{ elements: elements as never, appState: { viewBackgroundColor: '#ffffff', currentItemFontFamily: 1 } /* the dark theme renders white as dark */, scrollToContent: true }}
          onChange={handleChange as never}
          theme={dark ? 'dark' : 'light'}
          viewModeEnabled={!!readOnly}
          objectsSnapModeEnabled={!readOnly && snap}
          gridModeEnabled={!readOnly && grid}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false, changeViewBackgroundColor: true, clearCanvas: true, saveAsImage: true }, tools: { image: false } }}
        />
      </div>
    </div>
  );
}

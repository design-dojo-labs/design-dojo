import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';

/** Imperative handle + collapsed state for a collapsible <Panel>; spread `panelProps` onto the Panel. */
export function usePanelToggle() {
  const ref = useRef<ImperativePanelHandle>(null);
  const [collapsed, setCollapsed] = useState(false);
  // Layouts are restored from autoSaveId after mount, so read the real state once it has settled.
  useEffect(() => {
    const t = setTimeout(() => setCollapsed(ref.current?.isCollapsed() ?? false), 0);
    return () => clearTimeout(t);
  }, []);
  return {
    collapsed,
    panelProps: { ref, onCollapse: () => setCollapsed(true), onExpand: () => setCollapsed(false) },
    toggle: () => (ref.current?.isCollapsed() ? ref.current.expand() : ref.current?.collapse()),
  };
}

/**
 * A resize handle with a small arrow that collapses or expands one neighbouring panel.
 * `side` says which neighbour the arrow controls: 'before' = the panel left of (or above) the handle.
 */
export function ToggleResizeHandle({
  direction = 'horizontal',
  side,
  collapsed,
  onToggle,
  label,
}: {
  direction?: 'horizontal' | 'vertical';
  side: 'before' | 'after';
  collapsed: boolean;
  onToggle: () => void;
  label: string;
}) {
  const horizontal = direction === 'horizontal';
  // The arrow points the way the divider will move: towards the panel to hide it, away to show it.
  const towardsPanel = horizontal ? (side === 'before' ? ChevronLeft : ChevronRight) : side === 'before' ? ChevronUp : ChevronDown;
  const awayFromPanel = horizontal ? (side === 'before' ? ChevronRight : ChevronLeft) : side === 'before' ? ChevronDown : ChevronUp;
  const Icon = collapsed ? awayFromPanel : towardsPanel;
  return (
    <PanelResizeHandle className={clsx('relative z-10', horizontal ? 'w-px' : 'h-px')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Show' : 'Hide'} ${label}`}
        title={`${collapsed ? 'Show' : 'Hide'} ${label}`}
        data-testid={`toggle-${label.replace(/\W+/g, '-').toLowerCase()}`}
        className={clsx(
          'absolute flex items-center justify-center rounded-[4px] border border-line bg-panel text-muted shadow-sm hover:border-line-strong hover:text-ink',
          horizontal ? 'top-1/2 h-7 w-3.5 -translate-y-1/2' : 'left-1/2 h-3.5 w-7 -translate-x-1/2',
          // Centred on the divider; once the panel is collapsed the divider sits at the edge, so keep the
          // whole arrow on the visible side.
          !collapsed
            ? horizontal
              ? 'left-1/2 -translate-x-1/2'
              : 'top-1/2 -translate-y-1/2'
            : horizontal
              ? side === 'before'
                ? 'left-0'
                : 'right-0'
              : side === 'before'
                ? 'top-0'
                : 'bottom-0',
        )}
      >
        <Icon className="size-3" aria-hidden />
      </button>
    </PanelResizeHandle>
  );
}

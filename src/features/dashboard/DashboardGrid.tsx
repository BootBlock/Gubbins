/**
 * DashboardGrid — the customisable §3 widget board.
 *
 * Renders the registered widgets at their persisted `(x, y)` grid coordinates, and in
 * "Customise" (edit) mode lets the user **drag** a tile to any cell (native HTML5
 * drag-and-drop — no dependency, §2.4.3), **nudge** it with the arrow keys (an
 * accessible, keyboard-only path mirroring the APG-tree seam), and **show/hide**
 * widgets. All coordinate maths lives in the pure `dashboard-layout.ts` seam; this
 * component is the thin DOM glue, and `useLayoutStore` persists the result to
 * localStorage (device-local — no schema migration). Drag is a desktop/tablet
 * affordance: below `sm` the board collapses to a single-column flow in row-major
 * order, so the coordinate placement only engages on wider screens.
 */
import { useMemo, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import {
  buttonVariants,
  revealStaggerMs,
  Surface,
  Tooltip,
  useReducedMotion,
  useRevealOnScroll,
} from '@/components/foundry';
import { DragHandleIcon, HideIcon, ShowIcon, ResetIcon } from '@/components/icons';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useDashboardCustomise } from './useDashboardCustomise';
import { useReorderFlip } from './useReorderFlip';
import { useBoardPointerDrag, type DragSourceProps, type DropTargetProps } from './useBoardPointerDrag';
import { BoardMoveButtons, type MoveDir } from './BoardMoveButtons';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import { featureForRoute } from '@/features/modules/feature-registry';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { useT } from '@/features/i18n';
import {
  DASHBOARD_COLUMNS,
  hideHealthyCards,
  moveWidget,
  nudgeWidget,
  occupantAt,
  placedWidgets,
  reconcileLayout,
  setWidgetVisible,
  type DashboardLayout,
  type NudgeDirection,
  type WidgetPlacement,
} from './dashboard-layout';
import { DASHBOARD_WIDGET_IDS, useHealthyWidgetIds, widgetById, type WidgetDefinition } from './widgets';

const ARROW_DIRECTIONS: Record<string, NudgeDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/** CSS-variable grid placement: 1-based lines, only applied at `sm` and up. */
function cellStyle(x: number, y: number): CSSProperties {
  return { ['--gx']: String(x + 1), ['--gy']: String(y + 1) } as CSSProperties;
}

const PLACEMENT = 'sm:[grid-column:var(--gx)] sm:[grid-row:var(--gy)]';

/** Drop-target key for grid cell `(x, y)`. */
function cellKey(x: number, y: number): string {
  return `cell:${x},${y}`;
}

/** Decode a `cell:<x>,<y>` drop key back into coordinates, or null for any other/absent key. */
function parseCellKey(key: string | null): { x: number; y: number } | null {
  if (!key || !key.startsWith('cell:')) return null;
  const parts = key.slice(5).split(',');
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  return Number.isNaN(x) || Number.isNaN(y) ? null : { x, y };
}

/** A shared frozen empty set for the common "nothing hidden" path (no per-render allocation). */
const NO_HEALTHY: ReadonlySet<string> = new Set();

/**
 * The widget board. Thin wrapper over {@link DashboardBoard}: when "hide healthy cards"
 * (issue #111) is on it mounts a probe that reports which alert cards are currently all-clear,
 * and hands that set down; otherwise the board renders the full layout with nothing to probe.
 */
export function DashboardGrid() {
  const hideHealthy = usePreferencesStore((s) => s.hideHealthyDashboardCards);
  return hideHealthy ? (
    <HideHealthyGate>{(healthy) => <DashboardBoard healthy={healthy} />}</HideHealthyGate>
  ) : (
    <DashboardBoard healthy={NO_HEALTHY} />
  );
}

/**
 * Runs the alert-widget "all clear" probe (only mounted while "hide healthy cards" is on, so
 * the default board never pays for it) and hands the set of clear widget ids to the board.
 */
function HideHealthyGate({ children }: { children: (healthy: ReadonlySet<string>) => ReactNode }) {
  const healthy = useHealthyWidgetIds();
  return <>{children(healthy)}</>;
}

function DashboardBoard({ healthy }: { healthy: ReadonlySet<string> }) {
  const t = useT();
  const stored = useLayoutStore((s) => s.dashboardLayout);
  const setLayout = useLayoutStore((s) => s.setDashboardLayout);
  // Edit mode is the hub's single, shared "Customise" state (toggled by the one button up in
  // DashboardNav) — the widget board no longer has its own Customise button.
  const editing = useDashboardCustomise((s) => s.editing);
  // Drop the ghost's decorative motion at source for reduced-motion users (mirrors the
  // Foundry Modal/Tooltip seam) — they still get a static dashed highlight of the target.
  const reduced = useReducedMotion();

  // Which Modular UI features are on (modular-ui-plan §4). Drives both what appears on the
  // board and whether a surviving widget's quick-link stays live.
  const enabled = useEnabledFeatures();

  // Reconcile the persisted layout against the live registry every render so the board
  // survives the widget set changing across releases (new widgets appear, removed ones
  // drop). The reconciled layout is what we render and what edits mutate.
  const fullLayout = useMemo(() => reconcileLayout(stored, DASHBOARD_WIDGET_IDS), [stored]);

  // Gate on top of the stored layout: a widget whose feature is off is split out into
  // `gated` and never rendered, while `layout` (its enabled complement) is what the board
  // draws and what every edit operates on. The gated placements are kept verbatim and
  // concatenated back on each persist (`apply`), so a hidden module's widgets keep their
  // exact coordinates — turning the module back on restores the prior layout untouched.
  const { layout, gated } = useMemo(() => {
    const onBoard: WidgetPlacement[] = [];
    const gatedOut: WidgetPlacement[] = [];
    for (const p of fullLayout) {
      const feature = widgetById(p.id)?.feature;
      (!feature || enabled.has(feature) ? onBoard : gatedOut).push(p);
    }
    return { layout: onBoard as DashboardLayout, gated: gatedOut as DashboardLayout };
  }, [fullLayout, enabled]);

  // "Hide healthy cards" (issue #111) only bites in view mode — while customising, every card
  // stays on the board so it can be arranged, so the healthy set is ignored then. The reflow
  // repacks the surviving cards gaplessly; the persisted `layout` (and every edit below) is
  // untouched, so a temporarily-hidden card keeps its real coordinates.
  const renderLayout = hideHealthyCards(layout, editing ? NO_HEALTHY : healthy);
  const placed = placedWidgets(renderLayout);
  const hidden = layout.filter((p) => !p.visible);

  // Glide each widget to its new cell when the board is rearranged (FLIP), on the signature
  // easing. Keyed on the placed widgets' coordinates, so a drag/arrow-key move or a show/hide
  // reflow plays; gated on edit mode and reduced-motion (reduced-motion gets the instant jump).
  const orderKey = placed.map((p) => `${p.id}:${p.x},${p.y}`).join('|');
  const registerTile = useReorderFlip(orderKey, editing && !reduced);

  const apply = (next: DashboardLayout) => {
    // Pure ops return the same reference on a no-op; only persist a real change. The
    // gated placements are merged back untouched so their coords are never rewritten.
    if (next !== layout) setLayout([...next, ...gated]);
  };

  // Pointer drag-to-move (mouse / pen / touch, replacing the touch-blind HTML5 drag). Dropping a
  // widget onto a cell key moves it there (swapping any occupant); the arrow keys and the on-tile
  // move buttons are the touch-free equivalents. Enabled only while customising.
  const drag = useBoardPointerDrag({
    boardId: 'grid',
    enabled: editing,
    onDrop: (id, key) => {
      const cell = parseCellKey(key);
      if (cell) apply(moveWidget(layout, id, cell.x, cell.y));
    },
  });
  // The cell under the pointer during a drag, decoded from the active drop key — drives the ghost.
  const overCell = parseCellKey(drag.overKey);

  // Where the dragged widget would land: the hovered cell, unless it's the tile's own
  // current cell (a no-op move — no point flagging it). An occupied target swaps, so the
  // ghost still correctly marks "your widget goes here".
  const dragging = drag.draggingId ? layout.find((p) => p.id === drag.draggingId) : undefined;
  const ghost =
    editing && dragging && overCell && !(dragging.x === overCell.x && dragging.y === overCell.y)
      ? overCell
      : null;

  // The widget (if any) sitting under the drop ghost. Its solid edit-mode ring is
  // suppressed while targeted so the drop indicator reads as the dashed ghost alone,
  // not a solid outline doubled up with a dashed inner line.
  const ghostTargetId = ghost ? (occupantAt(layout, ghost.x, ghost.y)?.id ?? null) : null;

  const handleKeyDown = (id: string) => (e: KeyboardEvent) => {
    const dir = ARROW_DIRECTIONS[e.key];
    if (!dir) return;
    e.preventDefault();
    apply(nudgeWidget(layout, id, dir));
  };

  // Empty drop cells fill the gaps (edit mode only) so a tile can be dragged onto a
  // free coordinate, plus one spare trailing row for "move down" room.
  const dropCells: { x: number; y: number }[] = [];
  if (editing) {
    const maxRow = placed.reduce((m, p) => Math.max(m, p.y), 0);
    for (let y = 0; y <= maxRow + 1; y++) {
      for (let x = 0; x < DASHBOARD_COLUMNS; x++) {
        if (!occupantAt(layout, x, y)) dropCells.push({ x, y });
      }
    }
  }

  return (
    <section className="mt-8" aria-labelledby="dashboard-widgets-heading">
      {/* No Customise toggle here: the single button up in DashboardNav drives this board's
          edit mode too (shared `useDashboardCustomise`). Only the widget-specific Reset lives
          here, shown while customising. */}
      <div className="mb-3 flex items-center gap-3">
        <h2 id="dashboard-widgets-heading" className="text-sm font-semibold text-muted-foreground">
          {t('dashboard.grid.heading')}
        </h2>
        {editing ? (
          // Reset to defaults: an empty stored layout reconciles to the row-major
          // default with every widget visible (see reconcileLayout / defaultLayout).
          <Tooltip content={t('dashboard.grid.resetTooltip')} triggerTabIndex={-1} className="ml-auto">
            <button
              type="button"
              onClick={() => setLayout([])}
              data-testid="reset-dashboard"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            >
              <ResetIcon />
              {t('dashboard.grid.resetWidgets')}
            </button>
          </Tooltip>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:auto-rows-min sm:grid-cols-3">
        {placed.map((p, i) => {
          const def = widgetById(p.id);
          if (!def) return null;
          // Resolve the quick-link through the enabled set: a surviving widget whose `to`
          // targets a now-hidden route drops its link rather than navigate into a hidden
          // module (modular-ui-plan §4). An ungated route (or no `to`) stays live.
          const linkFeature = def.to ? featureForRoute(def.to) : undefined;
          const linkActive = !linkFeature || enabled.has(linkFeature);
          return (
            <WidgetTile
              key={p.id}
              def={def}
              x={p.x}
              y={p.y}
              index={i}
              editing={editing}
              linkActive={linkActive}
              isDropTarget={p.id === ghostTargetId}
              isDragging={drag.draggingId === p.id}
              nodeRef={registerTile(p.id)}
              dragSourceProps={drag.sourceProps(p.id, t(def.titleKey))}
              dropProps={drag.dropProps(cellKey(p.x, p.y))}
              onMove={(dir) => apply(nudgeWidget(layout, p.id, dir))}
              moveDisabled={{
                up: nudgeWidget(layout, p.id, 'up') === layout,
                down: nudgeWidget(layout, p.id, 'down') === layout,
                left: nudgeWidget(layout, p.id, 'left') === layout,
                right: nudgeWidget(layout, p.id, 'right') === layout,
              }}
              onKeyDown={handleKeyDown(p.id)}
              onHide={() => apply(setWidgetVisible(layout, p.id, false))}
            />
          );
        })}

        {dropCells.map(({ x, y }) => (
          <div
            key={`cell-${x}-${y}`}
            style={cellStyle(x, y)}
            {...drag.dropProps(cellKey(x, y))}
            data-testid="dashboard-drop-cell"
            aria-hidden
            className={cn(
              PLACEMENT,
              'hidden min-h-24 rounded-2xl border-2 border-dashed border-border/60 sm:block',
            )}
          />
        ))}

        {/* Live drop ghost: a single placeholder overlapping the hovered cell (grid items
            may share a cell, so it stacks over whatever is there). Keyed by coordinate so
            it re-pops via `animate-zoom-in` each time it jumps cells, while the inner
            layer breathes with `animate-ghost`. Pointer-events-none so it never steals the
            drag's `dragover`/`drop` from the tile or drop cell beneath it. */}
        {ghost ? (
          <div
            key={`ghost-${ghost.x}-${ghost.y}`}
            style={cellStyle(ghost.x, ghost.y)}
            data-testid="dashboard-drop-ghost"
            aria-hidden
            className={cn(
              PLACEMENT,
              'pointer-events-none z-10 hidden self-stretch sm:block',
              !reduced && 'animate-zoom-in',
            )}
          >
            <div
              className={cn(
                'size-full rounded-2xl border-2 border-dashed border-primary/60 bg-primary/10',
                !reduced && 'animate-ghost',
              )}
            />
          </div>
        ) : null}
      </div>

      {/* The floating drag preview that follows the pointer (mouse / pen / touch). */}
      {drag.preview}

      {editing && hidden.length > 0 ? (
        <div className="mt-4" data-testid="hidden-widgets">
          <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
            {t('dashboard.grid.hiddenWidgets')}
          </h3>
          <div className="flex flex-wrap gap-2">
            {hidden.map((p) => {
              const def = widgetById(p.id);
              if (!def) return null;
              return (
                <Tooltip
                  key={p.id}
                  content={t('dashboard.grid.addBack', { vars: { title: t(def.titleKey) } })}
                  triggerTabIndex={-1}
                >
                  <button
                    type="button"
                    onClick={() => apply(setWidgetVisible(layout, p.id, true))}
                    data-testid={`widget-add-${p.id}`}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                  >
                    <ShowIcon />
                    {t(def.titleKey)}
                  </button>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function WidgetTile({
  def,
  x,
  y,
  index,
  editing,
  linkActive,
  isDropTarget,
  isDragging,
  nodeRef,
  dragSourceProps,
  dropProps,
  onMove,
  moveDisabled,
  onKeyDown,
  onHide,
}: {
  def: WidgetDefinition;
  x: number;
  y: number;
  index: number;
  editing: boolean;
  /** Whether this tile's `to` link is live (its target route's feature is enabled). */
  linkActive: boolean;
  isDropTarget: boolean;
  /** Whether this tile is the one currently being dragged (dims it under the floating preview). */
  isDragging: boolean;
  /** FLIP ref: the outermost (grid-placed) element, so it can glide to its new cell. */
  nodeRef: (el: HTMLElement | null) => void;
  /** Pointer-drag source props (begins a drag of this widget, previewing its title). */
  dragSourceProps: DragSourceProps;
  /** Pointer-drag drop-target props (registers this tile's cell as a drop target). */
  dropProps: DropTargetProps;
  /** Nudge this widget one cell (the touch/click move buttons, mirroring the arrow keys). */
  onMove: (dir: MoveDir) => void;
  /** Which move directions are at an edge (a no-op) and should render disabled. */
  moveDisabled: Record<MoveDir, boolean>;
  onKeyDown: (e: KeyboardEvent) => void;
  onHide: () => void;
}) {
  const t = useT();
  const Body = def.Component;
  const openSettings = useSettingsDialog((s) => s.openSettings);
  // Scroll-reveal (F3): rather than rising on mount, each tile holds invisible until it
  // scrolls into view, then rises in once via the shared `animate-rise` entrance. The hook
  // runs unconditionally (before the edit-mode branch) so it never violates the rules of
  // hooks; the reveal classes are only applied to the non-editing card below (a tile being
  // arranged must stay fully visible). Under reduced motion / no IntersectionObserver the
  // hook reports `armed: false` and the card renders visible from first paint.
  const reduced = useReducedMotion();
  const { ref: revealRef, revealed, armed } = useRevealOnScroll({ reduced });
  // Cascade the entrance: each tile rises in a beat after the previous one, capped so a busy
  // board never feels sluggish. Only meaningful while the tile is rising.
  const riseDelay =
    armed && revealed && index > 0
      ? ({ animationDelay: `${revealStaggerMs(index)}ms` } as CSSProperties)
      : undefined;

  if (editing) {
    const title = t(def.titleKey);
    return (
      <Surface
        ref={nodeRef}
        {...dragSourceProps}
        {...dropProps}
        data-testid={`widget-${def.id}`}
        style={cellStyle(x, y)}
        tabIndex={0}
        role="group"
        aria-label={t('dashboard.grid.tileAria', { vars: { title } })}
        onKeyDown={onKeyDown}
        className={cn(
          PLACEMENT,
          'cursor-grab p-4 transition-shadow focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing',
          // The dragged source dims so the floating preview reads as the thing in flight
          // (the pointer path has no native drag-image).
          isDragging && 'opacity-50',
          // The static drag ring, dropped while this tile is the drop target so the
          // dashed ghost overlay isn't doubled with a solid outline.
          !isDropTarget && 'ring-2 ring-primary/40',
        )}
      >
        <div className="mb-2 flex items-center gap-2 text-muted-foreground [&_svg]:size-4">
          <DragHandleIcon aria-hidden />
          <span className="text-[11px] font-medium uppercase tracking-wide">
            {t('dashboard.grid.dragHint')}
          </span>
          <Tooltip content={t('dashboard.grid.removeTooltip')} triggerTabIndex={-1} className="ml-auto">
            <button
              type="button"
              onClick={onHide}
              data-testid={`widget-hide-${def.id}`}
              aria-label={t('dashboard.grid.hideAria', { vars: { title } })}
              className="rounded-md p-1 hover:bg-muted hover:text-foreground [&_svg]:size-4"
            >
              <HideIcon />
            </button>
          </Tooltip>
        </div>
        {/* Disable inner links/hover while arranging the board. */}
        <div className="pointer-events-none">
          <Body />
        </div>
        {/* Touch/click move controls — the drag-free, accessible way to reorder (issue #11).
            Arrow keys do the same for a physical keyboard. */}
        <BoardMoveButtons
          onMove={onMove}
          disabled={moveDisabled}
          labels={{
            up: t('dashboard.grid.moveUp', { vars: { title } }),
            down: t('dashboard.grid.moveDown', { vars: { title } }),
            left: t('dashboard.grid.moveLeft', { vars: { title } }),
            right: t('dashboard.grid.moveRight', { vars: { title } }),
          }}
          testIdPrefix={`widget-move-${def.id}`}
          className="mt-3 justify-center border-t border-border/40 pt-2"
        />
      </Surface>
    );
  }

  const card = (
    <Surface
      ref={revealRef}
      data-testid={`widget-${def.id}`}
      style={riseDelay}
      className={cn(
        'block h-full p-4 transition-all duration-200 ease-emphasized hover:-translate-y-0.5 hover:shadow-primary/10',
        // Held invisible until it scrolls into view, then rise in once (F3). Only applied
        // while armed, so a reduced-motion / observer-less render stays visible throughout.
        armed && !revealed && 'opacity-0',
        armed && revealed && 'animate-rise',
      )}
    >
      <Body />
    </Surface>
  );

  // The grid item is the outermost element — it carries the coordinate placement. A
  // quick-link target makes the whole tile navigable (§3 "quick-links"), unless the
  // target route's module is hidden — then the tile renders as a plain, non-clickable
  // card so it never navigates into a hidden module (modular-ui-plan §4).
  //
  // Settings is a dialog, not a routed screen: its tile opens the dialog directly rather
  // than rendering a `<Link>` — a link would prefetch-open it on hover (`defaultPreload:
  // 'intent'` runs the `/settings` `beforeLoad`, which raises the dialog). This mirrors the
  // same special-case in DashboardNav / AppNav / CommandPalette. See `useSettingsDialog`.
  if (def.to === '/settings' && linkActive) {
    return (
      <button
        ref={nodeRef}
        type="button"
        onClick={() => openSettings(def.settingsTab)}
        style={cellStyle(x, y)}
        className={cn(PLACEMENT, 'block w-full cursor-pointer text-left')}
      >
        {card}
      </button>
    );
  }
  if (def.to && linkActive) {
    return (
      <Link
        ref={nodeRef}
        to={def.to}
        onClick={def.onLinkClick}
        style={cellStyle(x, y)}
        className={cn(PLACEMENT, 'block')}
      >
        {card}
      </Link>
    );
  }
  return (
    <div ref={nodeRef} style={cellStyle(x, y)} className={PLACEMENT}>
      {card}
    </div>
  );
}

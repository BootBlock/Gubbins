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
import { useMemo, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { buttonVariants, Surface, Tooltip, useReducedMotion } from '@/components/foundry';
import { CustomiseIcon, DragHandleIcon, HideIcon, ShowIcon, CheckIcon, ResetIcon } from '@/components/icons';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import {
  DASHBOARD_COLUMNS,
  moveWidget,
  nudgeWidget,
  occupantAt,
  placedWidgets,
  reconcileLayout,
  setWidgetVisible,
  type DashboardLayout,
  type NudgeDirection,
} from './dashboard-layout';
import { DASHBOARD_WIDGET_IDS, widgetById, type WidgetDefinition } from './widgets';

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

export function DashboardGrid() {
  const stored = useLayoutStore((s) => s.dashboardLayout);
  const setLayout = useLayoutStore((s) => s.setDashboardLayout);
  const [editing, setEditing] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Drop the ghost's decorative motion at source for reduced-motion users (mirrors the
  // Foundry Modal/Tooltip seam) — they still get a static dashed highlight of the target.
  const reduced = useReducedMotion();
  // The cell currently under the pointer during a drag — drives the drop ghost. Cleared
  // when the drag ends so the indicator only shows while arranging.
  const [overCell, setOverCell] = useState<{ x: number; y: number } | null>(null);

  // Reconcile the persisted layout against the live registry every render so the board
  // survives the widget set changing across releases (new widgets appear, removed ones
  // drop). The reconciled layout is what we render and what edits mutate.
  const layout = useMemo(() => reconcileLayout(stored, DASHBOARD_WIDGET_IDS), [stored]);
  const placed = placedWidgets(layout);
  const hidden = layout.filter((p) => !p.visible);

  const apply = (next: DashboardLayout) => {
    if (next !== layout) setLayout(next);
  };

  const endDrag = () => {
    setDraggingId(null);
    setOverCell(null);
  };

  // Track the hovered cell so the ghost can follow the pointer. Guarded so a repeated
  // `dragover` on the same cell doesn't churn state (the event fires continuously).
  const markOver = (x: number, y: number) => (e: DragEvent) => {
    e.preventDefault();
    setOverCell((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
  };

  const handleDrop = (x: number, y: number) => (e: DragEvent) => {
    e.preventDefault();
    const id = draggingId ?? e.dataTransfer.getData('text/plain');
    endDrag();
    if (id) apply(moveWidget(layout, id, x, y));
  };

  // Where the dragged widget would land: the hovered cell, unless it's the tile's own
  // current cell (a no-op move — no point flagging it). An occupied target swaps, so the
  // ghost still correctly marks "your widget goes here".
  const dragging = draggingId ? layout.find((p) => p.id === draggingId) : undefined;
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
      <div className="mb-3 flex items-center gap-3">
        <h2 id="dashboard-widgets-heading" className="text-sm font-semibold text-muted-foreground">
          Dashboard
        </h2>
        {editing ? (
          // Reset to defaults: an empty stored layout reconciles to the row-major
          // default with every widget visible (see reconcileLayout / defaultLayout).
          <Tooltip
            content="Restore the default widget layout — every widget shown, in the original order."
            triggerTabIndex={-1}
            className="ml-auto"
          >
            <button
              type="button"
              onClick={() => setLayout([])}
              data-testid="reset-dashboard"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            >
              <ResetIcon />
              Reset
            </button>
          </Tooltip>
        ) : null}
        <Tooltip
          content="Rearrange the board: drag or arrow-key tiles to move them, and hide widgets you don't need. Your layout is saved on this device."
          triggerTabIndex={-1}
          className={cn(!editing && 'ml-auto')}
        >
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            data-testid="customise-dashboard"
            aria-pressed={editing}
            className={cn(buttonVariants({ variant: editing ? 'primary' : 'outline', size: 'sm' }))}
          >
            {editing ? <CheckIcon /> : <CustomiseIcon />}
            {editing ? 'Done' : 'Customise'}
          </button>
        </Tooltip>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:auto-rows-min sm:grid-cols-3">
        {placed.map((p, i) => {
          const def = widgetById(p.id);
          if (!def) return null;
          return (
            <WidgetTile
              key={p.id}
              def={def}
              x={p.x}
              y={p.y}
              index={i}
              editing={editing}
              isDropTarget={p.id === ghostTargetId}
              onDragStart={() => setDraggingId(p.id)}
              onDragEnd={endDrag}
              onDragOver={markOver(p.x, p.y)}
              onDrop={handleDrop(p.x, p.y)}
              onKeyDown={handleKeyDown(p.id)}
              onHide={() => apply(setWidgetVisible(layout, p.id, false))}
            />
          );
        })}

        {dropCells.map(({ x, y }) => (
          <div
            key={`cell-${x}-${y}`}
            style={cellStyle(x, y)}
            onDragOver={markOver(x, y)}
            onDrop={handleDrop(x, y)}
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

      {editing && hidden.length > 0 ? (
        <div className="mt-4" data-testid="hidden-widgets">
          <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Hidden widgets</h3>
          <div className="flex flex-wrap gap-2">
            {hidden.map((p) => {
              const def = widgetById(p.id);
              if (!def) return null;
              return (
                <Tooltip
                  key={p.id}
                  content={`Add **${def.title}** back to the board.`}
                  triggerTabIndex={-1}
                >
                  <button
                    type="button"
                    onClick={() => apply(setWidgetVisible(layout, p.id, true))}
                    data-testid={`widget-add-${p.id}`}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                  >
                    <ShowIcon />
                    {def.title}
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
  isDropTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onKeyDown,
  onHide,
}: {
  def: WidgetDefinition;
  x: number;
  y: number;
  index: number;
  editing: boolean;
  isDropTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onHide: () => void;
}) {
  const Body = def.Component;
  // Cascade the entrance: each tile rises in a beat after the previous one. Capped so a
  // busy board never feels sluggish; zeroed for reduced-motion users by the index.css
  // catch-all (animation-delay: 0). `both` fill keeps the tile hidden during its wait.
  const riseDelay = { animationDelay: `${Math.min(index, 8) * 45}ms` } as CSSProperties;

  if (editing) {
    return (
      <Surface
        data-testid={`widget-${def.id}`}
        style={cellStyle(x, y)}
        draggable
        tabIndex={0}
        role="group"
        aria-label={`${def.title} widget. Use the arrow keys to move it.`}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', def.id);
          e.dataTransfer.effectAllowed = 'move';
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onKeyDown={onKeyDown}
        className={cn(
          PLACEMENT,
          'cursor-grab p-4 transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-primary active:cursor-grabbing',
          // The static drag ring, dropped while this tile is the drop target so the
          // dashed ghost overlay isn't doubled with a solid outline.
          !isDropTarget && 'ring-2 ring-primary/40',
        )}
      >
        <div className="mb-2 flex items-center gap-2 text-muted-foreground [&_svg]:size-4">
          <DragHandleIcon aria-hidden />
          <span className="text-[11px] font-medium uppercase tracking-wide">Drag or arrow-key to move</span>
          <Tooltip
            content="Remove this widget from the board. You can add it back from “Hidden widgets” below."
            triggerTabIndex={-1}
            className="ml-auto"
          >
            <button
              type="button"
              onClick={onHide}
              data-testid={`widget-hide-${def.id}`}
              aria-label={`Hide ${def.title}`}
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
      </Surface>
    );
  }

  const card = (
    <Surface
      data-testid={`widget-${def.id}`}
      style={riseDelay}
      className="block h-full animate-rise p-4 transition-all duration-200 ease-emphasized hover:-translate-y-0.5 hover:shadow-primary/10"
    >
      <Body />
    </Surface>
  );

  // The grid item is the outermost element — it carries the coordinate placement. A
  // quick-link target makes the whole tile navigable (§3 "quick-links").
  if (def.to) {
    return (
      <Link to={def.to} hash={def.hash} style={cellStyle(x, y)} className={cn(PLACEMENT, 'block')}>
        {card}
      </Link>
    );
  }
  return (
    <div style={cellStyle(x, y)} className={PLACEMENT}>
      {card}
    </div>
  );
}

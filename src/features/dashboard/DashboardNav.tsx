/**
 * DashboardNav — the landing hub's primary navigation, laid out as grouped tiles.
 *
 * The destinations are arranged as **three side-by-side columns**, one per nav group
 * (`primary` / `manage` / `system`), with each group's cards stacked within its column.
 * The grouping is the same {@link NAV_DESTINATIONS} source of truth the global
 * {@link AppNav} menu reads, so the hub and the menu can never drift. Inventory is the
 * primary call-to-action; the Alerts tile carries the live badge. Each card has a rich
 * Markdown {@link Tooltip} explaining what that destination contains.
 *
 * **Customise (backlog B1).** A "Customise" toggle turns the hub into an edit surface where
 * the user can **drag** a tile (native HTML5 drag-and-drop — no dependency), **arrow-key** it
 * to reorder within a group or move it to an adjacent group, and **pin** a tile so it floats
 * to the top of its group. The arrangement is a per-device layout concern persisted in
 * `useLayoutStore`; all the ordering maths is the pure `dashboard-nav-order.ts` seam, resolved
 * (with Modular UI gating and stale-order reconcile) by {@link useNavOrder}, so this component
 * stays presentation. A hidden tile never appears and can't be ordered.
 */
import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import {
  buttonVariants,
  LiveRegion,
  NAV_OPEN_DELAY_MS,
  Surface,
  Tooltip,
  useReducedMotion,
} from '@/components/foundry';
import { CheckIcon, CustomiseIcon, DragHandleIcon, PinIcon, ResetIcon } from '@/components/icons';
import { type AppRoutePath, type NavGroup } from '@/components/nav/nav-destinations';
import { useAlerts } from '@/features/alerts/useAlerts';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import type { NavCountTone } from '@/features/settings/settings';
import { useNavCounts } from './useNavCounts';
import { useNavOrder, type NavMoveResult } from './useNavOrder';

/** Human-facing heading per nav group (the SSOT keys are terse identifiers). */
const GROUP_LABELS: Record<NavGroup, string> = {
  primary: 'Workspaces',
  manage: 'Manage',
  system: 'System',
};

/**
 * A whisper-faint background wash per group, so the three columns read as distinct
 * regions at a glance. Each is a theme-aware token at extremely low opacity (no colour
 * literals): primary violet for the everyday workspaces, accent cyan for the manage
 * column, and a rose-red hue for the system column. Rose comes from the decorative
 * location palette rather than `destructive`, so it reads as a distinct colour without
 * implying a danger/error state.
 */
const GROUP_TINTS: Record<NavGroup, string> = {
  primary: 'bg-primary/5',
  manage: 'bg-accent/5',
  system: 'bg-loc-rose/[0.06]',
};

/**
 * Translucent, group-coloured background for the cards themselves (the non-CTA tiles),
 * a touch deeper than the panel wash so each tile lifts off its panel while still letting
 * the tint beneath show through. Same theme-aware tokens as {@link GROUP_TINTS}; the
 * Surface's own `backdrop-blur` frosts it for a glassy, tinted look. The Inventory tile is
 * exempt — it keeps its solid primary call-to-action fill.
 */
const GROUP_CARD_TINTS: Record<NavGroup, string> = {
  primary: 'bg-primary/10 hover:bg-primary/15',
  manage: 'bg-accent/10 hover:bg-accent/15',
  system: 'bg-loc-rose/10 hover:bg-loc-rose/15',
};

/**
 * Count-pill colours per group (see {@link useNavCounts}) — the group's own hue as text on a
 * soft same-hue wash, so the number reads as a distinct, quick-to-scan accent against the
 * card's title without looking like the destructive Alerts badge. The Inventory tile is the
 * solid-primary CTA, so its pill instead sits on the inverse `primary-foreground` (handled at
 * the call site). Same theme-aware tokens as the card tints, dark-mode-correct for free.
 */
const GROUP_COUNT_BADGE: Record<NavGroup, string> = {
  primary: 'bg-primary/15 text-primary',
  manage: 'bg-accent/15 text-accent',
  system: 'bg-loc-rose/15 text-loc-rose',
};

/** Arrow key → nav move direction (up/down reorder within a group, left/right across groups). */
const ARROW_DIRECTIONS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/**
 * "Problem" count-pill colours (backlog A2). When a tile's chosen metric counts something
 * needing attention ({@link useNavCounts} sets a `warning` / `danger` tone), the pill drops the
 * group hue for a warning / destructive token so the number reads as an alert, not a plain
 * total — while the tile's accessible name still states *what* it is, so colour is never the
 * only signal. On the translucent group tiles the soft same-hue wash matches the neutral pills
 * (`tile`); on the solid-primary Inventory CTA a solid fill is used instead (`cta`) so the alert
 * still pops against the primary background. All theme-aware tokens, dark-mode-correct for free.
 */
const TONE_COUNT_BADGE: Record<
  Exclude<NavCountTone, 'neutral'>,
  { readonly tile: string; readonly cta: string }
> = {
  warning: { tile: 'bg-warning/15 text-warning', cta: 'bg-warning text-warning-foreground' },
  danger: { tile: 'bg-destructive/15 text-destructive', cta: 'bg-destructive text-destructive-foreground' },
};

/**
 * Resolve a count pill's colour classes from its metric {@link NavCountTone}, the tile's group
 * and whether it's the solid-primary Inventory CTA. A neutral tone keeps the group hue (or the
 * CTA's inverse `primary-foreground`); a problem tone swaps in its warning/destructive token.
 * Kept out of the JSX so the tile stays presentation and the mapping lives in one place.
 */
function countBadgeClass(tone: NavCountTone, group: NavGroup, isCta: boolean): string {
  if (tone !== 'neutral') return isCta ? TONE_COUNT_BADGE[tone].cta : TONE_COUNT_BADGE[tone].tile;
  return isCta ? 'bg-primary-foreground/15 text-primary-foreground' : GROUP_COUNT_BADGE[group];
}

/**
 * Rich-Markdown blurb for each destination's hover tooltip — what you'll find behind the
 * card. Keyed by route so it stays aligned with {@link NAV_DESTINATIONS}; the dashboard
 * (`/`) is the current screen and never appears as a tile, and `/modules` is reached from
 * Settings/first-run rather than a nav tile — so neither has an entry.
 */
const NAV_TOOLTIPS: Record<Exclude<AppRoutePath, '/' | '/modules'>, string> = {
  '/inventory':
    '**Inventory** — your item catalogue.\n\nBrowse, search and filter every item, adjust stock by location, scan barcodes, and manage categories, locations, batches and cycle counts.',
  '/projects':
    '**Projects** — build & job workspaces.\n\nTrack each project’s bill of materials, reserve and consume stock, manage a **budget** with an expense ledger, and follow its status.',
  '/purchase-orders':
    '**Purchase orders** — procurement.\n\nRaise and receive POs against your suppliers, handle **partial / split receipts**, and watch in-transit stock land back in inventory.',
  '/reports':
    '**Reports** — analytics & insight.\n\nStock valuation, **ABC analysis**, turnover & aging, spend over time, supplier costs and a data-hygiene checklist — all exportable to CSV.',
  '/contacts':
    '**Contacts** — people & suppliers.\n\nYour address book of suppliers and contacts, with their linked **supplier parts**, pricing and price history.',
  '/bookings':
    '**Bookings** — reserve assets ahead.\n\nWhole-day reservations of bookable items shown on a calendar, with overlap checks and one-click **convert to checkout**.',
  '/upcoming':
    '**Upcoming** — your agenda.\n\nEvery date-driven event — due maintenance, expiring stock, bookings and PO deliveries — gathered into one timeline, **bucketed by when** it’s due.',
  '/activity':
    '**Activity** — the global timeline.\n\nA read-only feed of **every change across all items**, newest first, with filters by action type.',
  '/alerts':
    '**Alerts** — what needs attention.\n\nLow-stock, expiring, overdue and **budget** warnings gathered into one actionable list. The badge shows how many are active.',
  '/sync':
    '**Sync** — cloud backup & devices.\n\nBack up and restore your vault, and **sync changes between devices** so your inventory follows you.',
  '/home-assistant':
    '**Home Assistant** — voice control setup.\n\nAn interactive, step-by-step guide to ask **“where are my …?”** from Home Assistant — run the bridge, connect it, and generate an access token.',
  '/settings':
    '**Settings** — preferences.\n\nTheme, currency & locale, scanner options, low-stock thresholds, kiosk mode and the rest of the app’s behaviour.',
  '/about':
    '**About** — app & storage info.\n\nVersion, storage usage, platform capabilities and project information.',
};

export function DashboardNav() {
  // Alert badge: count of undismissed alerts for the Alerts tile.
  const { alerts } = useAlerts();
  const alertCount = alerts.length;
  const openSettings = useSettingsDialog((s) => s.openSettings);
  // Per-destination "how many are in there" counts for the collection tiles (Inventory,
  // Projects, …). A route absent from the map — or sitting at 0 — shows no pill.
  const navCounts = useNavCounts();
  // The user's persisted tile arrangement, resolved against feature-gating + stale orders.
  const { groups, move, moveTo, togglePin, reset } = useNavOrder();
  // Drop the drag glow's motion at source for reduced-motion users (mirrors the widget board);
  // they still get the static dashed target indicator.
  const reduced = useReducedMotion();

  // "Customise" edit mode + its screen-reader announcement of the last move. Drag state
  // tracks the tile being dragged and the drop target currently under the pointer.
  const [editing, setEditing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const endDrag = () => {
    setDraggingId(null);
    setOverKey(null);
  };

  // Announce the outcome of a move/pin (WCAG 4.1.3). A `null` result is a no-op (a clamped
  // arrow-key nudge at an edge, or a redundant pin) — nothing changed, so nothing is said.
  const announceMove = (result: NavMoveResult | null) => {
    if (!result) return;
    setAnnouncement(
      `${result.label} moved to position ${result.index + 1} of ${result.count} in ${GROUP_LABELS[result.group]}${
        result.pinned ? ' (pinned)' : ''
      }`,
    );
  };
  const announcePin = (result: NavMoveResult | null) => {
    if (!result) return;
    setAnnouncement(
      `${result.label} ${result.pinned ? 'pinned to the top of' : 'unpinned from'} ${GROUP_LABELS[result.group]}`,
    );
  };

  const handleTileKeyDown = (id: string) => (e: KeyboardEvent) => {
    const dir = ARROW_DIRECTIONS[e.key];
    if (!dir) return;
    e.preventDefault();
    announceMove(move(id, dir));
  };

  const handleDrop = (group: NavGroup, index: number) => (e: DragEvent) => {
    e.preventDefault();
    const id = draggingId ?? e.dataTransfer.getData('text/plain');
    endDrag();
    if (id) announceMove(moveTo(id, group, index));
  };

  // Guarded dragover so a continuous stream on the same target doesn't churn state.
  const markOver = (key: string) => (e: DragEvent) => {
    e.preventDefault();
    setOverKey((prev) => (prev === key ? prev : key));
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Customise toolbar — mirrors the widget board's edit affordance (DashboardGrid). */}
      <div className="flex items-center gap-3">
        {editing ? (
          <Tooltip
            content="Restore the default tile order — every tile back in its original group and position."
            triggerTabIndex={-1}
            className="ml-auto"
          >
            <button
              type="button"
              onClick={() => {
                reset();
                setAnnouncement('Navigation tiles reset to their default order.');
              }}
              data-testid="reset-nav"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            >
              <ResetIcon />
              Reset
            </button>
          </Tooltip>
        ) : null}
        <Tooltip
          content="Rearrange the tiles: drag or arrow-key them to reorder within a group or move between groups, and pin the ones you use most to the top. Your layout is saved on this device."
          triggerTabIndex={-1}
          className={cn(!editing && 'ml-auto')}
        >
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            data-testid="customise-nav"
            aria-pressed={editing}
            className={cn(buttonVariants({ variant: editing ? 'primary' : 'outline', size: 'sm' }))}
          >
            {editing ? <CheckIcon /> : <CustomiseIcon />}
            {editing ? 'Done' : 'Customise'}
          </button>
        </Tooltip>
      </div>

      <nav aria-label="Primary navigation" className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-3">
        {groups.map(({ group, tiles }) => (
          <section
            key={group}
            aria-label={GROUP_LABELS[group]}
            className={cn('rounded-2xl p-3', GROUP_TINTS[group])}
          >
            <h2 className="mb-3 px-1 text-sm font-semibold text-muted-foreground">{GROUP_LABELS[group]}</h2>
            <ul className="grid grid-cols-2 gap-3">
              {tiles.map(({ dest, pinned }, index) => {
                const isInventory = dest.to === '/inventory';
                const isAlerts = dest.to === '/alerts';
                // Settings is a dialog, not a screen: its tile opens the dialog over the
                // dashboard rather than navigating (and a Link would prefetch-open it on
                // hover). See `useSettingsDialog` / `SettingsDialogHost`.
                const isSettings = dest.to === '/settings';
                // Collection count for this tile (Inventory/Projects/…); undefined or 0 ⇒ no pill.
                const navCount = navCounts[dest.to];
                const count = navCount?.count;
                const showCount = typeof count === 'number' && count > 0;
                // Spoken form of the count for the tile's accessible name — a bare "3" next to
                // "Projects" is ambiguous, so name it ("Projects — 3 active projects").
                const countLabel =
                  showCount && navCount
                    ? `${isInventory ? 'Open inventory' : dest.label} — ${count} ${plural(
                        count,
                        navCount.noun,
                        navCount.nounPlural,
                      )}`
                    : undefined;

                const body = (
                  <>
                    <dest.Icon aria-hidden />
                    <span className="min-w-0 text-sm font-medium leading-tight">
                      {isInventory ? 'Open inventory' : dest.label}
                    </span>
                    {isAlerts && alertCount > 0 && (
                      <span
                        aria-hidden
                        data-testid="alerts-badge"
                        className="ml-auto flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground"
                      >
                        {alertCount > 99 ? '99+' : alertCount}
                      </span>
                    )}
                    {/* Collection count pill — right-aligned, capped so a huge catalogue can't
                        stretch the tile. Its colour follows the metric's tone (group hue for a
                        plain total; a warning / destructive token for an A2 "problem" metric).
                        The spoken count rides on the tile's aria-label below, so the pill itself
                        is decorative. */}
                    {showCount && count !== undefined && navCount && (
                      <span
                        aria-hidden
                        data-testid={`nav-count-${dest.to}`}
                        className={cn(
                          'ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums',
                          countBadgeClass(navCount.tone, group, isInventory),
                        )}
                      >
                        {count > 999 ? '999+' : count}
                      </span>
                    )}
                  </>
                );

                // Edit mode: the tile is a draggable, arrow-key-movable card with a pin
                // toggle — it never navigates. Mirrors DashboardGrid's WidgetTile edit shell.
                if (editing) {
                  const isOver = overKey === dest.to;
                  return (
                    <li key={dest.to}>
                      <Surface
                        data-testid={`nav-tile-${dest.to}`}
                        draggable
                        tabIndex={0}
                        role="group"
                        aria-label={`${dest.label}${pinned ? ', pinned' : ''}. Use the arrow keys to move it, or Pin to float it to the top.`}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', dest.to);
                          e.dataTransfer.effectAllowed = 'move';
                          setDraggingId(dest.to);
                        }}
                        onDragEnd={endDrag}
                        onDragOver={markOver(dest.to)}
                        onDrop={handleDrop(group, index)}
                        onKeyDown={handleTileKeyDown(dest.to)}
                        className={cn(
                          'flex h-full cursor-grab flex-col gap-2 p-3 transition-shadow focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing',
                          // Drop target: the same dashed, breathing-glow "goes here" indicator
                          // the widget board uses (DashboardGrid ghost + `animate-ghost`), with
                          // the resting ring suppressed so the dashed outline reads alone rather
                          // than doubled with a solid ring. Reduced-motion drops the pulse.
                          isOver
                            ? cn(
                                'border-2 border-dashed border-primary/60 bg-primary/10',
                                !reduced && 'animate-ghost',
                              )
                            : 'ring-2 ring-primary/40',
                        )}
                      >
                        <div className="flex items-center gap-1.5 text-muted-foreground [&_svg]:size-4">
                          <DragHandleIcon aria-hidden />
                          <button
                            type="button"
                            onClick={() => announcePin(togglePin(dest.to))}
                            data-testid={`nav-pin-${dest.to}`}
                            aria-pressed={pinned}
                            aria-label={pinned ? `Unpin ${dest.label}` : `Pin ${dest.label} to the top`}
                            className={cn(
                              'ml-auto rounded-md p-1 hover:bg-muted hover:text-foreground',
                              pinned && 'text-primary',
                            )}
                          >
                            <PinIcon className={cn(pinned && 'fill-current')} />
                          </button>
                        </div>
                        {/* Icon + label + decorative count, inert while arranging. */}
                        <div className="pointer-events-none flex items-center gap-2.5 [&_svg]:size-5 [&_svg]:shrink-0">
                          {body}
                        </div>
                      </Surface>
                    </li>
                  );
                }

                const tileClassName =
                  'block h-full w-full rounded-2xl text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
                const surface = (
                  <Surface
                    className={cn(
                      'relative flex h-full items-center gap-2.5 p-3 transition-all duration-200 ease-emphasized hover:-translate-y-0.5 [&_svg]:size-5 [&_svg]:shrink-0',
                      isInventory
                        ? 'border-transparent bg-primary text-primary-foreground shadow-primary/20 hover:shadow-primary/30'
                        : cn('hover:shadow-primary/10', GROUP_CARD_TINTS[group]),
                    )}
                  >
                    {body}
                  </Surface>
                );
                return (
                  <li key={dest.to}>
                    <Tooltip
                      content={NAV_TOOLTIPS[dest.to as keyof typeof NAV_TOOLTIPS]}
                      triggerTabIndex={-1}
                      openDelayMs={NAV_OPEN_DELAY_MS}
                      className="block h-full"
                    >
                      {isSettings ? (
                        <button
                          type="button"
                          data-testid="nav-settings"
                          onClick={openSettings}
                          className={tileClassName}
                        >
                          {surface}
                        </button>
                      ) : (
                        <Link
                          to={dest.to}
                          data-testid={isAlerts ? 'nav-alerts' : undefined}
                          aria-label={
                            isAlerts && alertCount > 0
                              ? `Alerts — ${alertCount} active ${plural(alertCount, 'alert')}`
                              : countLabel
                          }
                          className={tileClassName}
                        >
                          {surface}
                        </Link>
                      )}
                    </Tooltip>
                  </li>
                );
              })}

              {/* Edit-mode trailing drop zone: drop a tile here to append it to the end of
                  this group (the path for moving a tile into a different group). */}
              {editing ? (
                <li className="col-span-2">
                  <div
                    onDragOver={markOver(`end:${group}`)}
                    onDrop={handleDrop(group, tiles.length)}
                    data-testid={`nav-drop-end-${group}`}
                    aria-hidden
                    className={cn(
                      'min-h-10 rounded-xl border-2 border-dashed transition-colors',
                      overKey === `end:${group}` ? 'border-primary/60 bg-primary/5' : 'border-border/60',
                    )}
                  />
                </li>
              ) : null}
            </ul>
          </section>
        ))}
      </nav>

      {/* Announce-only twin of the visual reorder, so a keyboard/pointer move isn't silent. */}
      <LiveRegion visuallyHidden>{announcement ? <p>{announcement}</p> : null}</LiveRegion>
    </div>
  );
}

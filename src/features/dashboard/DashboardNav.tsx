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
import { useState, type KeyboardEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import {
  Button,
  buttonVariants,
  LiveRegion,
  NAV_OPEN_DELAY_MS,
  Surface,
  Tooltip,
  useReducedMotion,
} from '@/components/foundry';
import { CheckIcon, CustomiseIcon, DragHandleIcon, PinIcon, ResetIcon } from '@/components/icons';
import { NAV_GROUP_ORDER, type AppRoutePath, type NavGroup } from '@/components/nav/nav-destinations';
import { useAlerts } from '@/features/alerts/useAlerts';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import type { NavCountTone } from '@/features/settings/settings';
import { useT, type MessageKey } from '@/features/i18n';
import { useNavCounts } from './useNavCounts';
import { useNavOrder, type NavMoveResult } from './useNavOrder';
import { useDashboardCustomise } from './useDashboardCustomise';
import { useReorderFlip } from './useReorderFlip';
import { useBoardPointerDrag } from './useBoardPointerDrag';
import { BoardMoveButtons, type MoveDir } from './BoardMoveButtons';

/** i18n key for each nav group heading (the SSOT keys are terse identifiers). */
const GROUP_LABEL_KEYS: Record<NavGroup, MessageKey> = {
  primary: 'dashboard.nav.group.primary',
  manage: 'dashboard.nav.group.manage',
  system: 'dashboard.nav.group.system',
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
 * the tint beneath show through. Same theme-aware tokens as {@link GROUP_TINTS}; where the
 * `Surface` carries its frost — see `--backdrop-surface`, which touch hardware and high contrast
 * both clear — that glazes the tint for a glassy look. The Inventory tile is exempt — it keeps
 * its solid primary call-to-action fill.
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
 * Parse a nav drop-target key into the group + display index a dropped tile should reinsert at.
 * Both a tile position (`pos:<group>:<index>`) and a group's trailing drop zone
 * (`end:<group>:<count>`) share the `kind:group:index` shape, so one parser serves both.
 */
function parseNavDropKey(key: string): { group: NavGroup; index: number } | null {
  const [kind, group, index] = key.split(':');
  if ((kind !== 'pos' && kind !== 'end') || !group || index === undefined) return null;
  return { group: group as NavGroup, index: Number(index) };
}

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
 * i18n key for each destination's rich-Markdown hover tooltip — what you'll find behind the card.
 * Keyed by route so it stays aligned with {@link NAV_DESTINATIONS}; the dashboard (`/`) is the
 * current screen and never appears as a tile, and the off-nav routes (`/modules` and `/tags` plus
 * the Reports sub-screens `/catalogue` and `/insurance-schedule`) are reached from their own
 * screens rather than a nav tile — so none of them has an entry.
 */
const NAV_TOOLTIP_KEYS: Record<
  Exclude<AppRoutePath, '/' | '/modules' | '/tags' | '/catalogue' | '/insurance-schedule'>,
  MessageKey
> = {
  '/inventory': 'dashboard.nav.tooltip.inventory',
  '/projects': 'dashboard.nav.tooltip.projects',
  '/purchase-orders': 'dashboard.nav.tooltip.purchaseOrders',
  '/suppliers': 'dashboard.nav.tooltip.suppliers',
  '/reports': 'dashboard.nav.tooltip.reports',
  '/contacts': 'dashboard.nav.tooltip.contacts',
  '/bookings': 'dashboard.nav.tooltip.bookings',
  '/upcoming': 'dashboard.nav.tooltip.upcoming',
  '/activity': 'dashboard.nav.tooltip.activity',
  '/alerts': 'dashboard.nav.tooltip.alerts',
  '/sync': 'dashboard.nav.tooltip.sync',
  '/webhooks': 'dashboard.nav.tooltip.webhooks',
  '/home-assistant': 'dashboard.nav.tooltip.homeAssistant',
  '/users': 'dashboard.nav.tooltip.users',
  '/settings': 'dashboard.nav.tooltip.settings',
  '/about': 'dashboard.nav.tooltip.about',
};

/**
 * Dashboard-specific tile labels that override a route's global nav label, kept short so the
 * text doesn't wrap in the hub's two-column tile grid. Only routes whose full nav label would
 * wrap need an entry — every other tile uses its {@link NavDestination.messageKey}. The global
 * {@link AppNav} menu and the command palette keep the full label; this is display text for the
 * hub tiles alone.
 */
const DASHBOARD_TILE_LABEL_KEYS: Partial<Record<AppRoutePath, MessageKey>> = {
  '/purchase-orders': 'dashboard.nav.purchaseOrdersShort',
};

export function DashboardNav() {
  const t = useT();
  // The translated heading for a nav group — reused by the section aria-label/heading, the move/pin
  // announcements and the drop-zone hint, so they can never disagree.
  const groupLabel = (group: NavGroup) => t(GROUP_LABEL_KEYS[group]);
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

  // The hub's single, shared "Customise" edit mode — this button is the only toggle, and it
  // drives both this tile grid *and* the widget board below (DashboardGrid reads the same store).
  const editing = useDashboardCustomise((s) => s.editing);
  const toggleEditing = useDashboardCustomise((s) => s.toggle);
  const [announcement, setAnnouncement] = useState('');

  // Glide a tile to its new place when it's dragged/arrow-keyed/pinned (FLIP), on the signature
  // easing. Keyed on the resolved per-group order (with pin markers) so any rearrangement plays;
  // gated on edit mode and reduced-motion (reduced-motion users get the instant jump).
  const orderKey = groups
    .map((g) => `${g.group}:${g.tiles.map((tile) => (tile.pinned ? '*' : '') + tile.dest.to).join(',')}`)
    .join('|');
  const registerTile = useReorderFlip(orderKey, editing && !reduced);

  // Announce the outcome of a move/pin (WCAG 4.1.3). A `null` result is a no-op (a clamped
  // arrow-key nudge at an edge, or a redundant pin) — nothing changed, so nothing is said.
  const announceMove = (result: NavMoveResult | null) => {
    if (!result) return;
    setAnnouncement(
      t('dashboard.nav.moveAnnounce', {
        vars: {
          label: result.label,
          position: result.index + 1,
          total: result.count,
          group: groupLabel(result.group),
        },
      }) + (result.pinned ? t('dashboard.nav.pinnedSuffix') : ''),
    );
  };
  const announcePin = (result: NavMoveResult | null) => {
    if (!result) return;
    setAnnouncement(
      t(result.pinned ? 'dashboard.nav.pinAnnounce.pinned' : 'dashboard.nav.pinAnnounce.unpinned', {
        vars: { label: result.label, group: groupLabel(result.group) },
      }),
    );
  };

  const handleTileKeyDown = (id: string) => (e: KeyboardEvent) => {
    const dir = ARROW_DIRECTIONS[e.key];
    if (!dir) return;
    e.preventDefault();
    announceMove(move(id, dir));
  };

  // Pointer drag-to-reorder (mouse / pen / touch, replacing the touch-blind HTML5 drag). Dropping a
  // tile onto a position key reinserts it there; the arrow keys and the on-tile move buttons are the
  // touch-free equivalents. `enabled` only while customising, so tiles navigate normally otherwise.
  const drag = useBoardPointerDrag({
    boardId: 'nav',
    enabled: editing,
    onDrop: (id, key) => {
      const dropAt = parseNavDropKey(key);
      if (dropAt) announceMove(moveTo(id, dropAt.group, dropAt.index));
    },
  });

  return (
    <div className="flex flex-col gap-3">
      {/* The dashboard's single Customise toolbar: this one button toggles edit mode for both
          the navigation tiles here and the widget board below (they share one edit mode). */}
      <div className="flex items-center gap-3">
        {editing ? (
          <Tooltip content={t('dashboard.nav.resetTilesTooltip')} triggerTabIndex={-1} className="ml-auto">
            <button
              type="button"
              onClick={() => {
                reset();
                setAnnouncement(t('dashboard.nav.resetAnnounce'));
              }}
              data-testid="reset-nav"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            >
              <ResetIcon />
              {t('dashboard.nav.resetTiles')}
            </button>
          </Tooltip>
        ) : null}
        <Tooltip
          content={t('dashboard.nav.customiseTooltip')}
          triggerTabIndex={-1}
          className={cn(!editing && 'ml-auto')}
        >
          <button
            type="button"
            onClick={() => toggleEditing()}
            data-testid="customise-nav"
            aria-pressed={editing}
            className={cn(buttonVariants({ variant: editing ? 'primary' : 'outline', size: 'sm' }))}
          >
            {editing ? <CheckIcon /> : <CustomiseIcon />}
            {editing ? t('dashboard.nav.done') : t('dashboard.nav.customise')}
          </button>
        </Tooltip>
      </div>

      <nav
        aria-label={t('dashboard.nav.ariaLabel')}
        className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-3"
      >
        {groups.map(({ group, tiles }) => (
          <section
            key={group}
            aria-label={groupLabel(group)}
            className={cn('rounded-2xl p-3', GROUP_TINTS[group])}
          >
            <h2 className="mb-3 px-1 text-sm font-semibold text-muted-foreground">{groupLabel(group)}</h2>
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
                // The tile's translated label — normally its route label, but shortened for the
                // hub where the full nav label would wrap the tile (see DASHBOARD_TILE_LABEL_KEYS).
                const tileLabel = t(DASHBOARD_TILE_LABEL_KEYS[dest.to] ?? dest.messageKey);
                // Spoken form of the count for the tile's accessible name — a bare "3" next to
                // "Projects" is ambiguous, so name it ("Projects — 3 active projects"). The count
                // *noun* comes from the nav-count metric config (a separate subsystem, not yet
                // translated), so it stays English while the tile label is localized.
                const countLabel =
                  showCount && navCount
                    ? `${tileLabel} — ${count} ${plural(count, navCount.noun, navCount.nounPlural)}`
                    : undefined;

                const body = (
                  <>
                    <dest.Icon aria-hidden />
                    <span className="min-w-0 text-sm font-medium leading-tight">{tileLabel}</span>
                    {isAlerts && alertCount > 0 && (
                      // `key` on the count re-mounts the badge when the number changes so the
                      // one-shot `animate-badge-pop` replays — a small "this just arrived" pop
                      // (F8). Decorative (the count rides the tile's aria-label); reduced motion
                      // neutralises the pop via the global catch-all.
                      <span
                        key={alertCount}
                        aria-hidden
                        data-testid="alerts-badge"
                        className="ml-auto flex size-5 animate-badge-pop items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground"
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
                      // `key` re-mounts the pill on a count change so the one-shot
                      // `animate-badge-pop` replays (F8) — see the alerts badge above.
                      <span
                        key={count}
                        aria-hidden
                        data-testid={`nav-count-${dest.to}`}
                        className={cn(
                          'ml-auto inline-flex h-5 min-w-5 animate-badge-pop items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums',
                          countBadgeClass(navCount.tone, group, isInventory),
                        )}
                      >
                        {count > 999 ? '999+' : count}
                      </span>
                    )}
                  </>
                );

                // Edit mode: the tile is a pointer-draggable, arrow-key- and button-movable card
                // with a pin toggle — it never navigates. Mirrors DashboardGrid's WidgetTile shell.
                if (editing) {
                  const posKey = `pos:${group}:${index}`;
                  const isOver = drag.overKey === posKey;
                  const isDragging = drag.draggingId === dest.to;
                  const name = t(dest.messageKey);
                  const groupIdx = NAV_GROUP_ORDER.indexOf(group);
                  // Edge states for the move buttons. Up/down can't cross the pinned↔unpinned
                  // partition (mirrors `nudgeTile`), so a neighbour of the other pin state counts
                  // as an edge; left/right are bounded by the group order.
                  const moveDisabled: Record<MoveDir, boolean> = {
                    up: index === 0 || tiles[index - 1]?.pinned !== pinned,
                    down: index === tiles.length - 1 || tiles[index + 1]?.pinned !== pinned,
                    left: groupIdx <= 0,
                    right: groupIdx >= NAV_GROUP_ORDER.length - 1,
                  };
                  return (
                    <li key={dest.to} ref={registerTile(dest.to)}>
                      <Surface
                        {...drag.sourceProps(dest.to, tileLabel)}
                        {...drag.dropProps(posKey)}
                        data-testid={`nav-tile-${dest.to}`}
                        tabIndex={0}
                        role="group"
                        aria-label={t('dashboard.nav.tileEditAria', {
                          vars: {
                            name,
                            pinned: pinned ? t('dashboard.nav.pinnedComma') : '',
                          },
                        })}
                        onKeyDown={handleTileKeyDown(dest.to)}
                        className={cn(
                          'flex h-full cursor-grab flex-col gap-2 p-3 transition-shadow focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing',
                          // The dragged source dims so the floating preview reads as the thing in
                          // flight (there is no native drag-image with the pointer path).
                          isDragging && 'opacity-50',
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
                            aria-label={t(
                              pinned ? 'dashboard.nav.pinTileAria.unpin' : 'dashboard.nav.pinTileAria.pin',
                              {
                                vars: { name },
                              },
                            )}
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
                        {/* Touch/click move controls — the accessible, drag-free way to reorder
                            (issue #11). Arrow keys do the same for a physical keyboard. */}
                        <BoardMoveButtons
                          onMove={(dir) => announceMove(move(dest.to, dir))}
                          disabled={moveDisabled}
                          labels={{
                            up: t('dashboard.nav.moveUp', { vars: { name } }),
                            down: t('dashboard.nav.moveDown', { vars: { name } }),
                            left: t('dashboard.nav.moveToPrevGroup', { vars: { name } }),
                            right: t('dashboard.nav.moveToNextGroup', { vars: { name } }),
                          }}
                          testIdPrefix={`nav-move-${dest.to}`}
                          className="mt-auto justify-center border-t border-border/40 pt-1.5"
                        />
                      </Surface>
                    </li>
                  );
                }

                const tileClassName =
                  'block h-full w-full cursor-pointer rounded-2xl text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
                // Shape/spacing/motion shared by every tile card, whether it's the plain Surface
                // card below or the Inventory call-to-action Button.
                const cardClassName =
                  'relative flex h-full items-center gap-2.5 p-3 transition-all duration-200 ease-emphasized hover:-translate-y-0.5 [&_svg]:size-5 [&_svg]:shrink-0';
                const surface = (
                  <Surface className={cn(cardClassName, 'hover:shadow-primary/10', GROUP_CARD_TINTS[group])}>
                    {body}
                  </Surface>
                );
                return (
                  <li key={dest.to} ref={registerTile(dest.to)}>
                    <Tooltip
                      content={t(NAV_TOOLTIP_KEYS[dest.to as keyof typeof NAV_TOOLTIP_KEYS])}
                      triggerTabIndex={-1}
                      openDelayMs={NAV_OPEN_DELAY_MS}
                      className="block h-full"
                    >
                      {isSettings ? (
                        <button
                          type="button"
                          data-testid="nav-settings"
                          onClick={() => openSettings()}
                          className={tileClassName}
                        >
                          {surface}
                        </button>
                      ) : isInventory ? (
                        // The hub's primary call-to-action: rendered through the Foundry `Button`
                        // (as a router `Link` via `asChild`) so it *is* a primary button — solid
                        // fill, shadow and the signature hover sheen — rather than a bespoke tinted
                        // card. The card classes override the button's default pill height/padding/
                        // radius so it fills the tile like its Surface siblings.
                        <Button
                          asChild
                          variant="primary"
                          className={cn(cardClassName, 'w-full justify-start rounded-2xl text-left')}
                        >
                          <Link to={dest.to} aria-label={countLabel}>
                            {body}
                          </Link>
                        </Button>
                      ) : (
                        <Link
                          to={dest.to}
                          data-testid={isAlerts ? 'nav-alerts' : undefined}
                          aria-label={
                            isAlerts && alertCount > 0
                              ? t('dashboard.nav.alertsAria', { vars: { count: alertCount } })
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
                    {...drag.dropProps(`end:${group}:${tiles.length}`)}
                    data-testid={`nav-drop-end-${group}`}
                    aria-hidden
                    className={cn(
                      'flex min-h-10 items-center justify-center rounded-xl border-2 border-dashed px-3 text-center text-xs font-medium transition-colors',
                      drag.overKey === `end:${group}:${tiles.length}`
                        ? 'border-primary/60 bg-primary/5 text-primary'
                        : 'border-border/60 text-muted-foreground/60',
                    )}
                  >
                    {t('dashboard.nav.dropHere', { vars: { group: groupLabel(group) } })}
                  </div>
                </li>
              ) : null}
            </ul>
          </section>
        ))}
      </nav>

      {/* The floating drag preview that follows the pointer (mouse / pen / touch). */}
      {drag.preview}

      {/* Announce-only twin of the visual reorder, so a keyboard/pointer move isn't silent. */}
      <LiveRegion visuallyHidden>{announcement ? <p>{announcement}</p> : null}</LiveRegion>
    </div>
  );
}

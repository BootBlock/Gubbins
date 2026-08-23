import { type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Modal } from './modal';
import { resolveTabKey } from './tab-keyboard';

/**
 * A single rail tab: an icon + label in the left-hand rail, and the panel content it
 * reveals. By default only the active tab's `content` is placed in the tree, so switching
 * tabs unmounts the previous panel — a caller whose panels hold in-flight state should set
 * {@link RailModalProps.keepPanelsMounted} rather than relying on that.
 */
export interface RailTab {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly content: ReactNode;
  /**
   * Visual tone of the rail button. `danger` tints it with the destructive token — for a
   * rail node that leads to irreversible actions (e.g. the Settings dialog's Danger zone),
   * so it reads as set-apart from the ordinary sections above it.
   */
  readonly tone?: 'default' | 'danger';
}

export interface RailModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  /** Extra classes for the {@link Modal} surface — typically a wider `max-w-*`. */
  readonly className?: string;
  /** Forwarded to {@link Modal}: an element pinned in the header's top-right (left of Close). */
  readonly titleAccessory?: ReactNode;
  /** Accessible name for the `role="tablist"` rail (e.g. "Settings sections"). */
  readonly railAriaLabel: string;
  /** Namespace for the generated tab/panel element ids, so two rail dialogs never collide. */
  readonly idPrefix: string;
  readonly tabs: readonly RailTab[];
  /**
   * Optional full-width row pinned above the rail and the panel — e.g. a filter box that
   * applies across every tab. It stays put as tabs change, so it never reads as belonging to
   * whichever section happens to be showing.
   */
  readonly toolbar?: ReactNode;
  /**
   * When set, this replaces the rail *and* the panel, keeping the frame's fixed height,
   * toolbar and footer. For a rail dialog whose toolbar can switch it into a view spanning
   * every tab — the Settings search results. The rail is taken away rather than left inert
   * because it would otherwise claim one section is selected while showing results from all
   * of them.
   */
  readonly overrideContent?: ReactNode;
  /** Optional footer pinned below the panel — e.g. a Close button, bottom-right. */
  readonly footer?: ReactNode;
  /** Which tab is selected first. Defaults to the first tab. Ignored when controlled. */
  readonly initialTabId?: string;
  /**
   * Controlled selection: the id of the currently-active tab. When provided (paired with
   * {@link onActiveTabChange}) the caller owns which tab is shown — e.g. a form dialog that
   * jumps to the tab holding the first validation error on submit. Omit both for the default
   * uncontrolled behaviour, where the rail tracks its own selection.
   */
  readonly activeTabId?: string;
  /** Called with the id of a newly-selected tab (rail click or arrow-key). Required for control. */
  readonly onActiveTabChange?: (id: string) => void;
  /**
   * When set, the rail frame (panel + footer) is wrapped in a `<form>` that fires this on
   * submit, so a single form spans fields spread across panels and a footer submit button —
   * the model behind the tabbed Add-item dialog. The rail's own tab buttons are `type="button"`,
   * so navigating tabs never submits. Omit for a read-only / per-facet-autosaving rail dialog.
   */
  readonly onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  /**
   * Forwarded to the underlying {@link Modal}: move initial focus to this control on open
   * (e.g. the Name field of a form dialog). The target must live in the first-shown tab.
   */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Keep every panel the user has visited *this opening* mounted, hiding the inactive ones
   * instead of unmounting them (issue #576).
   *
   * Set this for a rail whose panels hold state the user has not committed yet — the item-detail
   * editor, whose facet editors each keep a draft in local state until an explicit Save. Without
   * it, clicking across to another tab to check something destroys that draft with no warning and
   * nothing to undo, which is the opposite of what a tab rail is understood to do.
   *
   * Left off by default because unmounting is the right behaviour for a panel that owns a live
   * resource — the barcode scanner's camera preview should stop when you leave it, not keep
   * running out of sight — and because mounting is when a panel's queries and effects run. Panels
   * are mounted on first visit rather than all at once, so a rail costs no more than the sections
   * actually opened, and the set resets when the dialog closes.
   */
  readonly keepPanelsMounted?: boolean;
  /**
   * Forwarded to the underlying {@link Modal}: the rail dialog has work in flight, so every
   * route out of it is refused until that finishes (issue #654).
   */
  readonly busy?: boolean;
}

/**
 * Foundry RailModal — a {@link Modal} with a vertical tab rail down the left and a
 * scrolling content panel on the right (spec §2.4.1 — the WAI-ARIA APG `tabs` pattern,
 * vertical orientation with automatic activation). It is the shared frame behind the
 * item-detail editor and the Settings dialog, so a long stack of sections stays short:
 * the rail keeps the dialog a fixed height, gives each panel full focus, and leaves
 * obvious room to grow as more sections arrive.
 *
 * Behaviour: the rail uses a roving `tabindex` (only the selected tab is tabbable);
 * Arrow keys (with wrap) and Home/End move focus and selection together via the pure
 * {@link resolveTabKey}. The panel scrolls within a fixed-height frame, so switching
 * tabs never resizes or re-centres the whole modal.
 */
export function RailModal({
  open,
  onClose,
  title,
  description,
  className,
  titleAccessory,
  railAriaLabel,
  idPrefix,
  tabs,
  toolbar,
  overrideContent,
  footer,
  initialTabId,
  activeTabId,
  onActiveTabChange,
  onSubmit,
  initialFocusRef,
  keepPanelsMounted = false,
  busy = false,
}: RailModalProps) {
  // Uncontrolled fallback selection — used only when the caller does not pass `activeTabId`.
  const [internalId, setInternalId] = useState(initialTabId ?? tabs[0]!.id);
  const activeId = activeTabId ?? internalId;
  // Roving-tabindex refs for the rail buttons, so arrow-key navigation can move DOM
  // focus to the newly-selected tab (the APG automatic-activation model).
  const tabRefs = useRef(new Map<string, HTMLButtonElement | null>());

  // Guard against a stale selection if the tab set ever changes shape.
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  // Which panels are in the tree. Under `keepPanelsMounted` a panel joins the set the first time
  // it is shown and stays there until the dialog closes, so a draft typed into one survives a
  // trip to another tab and back. Tracked in a ref and updated during render because the answer
  // is needed *this* render — deferring it to an effect would blank the panel for a frame on
  // every tab change. The write is a pure function of (open, active.id), so a re-run of this
  // render — StrictMode, a discarded concurrent attempt — reaches the same set.
  const visitedRef = useRef(new Set<string>());
  if (!open) visitedRef.current.clear();
  visitedRef.current.add(active.id);
  const mountedTabs = keepPanelsMounted ? tabs.filter((t) => visitedRef.current.has(t.id)) : [active];

  const select = (id: string) => {
    // Uncontrolled: track selection here. Controlled: leave it to the caller's state, which
    // flows back in via `activeTabId`. Either way notify the caller and move focus to the tab.
    if (activeTabId === undefined) setInternalId(id);
    onActiveTabChange?.(id);
    tabRefs.current.get(id)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = resolveTabKey(
      tabs.map((t) => t.id),
      active.id,
      e.key,
    );
    if (next === null) return;
    e.preventDefault();
    select(next);
  };

  // Fixed-height frame: the dialog stays the same size as you switch tabs, so the rail never
  // shifts and the panel scrolls within rather than resizing (and re-centring) the whole modal.
  // A trailing footer stays pinned below it. When `onSubmit` is given the frame is wrapped in a
  // <form> so fields spread across panels and the footer submit button share one form.
  //
  // `74dvh` is the height it *asks* for; it is a flex item under the Modal's `scrollBody={false}`
  // body, so on a viewport too short to grant that (a small laptop, or any display zoomed in far
  // enough) `min-h-0` lets it shrink to the room actually available instead of overflowing the
  // Surface. Below that the panel simply scrolls, as it already does when a section is long.
  const frame = (
    <div className="flex h-[74dvh] min-h-0 flex-col">
      {toolbar ? <div className="mb-4 shrink-0">{toolbar}</div> : null}

      {overrideContent ? (
        // No entrance animation here, unlike the panel below: this content is typically driven
        // by the toolbar (a filter box), and replaying a fade on every keystroke would flicker.
        <div className="min-h-0 min-w-0 flex-1 dialog-scroll">{overrideContent}</div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4 sm:gap-5">
          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label={railAriaLabel}
            // The max-width is sized to hold the longest section name a caller ships without
            // ellipsis, while stopping a pathological label from crowding out the panel. It
            // carries the ring bleed below in its own sum, so that widening the bleed never
            // quietly costs the labels room (the cap applies to the border box, padding and all).
            // `min-h-0 overflow-y-auto` matters once the labels are showing on a short viewport:
            // the rail is `shrink-0`, so a ten-section stack that no longer fits would otherwise
            // spill straight out past the footer and off the Surface. It scrolls instead.
            //
            // Setting `overflow-y` also makes the *horizontal* axis clip (CSS resolves the other
            // axis of a scroll container away from `visible`), which would shave the focus ring
            // off every tab, since a tab stretches to the full width of the rail. `-mx-ring-bleed
            // px-ring-bleed` cancels out, so no tab moves; it only gives that ring room to paint
            // (issue #417).
            className="-mx-ring-bleed flex max-w-[calc(13rem+2*var(--spacing-ring-bleed))] min-h-0 shrink-0 flex-col gap-1 overflow-y-auto px-ring-bleed"
          >
            {tabs.map((tab) => {
              const selected = tab.id === active.id;
              const danger = tab.tone === 'danger';
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current.set(tab.id, el);
                  }}
                  type="button"
                  role="tab"
                  id={`${idPrefix}-tab-${tab.id}`}
                  aria-label={tab.label}
                  aria-selected={selected}
                  aria-controls={`${idPrefix}-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => select(tab.id)}
                  onKeyDown={onKeyDown}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium',
                    'transition-colors ease-emphasized',
                    'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    selected
                      ? danger
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-primary/10 text-primary'
                      : danger
                        ? 'text-destructive/80 hover:bg-destructive/10 hover:text-destructive'
                        : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-7 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
                      selected
                        ? danger
                          ? 'bg-destructive/15 text-destructive'
                          : 'bg-primary/15 text-primary'
                        : danger
                          ? 'bg-destructive/10 text-destructive/80'
                          : 'bg-secondary/50 text-muted-foreground',
                    )}
                  >
                    {tab.icon}
                  </span>
                  {/* The label stays visible wherever there is room for it. It collapses to the
                    icon alone only on a real handset (`handset:` — narrow *and* coarse-pointer),
                    never on a merely-narrow viewport: a desktop at 200% zoom measures ~640px in
                    CSS pixels, and taking the section names away from someone who zoomed in to
                    read is the opposite of what they need (WCAG 1.4.4 Resize Text). `aria-label`
                    above keeps the accessible name intact in the collapsed case. */}
                  <span className="truncate handset:hidden">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {mountedTabs.map((tab) => {
            const selected = tab.id === active.id;
            return (
              <div
                key={tab.id}
                role="tabpanel"
                id={`${idPrefix}-panel-${tab.id}`}
                aria-labelledby={`${idPrefix}-tab-${tab.id}`}
                tabIndex={0}
                // A kept-but-inactive panel is hidden *and* `inert` — the same pairing the
                // Settings search uses for a filtered-out section. `display: none` alone leaves
                // its controls in `querySelectorAll`, and focusing one does nothing, so the
                // dialog's Tab trap would park on it and leave Tab a dead key; `inert` takes the
                // subtree out of the cycle (see `focus-trap.ts`) and tells the platform the same.
                inert={!selected}
                // Hidden by `display: none` rather than visibility, which is also what replays
                // the fade-through entrance on the panel being switched *to*: a CSS animation
                // restarts from the beginning when an element leaves `display: none`, so
                // `animate-swap-in` still fires per switch with no remount to key it off. The
                // reduced-motion catch-all neutralises it as before.
                className={cn(
                  'min-w-0 flex-1 animate-swap-in space-y-4 dialog-scroll focus-visible:outline-none',
                  !selected && 'hidden',
                )}
              >
                {tab.content}
              </div>
            );
          })}
        </div>
      )}

      {footer ? (
        <div className="mt-4 flex shrink-0 items-center justify-end gap-2 border-t border-border pt-4">
          {footer}
        </div>
      ) : null}
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      className={className}
      titleAccessory={titleAccessory}
      scrollBody={false}
      initialFocusRef={initialFocusRef}
      busy={busy}
    >
      {/* The <form> sits between the Modal body and the frame, so it has to pass the body's
          shrink-to-fit through rather than block it at its own natural height. */}
      {onSubmit ? (
        <form className="flex min-h-0 flex-col" onSubmit={onSubmit}>
          {frame}
        </form>
      ) : (
        frame
      )}
    </Modal>
  );
}

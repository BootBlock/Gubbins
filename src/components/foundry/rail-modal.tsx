import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Modal } from './modal';
import { resolveTabKey } from './tab-keyboard';

/**
 * A single rail tab: an icon + label in the left-hand rail, and the panel content it
 * reveals. Only the active tab's `content` is placed in the tree, so switching tabs
 * unmounts the previous panel — callers that hold in-flight state must persist it
 * outside the panel (each Gubbins editor already writes through its own store/hooks).
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
  /** Accessible name for the `role="tablist"` rail (e.g. "Settings sections"). */
  readonly railAriaLabel: string;
  /** Namespace for the generated tab/panel element ids, so two rail dialogs never collide. */
  readonly idPrefix: string;
  readonly tabs: readonly RailTab[];
  /** Optional footer pinned below the panel — e.g. a Close button, bottom-right. */
  readonly footer?: ReactNode;
  /** Which tab is selected first. Defaults to the first tab. */
  readonly initialTabId?: string;
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
  railAriaLabel,
  idPrefix,
  tabs,
  footer,
  initialTabId,
}: RailModalProps) {
  const [activeId, setActiveId] = useState(initialTabId ?? tabs[0]!.id);
  // Roving-tabindex refs for the rail buttons, so arrow-key navigation can move DOM
  // focus to the newly-selected tab (the APG automatic-activation model).
  const tabRefs = useRef(new Map<string, HTMLButtonElement | null>());

  // Guard against a stale selection if the tab set ever changes shape.
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  const select = (id: string) => {
    setActiveId(id);
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

  return (
    <Modal open={open} onClose={onClose} title={title} description={description} className={className}>
      {/* Fixed-height frame: the dialog stays the same size as you switch tabs, so the
          rail never shifts and the panel scrolls within rather than resizing (and
          re-centring) the whole modal. A trailing footer stays pinned below it. */}
      <div className="flex h-[74vh] flex-col">
        <div className="flex min-h-0 flex-1 gap-4 sm:gap-5">
          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label={railAriaLabel}
            className="flex shrink-0 flex-col gap-1"
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
                  <span className="hidden sm:inline">{tab.label}</span>
                </button>
              );
            })}
          </div>

          <div
            // Keyed on the active tab so switching sections replays the fade-through
            // entrance (`animate-swap-in`); the reduced-motion catch-all neutralises it.
            key={active.id}
            role="tabpanel"
            id={`${idPrefix}-panel-${active.id}`}
            aria-labelledby={`${idPrefix}-tab-${active.id}`}
            tabIndex={0}
            className="min-w-0 flex-1 animate-swap-in space-y-4 overflow-y-auto dialog-scroll focus-visible:outline-none"
          >
            {active.content}
          </div>
        </div>

        {footer ? (
          <div className="mt-4 flex shrink-0 items-center justify-end gap-2 border-t border-border pt-4">
            {footer}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  defaultRangeExtractor,
  measureElement as measureElementRect,
  observeElementRect,
  useVirtualizer,
} from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { ChevronDownIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { LiveRegion } from './live-region';
import {
  SELECT_FALLBACK_VIEWPORT,
  SELECT_FILTER_THRESHOLD,
  SELECT_OPTION_HEIGHT,
  SELECT_WINDOW_OVERSCAN,
  SELECT_WINDOW_THRESHOLD,
  filterSelectOptions,
  trailingActionStart,
} from './select-options';
import { useAnchoredPopover } from './use-anchored-popover';

/** One choice in a {@link Select} list. */
export interface SelectOption {
  /** The value reported to `onChange`. */
  readonly value: string;
  readonly label: string;
  /**
   * A right-aligned, dimmed hint shown after the label (e.g. `"3 items"`). A native
   * `<option>` can't render this — browsers strip layout/colour from option content —
   * which is the whole reason this control is a hand-built listbox rather than a
   * `<select>`.
   */
  readonly meta?: string;
  /**
   * Tailwind text-colour **token** class tinting the label (e.g. `text-destructive`,
   * `text-loc-teal`). Always a design token, never a raw literal — the tint is themed
   * and dark-mode-correct via the token. Colour is never the sole signal: the label
   * text always reads, keeping this within WCAG 1.4.1.
   */
  readonly colorClass?: string;
  /**
   * `'action'` marks a command row (e.g. "＋ New location…") rather than a real value.
   * It is set apart with a top divider and an accent tint so it never reads as one of
   * the ordinary options — structural separation, not colour alone, makes it
   * unmistakable even when the options span the whole hue wheel. Command rows are
   * pinned to the end of the list and always survive the filter.
   */
  readonly kind?: 'action';
}

export interface SelectProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly id?: string;
  /** Text shown on the trigger when `value` matches no option. */
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Extra classes merged onto the trigger. */
  readonly className?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
  readonly 'data-testid'?: string;
}

/**
 * Foundry Select — an accessible select-only combobox (WAI-ARIA APG "Select-Only
 * Combobox") that replaces the native `<select>` everywhere in the app. Unlike a real
 * `<select>`, each row is a custom-rendered listbox option, so it can carry a colour
 * **token** tint (e.g. a condition rendered red/green), a right-aligned metadata hint
 * (e.g. an item count) and pinned command rows ("＋ New …") — none of which a browser
 * lets you style inside a native option.
 *
 * The combobox is the single tab stop; the list is driven with the keyboard (Up/Down/
 * Home/End to move the active option, Enter/Space to choose, Escape to dismiss) via
 * `aria-activedescendant`, never moving DOM focus into the list. Escape is stopped from
 * bubbling so it closes the list rather than an enclosing Modal. It is a **controlled**
 * component — pass `value` + `onChange` (bind RHF via `<Controller>`), and name it with
 * `aria-labelledby` (or `aria-label`); {@link SelectField} wires all of that up for the
 * common labelled-field case.
 *
 * **Long lists** (issue #563). Its biggest feeder is the location picker, which is handed
 * the whole hierarchy uncapped — thousands of rows on a bin-level inventory. Two things
 * scale it:
 *
 * - From {@link SELECT_FILTER_THRESHOLD} options the trigger becomes a **filter field**
 *   while the list is open, so a row is found by typing rather than by scrolling — narrowed
 *   by the pure {@link filterSelectOptions} seam. The combobox role (and the id, ARIA and
 *   test id with it) moves onto that input for as long as it exists, so there is still
 *   exactly one combobox and it still owns `aria-activedescendant` — the contract above
 *   survives intact. Home/End and Space are left to the text field while it is filtering,
 *   since they are editing keys there; so is Tab, so that an enclosing Modal's focus trap can
 *   resolve it against the still-focused field — the field's own blur then closes the list.
 * - Past {@link SELECT_WINDOW_THRESHOLD} the ordinary options are **windowed** with
 *   `@tanstack/react-virtual` — the same virtualiser the location sidebar already windows this
 *   hierarchy with, and the same trick of flooring an unmeasured viewport and row rather than
 *   letting a zero measurement collapse the window (the figures themselves are this control's
 *   own — see `select-options.ts`). Nothing is capped: the scroll
 *   container still measures the whole list, `aria-setsize`/`aria-posinset` report its true
 *   size, and the active row is pinned into the rendered range so `aria-activedescendant`
 *   never dangles.
 *
 * The active-option highlight is keyboard-only and hover is a **CSS** state, so crossing an
 * open list with the pointer costs nothing: it neither re-renders the options nor drags
 * `aria-activedescendant` (and its screen-reader announcement) along behind the mouse.
 */
export function Select({
  value,
  onChange,
  options,
  id,
  placeholder,
  disabled = false,
  className,
  'aria-labelledby': ariaLabelledBy,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  'data-testid': testId,
}: SelectProps) {
  const t = useT();
  const reactId = useId();
  const baseId = id ?? reactId;
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const selected = options.find((option) => option.value === value);
  /** Filtering is offered only once scrolling the list is the problem, not the answer. */
  const filtering = open && !disabled && options.length >= SELECT_FILTER_THRESHOLD;
  const visible = filtering ? filterSelectOptions(options, query) : options;
  // A filter that narrows the list can strand `activeIndex` outside it — past the end, or below
  // zero once a query has matched nothing at all. Clamping on read is what keeps the highlight and
  // `aria-activedescendant` pointing at a row that exists, however the list has moved underneath.
  const active = Math.min(Math.max(0, activeIndex), Math.max(0, visible.length - 1));
  const activeId = optionId(active);

  const plainCount = trailingActionStart(visible);
  const windowed = plainCount > SELECT_WINDOW_THRESHOLD;

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The listbox is portalled out of the (clipping) dialog scroll box and positioned
  // against the trigger — see {@link useAnchoredPopover}.
  const { popoverRef, style: popoverStyle } = useAnchoredPopover(rootRef, open);

  // Only the *ordinary* options are windowed; the few pinned command rows always render.
  const virtualizer = useVirtualizer({
    count: plainCount,
    // Kept subscribed even below the threshold (where the plain branch renders instead), so a
    // filter that crosses the threshold never tears the virtualiser down in the same commit that
    // unmounts every measured row — which React flags as a re-entrant flush.
    enabled: true,
    getScrollElement: () => listRef.current,
    estimateSize: () => SELECT_OPTION_HEIGHT,
    getItemKey: (index) => visible[index]?.value ?? index,
    overscan: SELECT_WINDOW_OVERSCAN,
    // A viewport guess for the first paint, before the popover has been measured…
    initialRect: { width: 0, height: SELECT_FALLBACK_VIEWPORT },
    // …and the same floor on every later measurement — see {@link SELECT_FALLBACK_VIEWPORT}.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) =>
        cb({ width: rect.width, height: rect.height || SELECT_FALLBACK_VIEWPORT }),
      ),
    // Same floor per row: taking a zero measurement at face value collapses every row onto one
    // offset, after which the virtualiser's position lookup can land anywhere in the list.
    measureElement: (el, entry, instance) => measureElementRect(el, entry, instance) || SELECT_OPTION_HEIGHT,
    // The active option has to *exist* for `aria-activedescendant` to reference it, so it is
    // pinned into the rendered range even when the pointer has scrolled it out of the window.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (active >= plainCount || indexes.includes(active)) return indexes;
      return [...indexes, active].sort((a, b) => a - b);
    },
  });

  // Dismiss when a pointer goes down anywhere outside this control — counting the
  // portalled listbox as "inside" so choosing an option doesn't self-dismiss first.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, popoverRef]);

  // Focus follows whichever element is carrying the combobox role. The filter field only exists
  // while the list is open, so focus has to move there — and back when it goes, which it can do
  // *underneath* the focus: a refetch that drops the option count below the threshold unmounts
  // the field without ever blurring it. An open list whose focus has fallen to the body answers
  // no key at all, and its Escape reaches the enclosing Modal and closes the whole dialog. The
  // trigger box outlives both states, which is what makes handing focus back always possible.
  useLayoutEffect(() => {
    if (!open) return;
    if (filtering) filterRef.current?.focus();
    else if (!triggerRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
  }, [filtering, open]);

  // A new filter is a new list — start it at the top rather than wherever the last one was left.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query]);

  // Keep the active option in view while navigating with the keyboard. A windowed row may not be
  // in the DOM to scroll to, so the virtualiser is asked for it by index instead.
  //
  // Keyed on the *popover* rather than on `open`, because the two are a render apart: the anchored
  // position arrives in a layout effect, so on the commit where `open` flips there is no list yet
  // to scroll. Waiting for it is also what re-seats a reopened list — the virtualiser outlives the
  // popover and would otherwise still be reporting the offset the last session was left scrolled to.
  const listMounted = open && Boolean(popoverStyle);
  useEffect(() => {
    if (!listMounted || !listRef.current) return;
    if (windowed && active < plainCount) {
      virtualizer.scrollToIndex(active, { align: 'auto' });
      return;
    }
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [listMounted, active, activeId, windowed, plainCount, virtualizer]);

  const openList = (
    toIndex = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    ),
  ) => {
    setQuery('');
    setActiveIndex(toIndex);
    setOpen(true);
  };

  /** Close and hand focus back to the trigger — it never unmounts, so this needs no re-render. */
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (index: number) => {
    const option = visible[index];
    // A filter matching nothing leaves the list open rather than committing an absent choice.
    if (!option) return;
    onChange(option.value);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (open) setActiveIndex(Math.min(visible.length - 1, active + 1));
        else openList();
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (open) setActiveIndex(Math.max(0, active - 1));
        else openList();
        break;
      case 'Home':
        // While filtering these are caret keys; taking them would strand the user mid-query.
        if (open && !filtering) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (open && !filtering) {
          event.preventDefault();
          setActiveIndex(visible.length - 1);
        }
        break;
      case ' ':
        if (filtering) break; // a space is text in the filter field, not a choice
        event.preventDefault();
        if (open) choose(active);
        else openList();
        break;
      case 'Enter':
        event.preventDefault();
        if (open) choose(active);
        else openList();
        break;
      case 'Escape':
        if (!open) break;
        // Close the list — not the enclosing Modal — clearing a filter first, so Escape never
        // discards more than the user's last step.
        event.preventDefault();
        event.stopPropagation();
        if (filtering && query.length > 0) {
          setQuery('');
          setActiveIndex(0);
          break;
        }
        close();
        break;
      case 'Tab':
        // While a filter field holds the focus, Tab is left entirely alone: an enclosing Modal's
        // focus trap resolves it by looking the *focused* element up in its own tab order, so the
        // field has to still be mounted and focused when the trap runs. Closing here would
        // unmount it first — React flushes a discrete event's update before the event reaches
        // the trap's document listener — and the trap, finding nothing, would throw focus to the
        // top of the dialog. Leaving it be lets the trap move focus properly; the field's own
        // blur then closes the list.
        if (open && !filtering) setOpen(false);
        break;
    }
  };

  /** The combobox itself: the trigger box while closed, the filter field while filtering. */
  const comboboxProps = {
    id: baseId,
    role: 'combobox',
    'aria-haspopup': 'listbox',
    'aria-expanded': open,
    'aria-controls': listboxId,
    'aria-labelledby': ariaLabelledBy,
    'aria-label': ariaLabel,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'aria-activedescendant': open && visible.length > 0 ? activeId : undefined,
    'data-testid': testId,
  } as const;

  const renderOption = (option: SelectOption, index: number) => {
    const isAction = option.kind === 'action';
    const isActive = index === active;
    const isSelected = option.value === value;
    return (
      // eslint-disable-next-line jsx-a11y/interactive-supports-focus, jsx-a11y/click-events-have-key-events -- APG combobox+listbox: DOM focus stays on whichever element carries role="combobox" and tracks the list via aria-activedescendant, so options are deliberately not tab stops, and that element's onKeyDown handles selection (Enter always; Space too, except while it is a filter field and a space is text) — the option's onClick is a pointer affordance with full keyboard parity.
      <div
        key={option.value}
        id={optionId(index)}
        role="option"
        aria-selected={isSelected}
        // Only meaningful while windowing keeps most of the list out of the DOM; without them a
        // screen reader would report the window's size as the whole list.
        aria-setsize={windowed ? visible.length : undefined}
        aria-posinset={windowed ? index + 1 : undefined}
        onClick={() => choose(index)}
        className={cn(
          'flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm',
          // Hover is a pure CSS state: pointing at a row must not move the active option — which
          // would re-render every option's class, and drag a spoken announcement, per mouse move.
          isActive ? 'bg-secondary' : 'hover:bg-secondary/60',
          isSelected ? 'font-medium text-primary' : 'text-foreground',
          // A command row (e.g. "＋ New location…") is fenced off from the options
          // above it with a divider so it never reads as one of them.
          isAction && 'mt-1 border-t border-border/60 pt-2 font-medium',
        )}
      >
        <span
          className={cn('min-w-0 flex-1 truncate text-left', isAction ? 'text-accent' : option.colorClass)}
        >
          {option.label}
        </span>
        {option.meta ? <span className="shrink-0 tabular-nums text-item-count">{option.meta}</span> : null}
      </div>
    );
  };

  return (
    <div ref={rootRef} className="relative">
      {/* APG select-only combobox: the trigger is the focusable, keyboard-driven combobox — until
          a filter field takes that role over, which is why the box itself outlives both states.
          While it is filtering the box is inert chrome: the input inside is the control, and it
          carries the role, the keyboard and the focus. */}
      <div
        ref={triggerRef}
        {...(filtering
          ? {
              // Focusable only programmatically, so it never becomes a second tab stop beside the
              // field it contains. Closing restores `tabIndex={0}` in the same commit that hands
              // focus back here, so the enclosing trap finds it again on the next Tab.
              tabIndex: -1,
              // The chrome around the field is a big target — the `h-10` box is twice the height
              // of the text inside it — and pressing it must dismiss without either losing the
              // focus or reopening. Preventing the mouse-down's default keeps the field focused
              // through the press (so nothing else can claim it), and closing on the *click*
              // rather than the press is what stops the dismissal re-arming this same box's
              // open-toggle in time for that click to reopen the list and discard the query.
              onMouseDown: (event: MouseEvent<HTMLDivElement>) => event.preventDefault(),
              onClick: close,
              onKeyDown,
            }
          : {
              ...comboboxProps,
              tabIndex: disabled ? -1 : 0,
              onClick: () => {
                if (disabled) return;
                if (open) close();
                else openList();
              },
              onKeyDown,
            })}
        aria-disabled={disabled || undefined}
        className={cn(
          'flex h-10 w-full items-center gap-2 rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          // While filtering the ring belongs to the input inside, which is always the focused one.
          filtering
            ? 'border-ring ring-[3px] ring-ring/40'
            : 'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
          className,
        )}
      >
        {filtering ? (
          <input
            ref={filterRef}
            {...comboboxProps}
            type="text"
            value={query}
            autoComplete="off"
            spellCheck={false}
            aria-autocomplete="list"
            placeholder={t('select.filter')}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            // Focus leaving the field is what ends the filtering session — Tab above relies on
            // it. Nothing the user does *inside* the control blurs it: the popover swallows the
            // focus change on mouse-down, and the trigger's chrome around this field is not a
            // pointer target at all while it is here.
            onBlur={() => setOpen(false)}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        ) : (
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-left',
              selected ? selected.colorClass : 'text-muted-foreground',
            )}
          >
            {selected ? selected.label : (placeholder ?? '')}
          </span>
        )}
        {filtering ? (
          // With the box itself inert, the chevron carries the pointer affordance for closing the
          // list. Not a tab stop (the input is the one stop), and mouse-down-preventDefault so it
          // never steals focus mid-filter — the same shape {@link Autocomplete}'s toggle uses.
          // It closes on *click*, not on that mouse-down: closing early would re-arm the box's
          // toggle in time for the same press's click to reopen what it just dismissed.
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              close();
            }}
            className="-mr-1 flex size-6 shrink-0 items-center justify-center text-muted-foreground"
          >
            <ChevronDownIcon className="size-4 rotate-180 transition-transform" />
          </button>
        ) : (
          <ChevronDownIcon
            aria-hidden="true"
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        )}
      </div>

      {/* Mounted for as long as the filter is, so the match count it reports is a change to a
          region that already existed — a live region inserted with its message often goes unspoken. */}
      {filtering ? (
        <LiveRegion visuallyHidden>
          {query.length > 0 ? <p>{t('select.matches', { vars: { count: plainCount } })}</p> : null}
        </LiveRegion>
      ) : null}

      {open && popoverStyle
        ? createPortal(
            // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- this handler adds no interaction, it *suppresses* one: nothing in the popover is focusable, so a press would move focus to the body and blur the filter field, dismissing the list before the click that chose an option could land. The interactive elements are the role="option" rows below, which keep full keyboard parity via the combobox's onKeyDown.
            <div
              ref={popoverRef}
              style={popoverStyle}
              // On touch, suppressing it is the only option: the compatibility mouse events (and
              // so the blur) arrive after the pointer sequence is already over, where no
              // press-in-progress flag could still be watching. {@link Autocomplete} does the
              // same, on its options, for the same reason.
              onMouseDown={(event) => event.preventDefault()}
              className="z-[70] flex flex-col overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg animate-fade-in"
            >
              {/* Only ever a *filter* result: counted over the ordinary options and placed above
                  them, because a list whose only survivor is the pinned "＋ New location…" row has
                  still matched nothing, and saying so first is what stops that row reading as the
                  match. A genuinely empty list has nothing to report — nothing was searched. */}
              {filtering && query.length > 0 && plainCount === 0 ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">{t('select.noMatches')}</p>
              ) : null}
              <div
                ref={listRef}
                role="listbox"
                id={listboxId}
                aria-labelledby={ariaLabelledBy}
                aria-label={ariaLabel}
                className="min-h-0 flex-1 overflow-y-auto"
              >
                {windowed ? (
                  <div
                    role="presentation"
                    className="relative w-full"
                    style={{ height: virtualizer.getTotalSize() }}
                  >
                    {virtualizer.getVirtualItems().map((row) => (
                      <div
                        key={row.key}
                        role="presentation"
                        data-index={row.index}
                        ref={virtualizer.measureElement}
                        className="absolute left-0 top-0 w-full"
                        style={{ transform: `translateY(${row.start}px)` }}
                      >
                        {renderOption(visible[row.index]!, row.index)}
                      </div>
                    ))}
                  </div>
                ) : (
                  visible.slice(0, plainCount).map((option, index) => renderOption(option, index))
                )}
                {visible.slice(plainCount).map((option, index) => renderOption(option, plainCount + index))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

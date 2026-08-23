import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { TEXT_LIMITS } from '@/lib/text-limits';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { ChevronDownIcon } from '@/components/icons';
import { fieldAria } from './field-aria';
import { browseStartIndex, filterSuggestions } from './autocomplete-filter';
import { InfoHint } from './info-hint';
import { TextLimitReport, useTextLimit, useTextLimitSlot } from './text-limit';
import { useAnchoredPopover } from './use-anchored-popover';

export interface AutocompleteProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The full candidate list; filtered against the typed value as the user types. */
  readonly suggestions: readonly string[];
  readonly id?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  /**
   * Max suggestions the **type-ahead** offers as the user types. Browsing the list (the
   * chevron, or ArrowDown on a closed list) is not a type-ahead and shows the whole
   * catalogue, scrolling; only a {@link AutocompleteProps.prefiltered} list keeps the cap
   * there, because it is all its supplier search returned in the first place.
   */
  readonly maxOptions?: number;
  /**
   * The suggestions have **already** been narrowed against the typed text by whoever supplied
   * them — a server-side search, typically — so the built-in {@link filterSuggestions} ranking
   * must not narrow them a second time. Without this, a supplier the database matched on its
   * folded name key (`RS Comp` → `RS-Components`) is dropped by the literal substring test here
   * and the popup comes up empty for a term that genuinely matched.
   *
   * The cap still applies; only the filtering is skipped. Leave it off for the ordinary case,
   * where the caller hands over a whole candidate list and this control does the narrowing.
   */
  readonly prefiltered?: boolean;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
  readonly 'data-testid'?: string;
  readonly inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  readonly maxLength?: number;
  readonly autoComplete?: string;
  /** Fires on blur, mirroring a plain input so RHF `register`-style callers stay happy. */
  readonly onBlur?: () => void;
  /**
   * Opt-in "creatable" behaviour: fires when the user *accepts* a value — Enter (on the
   * highlighted option, or on the typed text when nothing is highlighted) or choosing an
   * option with the pointer. Turns the combobox into a repeated-entry control, where each
   * accepted value is consumed by the caller rather than left in the field (the tag editor).
   *
   * When provided, Enter is always swallowed (it commits rather than submitting the enclosing
   * form) and the list closes. Omit it for the plain single-value case, where the field simply
   * holds the value and Enter falls through to submit.
   */
  readonly onCommit?: (value: string) => void;
}

/**
 * Foundry Autocomplete — an accessible **editable** combobox with list autocompletion
 * (WAI-ARIA APG "Combobox with List Autocomplete, editable"). Unlike {@link Select} (which
 * is select-only, one of a fixed set), this is a real free-text `<input>` that *also* offers
 * a filtered list of suggestions: the value is never constrained to the list, so it suits
 * fields like Manufacturer or Supplier where the user should be able to type anything but
 * usually wants one of the values already in the catalogue.
 *
 * Opening the list and completing against it are separate acts. The chevron (and ArrowDown on
 * a closed list) *browses*: it shows the whole catalogue, starting on the value the field
 * already holds, exactly as a `<select>` would. Only typing narrows the list, and it narrows
 * against everything the field then contains.
 *
 * The input is the single tab stop and keeps DOM focus throughout; the highlighted option is
 * tracked with `aria-activedescendant`, never by moving focus into the list. Down/Up move the
 * active option (opening the list first if closed), Enter accepts the highlighted option (and
 * only then swallows the keypress, so Enter with nothing highlighted still submits the form),
 * and Escape closes the list without clearing the field — its propagation is stopped so it
 * dismisses the list rather than an enclosing Modal. It is a **controlled** component: pass
 * `value` + `onChange`, and name it with `aria-label(ledby)`; {@link AutocompleteField} wires
 * the labelled-field case (implicit `<label>`, hint badge, error) exactly like FormField.
 */
export const Autocomplete = forwardRef<HTMLInputElement, AutocompleteProps>(function Autocomplete(
  {
    value,
    onChange,
    suggestions,
    id,
    placeholder,
    disabled = false,
    className,
    maxOptions = 10,
    prefiltered = false,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'data-testid': testId,
    inputMode,
    maxLength,
    autoComplete = 'off',
    onBlur,
    onCommit,
  },
  forwardedRef,
) {
  const reactId = useId();
  const baseId = id ?? reactId;
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const [open, setOpen] = useState(false);
  // Opened to *browse* rather than to complete: the whole list stands until the user types.
  // Filtering an already-filled field on open is what made the chevron look dead — a field
  // holding `Asus` filtered down to the one exact match, which `filterSuggestions` then drops
  // as having nothing left to complete, leaving an empty popup that never rendered (#414).
  const [browsing, setBrowsing] = useState(false);
  // -1 = "no option highlighted": the typed text stands, and Enter falls through to submit.
  const [activeIndex, setActiveIndex] = useState(-1);

  // How full the box is (issue #346). `maxLength` below is a *native* cap and only ever set
  // for a fixed-format code (a three-letter currency), so where one is declared the box cannot
  // reach this and the report stays inert; a free-text type-ahead takes the ordinary one-line
  // tier and reports the way every other text field does.
  const { over, attach } = useTextLimit<HTMLInputElement>(maxLength ?? TEXT_LIMITS.line);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

  // What browsing offers: everything, bar a prefiltered list's server-side cap.
  const browseList = prefiltered ? suggestions.slice(0, maxOptions) : suggestions;
  const matches: readonly string[] =
    browsing || prefiltered ? browseList : filterSuggestions(suggestions, value, maxOptions);
  const isOpen = open && matches.length > 0;
  // The listbox is portalled out of the (clipping) dialog scroll box and positioned
  // against the field — see {@link useAnchoredPopover}.
  const { popoverRef, style: popoverStyle } = useAnchoredPopover(rootRef, isOpen);

  // Dismiss when a pointer goes down anywhere outside this control — counting the
  // portalled listbox as "inside" so choosing an option doesn't self-dismiss first.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
        setBrowsing(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, popoverRef]);

  // Keep the active option in view while navigating with the keyboard.
  useEffect(() => {
    if (isOpen && activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, activeIndex]);

  const setRef = (el: HTMLInputElement | null) => {
    inputRef.current = el;
    attach(el);
    if (typeof forwardedRef === 'function') forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  /**
   * Open the list to browse the whole catalogue, highlighting `startIndex` (`-1` for nothing).
   *
   * Which index that is belongs to the gesture. Asking for the list — the chevron, ArrowDown —
   * starts on the value the field already holds, so a long catalogue opens showing it; a click
   * that merely places the caret in the input starts on nothing, because a highlighted option
   * makes Enter *pick* it instead of submitting the enclosing form.
   */
  const openBrowsing = (startIndex: number) => {
    setOpen(true);
    setBrowsing(true);
    setActiveIndex(startIndex);
  };

  const close = () => {
    setOpen(false);
    setBrowsing(false);
    setActiveIndex(-1);
  };

  const choose = (index: number) => {
    const match = matches[index];
    // In creatable mode the caller consumes the accepted value (and typically clears the
    // field); otherwise the value simply becomes the field's contents.
    if (match !== undefined) (onCommit ?? onChange)(match);
    close();
    inputRef.current?.focus();
  };

  /** Creatable mode: accept whatever is highlighted, else the typed text. */
  const commitTyped = () => {
    const typed = value.trim();
    if (typed.length > 0) onCommit?.(typed);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (isOpen) setActiveIndex((i) => Math.min(matches.length - 1, i + 1));
        // ArrowDown must always land on an option, so the top of the list stands in when
        // nothing in it fits what the field holds.
        else openBrowsing(Math.max(0, browseStartIndex(browseList, value)));
        break;
      case 'ArrowUp':
        if (!isOpen) break;
        event.preventDefault();
        setActiveIndex((i) => (i <= 0 ? matches.length - 1 : i - 1));
        break;
      case 'Home':
        if (isOpen && activeIndex >= 0) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (isOpen && activeIndex >= 0) {
          event.preventDefault();
          setActiveIndex(matches.length - 1);
        }
        break;
      case 'Enter':
        // Only swallow Enter when it actually accepts a highlighted option; otherwise let it
        // fall through so the enclosing form still submits on Enter. In creatable mode Enter
        // always accepts (the highlighted option, or the typed text), so it is always swallowed.
        if (isOpen && activeIndex >= 0) {
          event.preventDefault();
          choose(activeIndex);
        } else if (onCommit) {
          event.preventDefault();
          commitTyped();
        }
        break;
      case 'Escape':
        if (open) {
          // Close the list — not the enclosing Modal — and keep the typed value.
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        break;
      case 'Tab':
        close();
        break;
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={setRef}
        id={baseId}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-activedescendant={isOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        // Never downgrades an invalidity the field around it injected.
        aria-invalid={ariaInvalid === true || over || undefined}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        data-testid={testId}
        onChange={(event) => {
          onChange(event.target.value);
          // Typing turns the browse back into a type-ahead — this is the only thing that does.
          setOpen(true);
          setBrowsing(false);
          setActiveIndex(-1);
        }}
        // Open on click/tap (not merely on focus — Tabbing *through* a field shouldn't pop a
        // list); typing and ArrowDown open it too. A click browses; it never filters.
        onClick={() => {
          // `isOpen`, not `open`: text matching nothing leaves the latch set with no list on
          // screen, and a click there must still open the browse rather than read as a no-op.
          if (!isOpen) openBrowsing(-1);
        }}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        className={cn(
          'h-10 w-full rounded-lg border border-border bg-input/40 pl-3 pr-9 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      />
      {/* Open/close affordance. Not a tab stop (the input is the one stop); it only mirrors the
          native <select> chevron so the field reads as "has a list". */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        // onMouseDown + preventDefault so focus stays on the input (no blur/refocus churn) and
        // the toggle is the only effect — a plain onClick would let focus move to the button.
        onMouseDown={(event) => {
          if (disabled) return;
          event.preventDefault();
          // Toggles what the user can see — see the input's onClick for why not `open`.
          if (isOpen) close();
          else openBrowsing(browseStartIndex(browseList, value));
          inputRef.current?.focus();
        }}
        className="absolute right-0 top-0 flex h-10 w-9 items-center justify-center text-muted-foreground disabled:opacity-50"
      >
        <ChevronDownIcon className={cn('size-4 transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen && popoverStyle
        ? createPortal(
            <div
              ref={popoverRef}
              role="listbox"
              id={listboxId}
              aria-label={ariaLabel}
              aria-labelledby={ariaLabelledBy}
              style={popoverStyle}
              className="z-[70] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg animate-fade-in"
            >
              {matches.map((match, index) => (
                // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- APG editable combobox: focus intentionally stays on the input via aria-activedescendant, so options are deliberately not tab stops; the input's onKeyDown provides full keyboard parity and onMouseDown is a pointer affordance only.
                <div
                  key={match}
                  ref={(el) => {
                    optionRefs.current[index] = el;
                  }}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  // onMouseDown (not onClick) so the choice lands before the input's blur closes
                  // the list; preventDefault keeps focus on the input through the selection.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(index);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    'cursor-pointer truncate rounded-md px-2 py-1.5 text-sm text-foreground',
                    index === activeIndex && 'bg-secondary',
                  )}
                >
                  {match}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});

export interface AutocompleteFieldProps {
  readonly label: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly suggestions: readonly string[];
  /** Validation message; when present the control is marked invalid and this is announced. */
  readonly error?: string;
  /** Optional rich-Markdown help, surfaced via an {@link InfoHint} `i` badge (like FormField). */
  readonly hint?: string;
  readonly className?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly maxOptions?: number;
  /** See {@link AutocompleteProps.prefiltered} — for a server-searched suggestion list. */
  readonly prefiltered?: boolean;
  readonly inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  readonly maxLength?: number;
  /** Forwarded to the underlying input (mirrors {@link AutocompleteFieldProps.inputRef}). */
  readonly inputRef?: React.Ref<HTMLInputElement>;
  /** Opt-in creatable behaviour — see {@link AutocompleteProps.onCommit}. */
  readonly onCommit?: (value: string) => void;
  readonly 'data-testid'?: string;
}

/**
 * A labelled {@link Autocomplete} — the type-ahead counterpart to {@link FormField}. The
 * combobox is a real `<input>`, so it is named by an **explicit** `<label htmlFor>` (rather
 * than wrapping it, which would nest the popup toggle button inside the label). The hint badge
 * and the announced error are wired identically to FormField, via the pure {@link fieldAria}
 * seam.
 */
export function AutocompleteField({
  label,
  value,
  onChange,
  suggestions,
  error,
  hint,
  className,
  placeholder,
  disabled,
  id,
  maxOptions,
  prefiltered,
  inputMode,
  maxLength,
  inputRef,
  onCommit,
  'data-testid': testId,
}: AutocompleteFieldProps) {
  const reactId = useId();
  const baseId = id ?? reactId;
  // Same arrangement as FormField's: the combobox reports how full it is, and this draws the
  // countdown and the over-long sentence from it. See `text-limit.ts`.
  const { report, tooLong, remaining } = useTextLimitSlot();
  const { controlProps, errorId, hasError } = fieldAria(baseId, error ?? tooLong);
  return (
    <div className={cn('relative', className)}>
      <label htmlFor={baseId} className={cn('mb-field-gap block text-sm font-medium', hint && 'pr-6')}>
        {label}
      </label>
      <TextLimitReport.Provider value={report}>
        <Autocomplete
          ref={inputRef}
          id={baseId}
          value={value}
          onChange={onChange}
          suggestions={suggestions}
          placeholder={placeholder}
          disabled={disabled}
          maxOptions={maxOptions}
          prefiltered={prefiltered}
          inputMode={inputMode}
          maxLength={maxLength}
          onCommit={onCommit}
          aria-invalid={controlProps['aria-invalid']}
          aria-describedby={controlProps['aria-describedby']}
          data-testid={testId}
        />
      </TextLimitReport.Provider>
      {hint ? (
        <span className="absolute right-0 top-0.5">
          <InfoHint content={hint} />
        </span>
      ) : null}
      {hasError ? (
        <span id={errorId} role="alert" className="mt-1 block text-xs text-destructive">
          {error ?? tooLong}
        </span>
      ) : null}
      {remaining ? (
        // Aria-hidden for the same reason as FormField's: a count that changes with every
        // keystroke would talk over the typing rather than help it.
        <span aria-hidden className="mt-1 block text-right text-xs tabular-nums text-muted-foreground">
          {remaining}
        </span>
      ) : null}
    </div>
  );
}

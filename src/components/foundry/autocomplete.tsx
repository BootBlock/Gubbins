import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDownIcon } from '@/components/icons';
import { fieldAria } from './field-aria';
import { filterSuggestions } from './autocomplete-filter';
import { InfoHint } from './info-hint';

export interface AutocompleteProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The full candidate list; filtered against the typed value as the user types. */
  readonly suggestions: readonly string[];
  readonly id?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  /** Max suggestions shown at once (the popup scrolls beyond this). */
  readonly maxOptions?: number;
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
}

/**
 * Foundry Autocomplete — an accessible **editable** combobox with list autocompletion
 * (WAI-ARIA APG "Combobox with List Autocomplete, editable"). Unlike {@link Select} (which
 * is select-only, one of a fixed set), this is a real free-text `<input>` that *also* offers
 * a filtered list of suggestions: the value is never constrained to the list, so it suits
 * fields like Manufacturer or Supplier where the user should be able to type anything but
 * usually wants one of the values already in the catalogue.
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
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'data-testid': testId,
    inputMode,
    maxLength,
    autoComplete = 'off',
    onBlur,
  },
  forwardedRef,
) {
  const reactId = useId();
  const baseId = id ?? reactId;
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const [open, setOpen] = useState(false);
  // -1 = "no option highlighted": the typed text stands, and Enter falls through to submit.
  const [activeIndex, setActiveIndex] = useState(-1);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

  const matches = filterSuggestions(suggestions, value, maxOptions);
  const isOpen = open && matches.length > 0;

  // Dismiss when a pointer goes down anywhere outside this control.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Keep the active option in view while navigating with the keyboard.
  useEffect(() => {
    if (isOpen && activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, activeIndex]);

  const setRef = (el: HTMLInputElement | null) => {
    inputRef.current = el;
    if (typeof forwardedRef === 'function') forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  const choose = (index: number) => {
    const match = matches[index];
    if (match !== undefined) onChange(match);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (isOpen) setActiveIndex((i) => Math.min(matches.length - 1, i + 1));
        else {
          setOpen(true);
          setActiveIndex(0);
        }
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
        // fall through so the enclosing form still submits on Enter.
        if (isOpen && activeIndex >= 0) {
          event.preventDefault();
          choose(activeIndex);
        }
        break;
      case 'Escape':
        if (open) {
          // Close the list — not the enclosing Modal — and keep the typed value.
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setActiveIndex(-1);
        }
        break;
      case 'Tab':
        setOpen(false);
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
        aria-invalid={ariaInvalid}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        data-testid={testId}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        // Open on click/tap (not merely on focus — Tabbing *through* a field shouldn't pop a
        // list); typing and ArrowDown open it too.
        onClick={() => setOpen(true)}
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
          setOpen((wasOpen) => !wasOpen);
          setActiveIndex(-1);
          inputRef.current?.focus();
        }}
        className="absolute right-0 top-0 flex h-10 w-9 items-center justify-center text-muted-foreground disabled:opacity-50"
      >
        <ChevronDownIcon className={cn('size-4 transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen ? (
        <div
          role="listbox"
          id={listboxId}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg animate-fade-in"
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
        </div>
      ) : null}
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
  readonly inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  readonly maxLength?: number;
  /** Forwarded to the underlying input (mirrors {@link AutocompleteFieldProps.inputRef}). */
  readonly inputRef?: React.Ref<HTMLInputElement>;
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
  inputMode,
  maxLength,
  inputRef,
  'data-testid': testId,
}: AutocompleteFieldProps) {
  const reactId = useId();
  const baseId = id ?? reactId;
  const { controlProps, errorId, hasError } = fieldAria(baseId, error);
  return (
    <div className={cn('relative', className)}>
      <label htmlFor={baseId} className={cn('mb-field-gap block text-sm font-medium', hint && 'pr-6')}>
        {label}
      </label>
      <Autocomplete
        ref={inputRef}
        id={baseId}
        value={value}
        onChange={onChange}
        suggestions={suggestions}
        placeholder={placeholder}
        disabled={disabled}
        maxOptions={maxOptions}
        inputMode={inputMode}
        maxLength={maxLength}
        aria-invalid={controlProps['aria-invalid']}
        aria-describedby={controlProps['aria-describedby']}
        data-testid={testId}
      />
      {hint ? (
        <span className="absolute right-0 top-0.5">
          <InfoHint content={hint} />
        </span>
      ) : null}
      {hasError ? (
        <span id={errorId} role="alert" className="mt-1 block text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

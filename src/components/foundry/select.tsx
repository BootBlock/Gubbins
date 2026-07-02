import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDownIcon } from '@/components/icons';
import { fieldAria } from './field-aria';
import { InfoHint } from './info-hint';

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
   * unmistakable even when the options span the whole hue wheel.
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
 * The combobox itself is the single tab stop; once focused the list is driven with the
 * keyboard (Up/Down/Home/End to move the active option, Enter/Space to choose, Escape
 * to dismiss) via `aria-activedescendant`, never moving DOM focus into the list.
 * Escape is stopped from bubbling so it closes the list rather than an enclosing Modal.
 * It is a **controlled** component — pass `value` + `onChange` (bind RHF via
 * `<Controller>`), and name it with `aria-labelledby` (or `aria-label`); {@link
 * SelectField} wires all of that up for the common labelled-field case.
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
  const reactId = useId();
  const baseId = id ?? reactId;
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const [activeIndex, setActiveIndex] = useState(Math.max(0, selectedIndex));

  const rootRef = useRef<HTMLDivElement>(null);
  const comboRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

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
    if (open) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const openList = (toIndex = Math.max(0, selectedIndex)) => {
    setActiveIndex(toIndex);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    comboRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (open) setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        else openList();
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (open) setActiveIndex((i) => Math.max(0, i - 1));
        else openList();
        break;
      case 'Home':
        if (open) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (open) {
          event.preventDefault();
          setActiveIndex(options.length - 1);
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) choose(activeIndex);
        else openList();
        break;
      case 'Escape':
        if (open) {
          // Close the list — not the enclosing Modal.
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
        break;
      case 'Tab':
        if (open) setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className="relative">
      {/* APG select-only combobox: the role="combobox" element is intentionally the focusable, keyboard-driven trigger. */}
      <div
        ref={comboRef}
        id={baseId}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-labelledby={ariaLabelledBy}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-disabled={disabled || undefined}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        data-testid={testId}
        onClick={() => {
          if (disabled) return;
          if (open) setOpen(false);
          else openList();
        }}
        onKeyDown={onKeyDown}
        className={cn(
          'flex h-10 w-full items-center gap-2 rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
          className,
        )}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-left',
            selected ? selected.colorClass : 'text-muted-foreground',
          )}
        >
          {selected ? selected.label : (placeholder ?? '')}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </div>

      {open ? (
        <div
          role="listbox"
          id={listboxId}
          aria-labelledby={ariaLabelledBy}
          aria-label={ariaLabel}
          className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg animate-fade-in"
        >
          {options.map((option, index) => {
            const isAction = option.kind === 'action';
            return (
              // eslint-disable-next-line jsx-a11y/interactive-supports-focus, jsx-a11y/click-events-have-key-events -- APG combobox+listbox: focus stays on the role="combobox" trigger via aria-activedescendant, so options are deliberately not tab stops, and the combobox's onKeyDown handles Enter/Space selection — the option's onClick is a pointer affordance with full keyboard parity.
              <div
                key={option.value}
                ref={(el) => {
                  optionRefs.current[index] = el;
                }}
                id={optionId(index)}
                role="option"
                aria-selected={index === selectedIndex}
                onClick={() => choose(index)}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm',
                  index === activeIndex && 'bg-secondary',
                  index === selectedIndex ? 'font-medium text-primary' : 'text-foreground',
                  // A command row (e.g. "＋ New location…") is fenced off from the options
                  // above it with a divider so it never reads as one of them.
                  isAction && 'mt-1 border-t border-border/60 pt-2 font-medium',
                )}
              >
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-left',
                    isAction ? 'text-accent' : option.colorClass,
                  )}
                >
                  {option.label}
                </span>
                {option.meta ? (
                  <span className="shrink-0 tabular-nums text-item-count">{option.meta}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export interface SelectFieldProps {
  readonly label: ReactNode;
  readonly options: readonly SelectOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Validation message; when present the control is marked invalid and this is announced. */
  readonly error?: string;
  /** Optional rich-Markdown help, surfaced via an {@link InfoHint} `i` badge (like {@link FormField}). */
  readonly hint?: string;
  readonly className?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'data-testid'?: string;
}

/**
 * A labelled {@link Select} — the combobox counterpart to {@link FormField}. Because a
 * `role="combobox"` element is not a labelable form control, an implicit `<label>` can't
 * name it; instead the label is a `<span>` with an id and the combobox references it via
 * `aria-labelledby` (the same idiom the location picker uses). Validation errors are
 * wired for assistive tech exactly as FormField does, via the pure {@link fieldAria} seam.
 */
export function SelectField({
  label,
  options,
  value,
  onChange,
  error,
  hint,
  className,
  placeholder,
  disabled,
  id,
  'data-testid': testId,
}: SelectFieldProps) {
  const reactId = useId();
  const baseId = id ?? reactId;
  const labelId = `${baseId}-label`;
  const { controlProps, errorId, hasError } = fieldAria(baseId, error);
  return (
    <div className={cn('relative', className)}>
      <span id={labelId} className={cn('mb-field-gap block text-sm font-medium', hint && 'pr-6')}>
        {label}
      </span>
      <Select
        id={baseId}
        value={value}
        onChange={onChange}
        options={options}
        placeholder={placeholder}
        disabled={disabled}
        aria-labelledby={labelId}
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

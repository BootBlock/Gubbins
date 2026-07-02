import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDownIcon } from '@/components/icons';

/** One choice in the {@link LocationSelect} list. */
export interface LocationOption {
  /** The value reported to `onChange` (`''` is the synthetic "top level"). */
  readonly value: string;
  readonly label: string;
  /**
   * A right-aligned, dimmed hint shown after the label (e.g. `"3 items"`). The
   * native `<option>` can't render this — browsers strip layout/colour from option
   * content — which is the whole reason this control is a hand-built listbox.
   */
  readonly meta?: string;
  /** Tailwind text-colour class tinting the label (the location's swatch), if any. */
  readonly colorClass?: string;
  /**
   * `'action'` marks a command row (e.g. "＋ New location…") rather than a real
   * location. It is set apart with a top divider and an accent tint so it never reads
   * as one of the locations — location swatches span the whole hue wheel, so structural
   * separation, not colour alone, is what makes it unmistakable.
   */
  readonly kind?: 'action';
}

/**
 * An accessible select-only combobox (WAI-ARIA APG "Select-Only Combobox") used for
 * the location **Parent** picker. Unlike a native `<select>`, each row can render a
 * two-column layout — the location name on the left and a right-aligned, dimmed item
 * count on the right — which a real `<option>` cannot.
 *
 * The combobox itself is the single tab stop; once focused the list is driven with
 * the keyboard (Up/Down/Home/End to move the active option, Enter/Space to choose,
 * Escape to dismiss) via `aria-activedescendant`, never moving DOM focus into the
 * list. Escape is stopped from bubbling so it closes the list rather than the
 * enclosing Modal. Naming is by `aria-labelledby` so the field's `<span>` label still
 * associates (and `getByLabel` keeps working in tests).
 */
export function LocationSelect({
  value,
  onChange,
  options,
  labelledBy,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly LocationOption[];
  /** Id of the visible label element naming this control. */
  labelledBy: string;
  id?: string;
}) {
  const reactId = useId();
  const baseId = id ?? reactId;
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const [open, setOpen] = useState(false);
  // The chosen row (defaults to the first — the "top level" entry — if value is unknown).
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  const rootRef = useRef<HTMLDivElement>(null);
  const comboRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

  const selected = options[selectedIndex];

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

  const openList = (toIndex = selectedIndex) => {
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
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- APG select-only combobox: the role="combobox" element is intentionally the focusable, keyboard-driven trigger. */}
      <div
        ref={comboRef}
        id={baseId}
        role="combobox"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-labelledby={labelledBy}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={cn(
          'flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate text-left', selected?.colorClass)}>
          {selected?.label}
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
          aria-labelledby={labelledBy}
          className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg animate-fade-in"
        >
          {options.map((option, index) => {
            const isAction = option.kind === 'action';
            return (
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
                  // A command row (e.g. "＋ New location…") is fenced off from the location
                  // list above it with a divider so it never reads as one of the locations.
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

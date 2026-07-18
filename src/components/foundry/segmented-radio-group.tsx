import { cn } from '@/lib/utils';
import { useRovingRadioGroup } from './useRovingRadioGroup';

/** One choice in a {@link SegmentedRadioGroup}. */
export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * A compact, accessible **segmented control** — a WAI-ARIA `radiogroup` rendered as a row
 * of joined buttons, for a small fixed set of mutually-exclusive choices where the options
 * are worth showing at a glance rather than hiding behind a `Select`.
 *
 * The group is a single tab stop (roving `tabindex`); once focused, the arrow keys move
 * *and* select, and Home/End jump to the ends. Presentation only — the caller owns the
 * value and decides what a choice reveals or persists.
 *
 * `testIdPrefix` yields a stable `data-testid` of `` `${testIdPrefix}-${option.value}` ``
 * per segment, so callers get addressable options without hand-rolling the attribute.
 */
export function SegmentedRadioGroup<T extends string>({
  options,
  value,
  onChange,
  labelledBy,
  label,
  testIdPrefix,
  className,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Id of the visible label naming this group; takes precedence over {@link label}. */
  labelledBy?: string;
  /** Accessible name used when there is no visible label to point at. */
  label?: string;
  testIdPrefix?: string;
  className?: string;
}) {
  // An unrecognised value (a stale draft, a value from a sync peer) falls back to the first
  // option rather than leaving the group with no tab stop at all.
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const { refs, selectAt, onKeyDown } = useRovingRadioGroup<HTMLButtonElement>({
    count: options.length,
    onSelect: (index) => {
      const option = options[index];
      if (option) onChange(option.value);
    },
  });

  return (
    <div
      role="radiogroup"
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : label ? { 'aria-label': label } : {})}
      className={cn('inline-flex rounded-lg border border-border bg-secondary/40 p-0.5', className)}
    >
      {options.map((option, index) => {
        const checked = index === selectedIndex;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => selectAt(index)}
            onKeyDown={(e) => onKeyDown(e, index)}
            {...(testIdPrefix ? { 'data-testid': `${testIdPrefix}-${option.value}` } : {})}
            className={cn(
              'rounded-md px-3 py-1 text-sm font-medium outline-none transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              checked
                ? 'bg-card-elevated text-foreground shadow-sm ring-1 ring-border'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

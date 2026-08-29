import { cn } from '@/lib/utils';
import { useRovingRadioGroup } from './useRovingRadioGroup';
import { useSlidingIndicator } from './use-sliding-indicator';

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
 *
 * The selection is drawn as a single pill that **slides** between the segments rather than
 * being repainted on whichever segment is current (issue #449), so the change of choice is
 * something the eye can follow. Where the control has not been laid out (jsdom, a collapsed
 * panel) the measurement yields nothing and the selected segment paints its own background
 * instead, so the control is never left with no visible selection.
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

  const indicator = useSlidingIndicator<HTMLButtonElement>(selectedIndex, options.length);

  const { refs, selectAt, onKeyDown } = useRovingRadioGroup<HTMLButtonElement>({
    count: options.length,
    onSelect: (index) => {
      const option = options[index];
      if (option) onChange(option.value);
    },
  });

  return (
    <div
      ref={indicator.containerRef}
      role="radiogroup"
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : label ? { 'aria-label': label } : {})}
      className={cn('relative inline-flex rounded-lg border border-border bg-secondary/40 p-0.5', className)}
    >
      {indicator.geometry ? (
        <span
          aria-hidden="true"
          className={cn(
            'gubbins-sliding-indicator absolute inset-y-0.5 left-0 rounded-md bg-card-elevated shadow-sm ring-1 ring-border',
            indicator.settled && 'is-settled',
          )}
          style={{
            width: `${indicator.geometry.width}px`,
            transform: `translateX(${indicator.geometry.left}px)`,
          }}
        />
      ) : null}
      {options.map((option, index) => {
        const checked = index === selectedIndex;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
              indicator.registerOption(index)(el);
            }}
            type="button"
            role="radio"
            // A radio nested inside a <label> (a FormField's, say) takes its accessible name
            // from that label, not from its own text — every segment would then answer to the
            // field's name and none to its own. The explicit label is what keeps them distinct.
            aria-label={option.label}
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => selectAt(index)}
            onKeyDown={(e) => onKeyDown(e, index)}
            {...(testIdPrefix ? { 'data-testid': `${testIdPrefix}-${option.value}` } : {})}
            className={cn(
              'relative rounded-md px-3 py-1 text-sm font-medium outline-none transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              checked ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              // Fallback for an unmeasured control: without the pill, the selected segment
              // still has to look selected.
              checked && !indicator.geometry && 'bg-card-elevated shadow-sm ring-1 ring-border',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

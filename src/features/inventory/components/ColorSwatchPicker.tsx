import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import {
  LOCATION_COLORS,
  locationColorLabel,
  locationColorSwatchClass,
  type LocationColor,
} from '../location-color';

/** `null` = the "No colour" choice (standard text colour); else a swatch key. */
type Choice = LocationColor | null;

// The "No colour" swatch leads, then the palette — the order the radios appear in.
const CHOICES: readonly Choice[] = [null, ...LOCATION_COLORS];

/**
 * An accessible single-select colour swatch picker (WAI-ARIA radiogroup) for a
 * location's optional tint. The group is a single tab stop (roving `tabindex`); once
 * focused, the arrow keys move *and* select (standard radiogroup behaviour), Home/End
 * jump to the ends, and Space/Enter re-affirm the focused swatch. The leading swatch is
 * "No colour" (the default — standard text colour).
 */
export function ColorSwatchPicker({
  value,
  onChange,
  labelledBy,
}: {
  value: Choice;
  onChange: (color: Choice) => void;
  /** Id of the visible label element naming this group. */
  labelledBy: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = Math.max(
    0,
    CHOICES.findIndex((c) => c === value),
  );

  const selectAt = (index: number) => {
    const next = ((index % CHOICES.length) + CHOICES.length) % CHOICES.length;
    onChange(CHOICES[next]!);
    refs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        selectAt(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        selectAt(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        selectAt(0);
        break;
      case 'End':
        event.preventDefault();
        selectAt(CHOICES.length - 1);
        break;
      case ' ':
      case 'Enter':
        event.preventDefault();
        selectAt(index);
        break;
    }
  };

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
      {CHOICES.map((choice, index) => {
        const checked = index === selectedIndex;
        const label = choice === null ? 'No colour' : locationColorLabel(choice);
        return (
          <button
            key={choice ?? '__none__'}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            tabIndex={checked ? 0 : -1}
            onClick={() => selectAt(index)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              'size-7 rounded-full outline-none transition-transform',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              checked && 'ring-2 ring-foreground/70 ring-offset-2 ring-offset-background scale-110',
              choice === null
                ? 'border-2 border-dashed border-muted-foreground/60 bg-card'
                : locationColorSwatchClass(choice),
            )}
          />
        );
      })}
    </div>
  );
}

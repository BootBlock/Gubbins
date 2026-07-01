import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { FolderIcon } from '@/components/icons';
import { LOCATION_KINDS, locationKindLabel, type LocationKind } from '../location-kind';
import { LocationKindIcon } from './LocationKindIcon';

/** `null` = the "No type" choice (generic folder icon); else a type key. */
type Choice = LocationKind | null;

// The "No type" choice leads, then the palette of types — the order the radios appear in.
const CHOICES: readonly Choice[] = [null, ...LOCATION_KINDS];

/**
 * An accessible single-select type picker (WAI-ARIA radiogroup) for a location's optional
 * physical type — the icon counterpart to {@link ColorSwatchPicker}. The group is a single
 * tab stop (roving `tabindex`); once focused, the arrow keys move *and* select, Home/End jump
 * to the ends, and Space/Enter re-affirm the focused type. The leading choice is "No type"
 * (the generic folder icon).
 */
export function LocationKindPicker({
  value,
  onChange,
  labelledBy,
}: {
  value: Choice;
  onChange: (kind: Choice) => void;
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
        const label = choice === null ? 'No type' : (locationKindLabel(choice) ?? choice);
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
              'grid size-8 place-items-center rounded-lg border outline-none transition-transform [&_svg]:size-4',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              checked
                ? 'border-primary bg-primary/15 text-primary scale-110'
                : 'border-border text-muted-foreground hover:bg-secondary/60',
            )}
          >
            {choice === null ? <FolderIcon aria-hidden /> : <LocationKindIcon kind={choice} />}
          </button>
        );
      })}
    </div>
  );
}

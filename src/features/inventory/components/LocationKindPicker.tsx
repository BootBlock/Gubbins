import { cn } from '@/lib/utils';
import { optionCardClassName, Tooltip, useRovingRadioGroup } from '@/components/foundry';
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
  const selectedIndex = Math.max(
    0,
    CHOICES.findIndex((c) => c === value),
  );

  const { refs, selectAt, onKeyDown } = useRovingRadioGroup<HTMLButtonElement>({
    count: CHOICES.length,
    onSelect: (index) => onChange(CHOICES[index]!),
  });

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
      {CHOICES.map((choice, index) => {
        const checked = index === selectedIndex;
        const label = choice === null ? 'No type' : (locationKindLabel(choice) ?? choice);
        return (
          // Foundry Tooltip (rich Markdown) replaces the browser `title`; `triggerTabIndex={-1}`
          // keeps the roving radiogroup as the single tab stop while focus still bubbles so the
          // type name shows on keyboard focus. The accessible name stays on the button (aria-label).
          <Tooltip key={choice ?? '__none__'} content={label} triggerTabIndex={-1}>
            <button
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={label}
              tabIndex={checked ? 0 : -1}
              onClick={() => selectAt(index)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                'grid size-8 place-items-center [&_svg]:size-4',
                optionCardClassName(checked, 'swatch'),
                checked ? 'text-primary scale-110' : 'text-muted-foreground',
              )}
            >
              {choice === null ? <FolderIcon aria-hidden /> : <LocationKindIcon kind={choice} />}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

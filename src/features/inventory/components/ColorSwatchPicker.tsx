import { cn } from '@/lib/utils';
import { Tooltip, useRovingRadioGroup } from '@/components/foundry';
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
        const label = choice === null ? 'No colour' : locationColorLabel(choice);
        return (
          // The Foundry Tooltip is the app-wide, rich-Markdown replacement for the browser's
          // plain `title`. `triggerTabIndex={-1}` keeps the swatch itself the only tab stop (the
          // roving radiogroup owns focus); focus still bubbles up so the name shows on keyboard
          // focus, and the label stays the swatch's accessible name via `aria-label`.
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
                'size-7 rounded-full outline-none transition-transform',
                // The colour swatch cannot take the option-card chrome — its fill *is* its
                // content — but it is the round counterpart of the kind swatch beside it, so
                // it takes the same focus ring the Foundry gives that one.
                'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                checked && 'ring-2 ring-foreground/70 ring-offset-2 ring-offset-background scale-110',
                choice === null
                  ? 'border-2 border-dashed border-muted-foreground/60 bg-card'
                  : locationColorSwatchClass(choice),
              )}
            />
          </Tooltip>
        );
      })}
    </div>
  );
}

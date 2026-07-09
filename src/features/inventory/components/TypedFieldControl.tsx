import { Checkbox, Input, Select, Textarea, useRovingRadioGroup } from '@/components/foundry';
import { cn } from '@/lib/utils';
import type { FieldType } from '@/db/repositories';

/** ARIA validation wiring (aria-invalid/describedby) to spread onto the primary control. */
export interface TypedFieldControlAria {
  readonly 'aria-invalid'?: true;
  readonly 'aria-describedby'?: string;
}

export interface TypedFieldControlProps {
  readonly fieldType: FieldType;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** SELECT's choice list; ignored for other types. */
  readonly options?: readonly string[] | null;
  readonly controlProps?: TypedFieldControlAria;
  /** Names the control directly — for a caller with no referenceable label id (e.g. FormField). */
  readonly ariaLabel?: string;
  /** Names the control via `aria-labelledby` — for a caller that renders its own label span with an id. */
  readonly labelId?: string;
}

/**
 * The one place a category custom field's *value* is rendered as its declared
 * {@link FieldType} — shared by the per-item Custom Fields editor (Edit item dialog)
 * and the category schema's Default-value control (Categories & schemas dialog), so
 * setting a field's default feels exactly like setting its value on an item.
 *
 * Deliberately renders no wrapping `<label>` of its own: every control (including the
 * BOOLEAN/ON_OFF toggles, which aren't natively labelable via wrapping) names itself
 * via `ariaLabel`/`labelId`, so a caller may freely wrap this in its own single
 * `<label>` without ever nesting two.
 */
export function TypedFieldControl({
  fieldType,
  value,
  onChange,
  options,
  controlProps = {},
  ariaLabel,
  labelId,
}: TypedFieldControlProps) {
  const naming = { 'aria-label': ariaLabel, 'aria-labelledby': labelId };

  switch (fieldType) {
    case 'NUMBER':
      return (
        <Input
          type="number"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...naming}
          {...controlProps}
        />
      );
    case 'RATING':
      return (
        <Input
          type="number"
          min={1}
          max={5}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...naming}
          {...controlProps}
        />
      );
    case 'URL':
      return (
        <Input
          type="url"
          placeholder="https://…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...naming}
          {...controlProps}
        />
      );
    case 'LONG_TEXT':
      return (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} {...naming} {...controlProps} />
      );
    case 'DATE':
      return (
        <Input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...naming}
          {...controlProps}
        />
      );
    case 'BOOLEAN':
      return <YesNoToggle value={value} onChange={onChange} ariaLabel={ariaLabel} labelId={labelId} />;
    case 'ON_OFF':
      return (
        <span className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value === 'true'}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
            {...naming}
            {...controlProps}
          />
          {value === 'true' ? 'On' : 'Off'}
        </span>
      );
    case 'SELECT':
      return (
        <Select
          value={value}
          onChange={onChange}
          options={[{ value: '', label: '—' }, ...(options ?? []).map((opt) => ({ value: opt, label: opt }))]}
          aria-label={ariaLabel}
          aria-labelledby={labelId}
          aria-invalid={controlProps['aria-invalid']}
          aria-describedby={controlProps['aria-describedby']}
        />
      );
    default:
      return <Input value={value} onChange={(e) => onChange(e.target.value)} {...naming} {...controlProps} />;
  }
}

const YES_NO_OPTIONS = [
  { value: 'false', label: 'No' },
  { value: 'true', label: 'Yes' },
] as const;

/**
 * A 2-option segmented radiogroup for a BOOLEAN field — copies the shape of
 * {@link LowStockPolicyPicker} (roving-tabindex `radiogroup`, single tab stop, arrow
 * keys move+select). A value that matches neither option (blank — no default set yet)
 * falls back to showing "No" selected without committing it: only an actual click/key
 * selection calls `onChange`, so an untouched default still submits as unset.
 */
function YesNoToggle({
  value,
  onChange,
  ariaLabel,
  labelId,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  labelId?: string;
}) {
  const selectedIndex = Math.max(
    0,
    YES_NO_OPTIONS.findIndex((o) => o.value === value),
  );
  const { refs, selectAt, onKeyDown } = useRovingRadioGroup<HTMLButtonElement>({
    count: YES_NO_OPTIONS.length,
    onSelect: (index) => onChange(YES_NO_OPTIONS[index]!.value),
  });

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={labelId}
      className="inline-flex rounded-lg border border-border bg-secondary/40 p-0.5"
    >
      {YES_NO_OPTIONS.map((option, index) => {
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
            // `role="radio"` isn't named from its content per the ARIA accessible-name
            // spec (unlike a plain button) — it needs its own explicit label.
            aria-label={option.label}
            tabIndex={checked ? 0 : -1}
            onClick={() => selectAt(index)}
            onKeyDown={(e) => onKeyDown(e, index)}
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

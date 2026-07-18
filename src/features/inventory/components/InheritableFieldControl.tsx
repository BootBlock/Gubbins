import { useRef } from 'react';
import { LiveRegion, Select } from '@/components/foundry';
import { useT } from '@/features/i18n';
import { INHERIT_VALUE, type FieldType, type InheritableFieldValue } from '@/db/repositories';
import { TypedFieldControl, type TypedFieldControlAria } from './TypedFieldControl';

/**
 * The sentinel the editor's draft state uses to mean "inherit this field from the
 * location" (issue #97).
 *
 * Re-exported from the repository's own constant rather than re-declared: the draft value
 * is handed to `setItemFieldValues` verbatim, so two independent copies of this string
 * would silently stop matching if either were ever edited, and the symptom — inheritance
 * quietly saving as literal text — would not look like a typo.
 */
export const INHERIT_DRAFT_VALUE = INHERIT_VALUE;

export interface InheritableFieldControlProps {
  readonly fieldType: FieldType;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options?: readonly string[] | null;
  readonly controlProps?: TypedFieldControlAria;
  readonly labelId?: string;
  readonly ariaLabel?: string;
  /**
   * The field's name, used to name the source picker distinctly from the value control
   * ("Manufacturer — where this value comes from"). Without it the two sibling controls
   * would share one accessible name and be indistinguishable to a screen reader.
   */
  readonly fieldName?: string;
  /**
   * The value this field's location chain offers, or null/absent when nothing above the
   * item offers one — in which case this renders exactly as a plain
   * {@link TypedFieldControl} and no inheritance affordance appears at all.
   *
   * Accepts `undefined` as well as `null` deliberately: a caller reading a field that
   * predates this prop hands back `undefined`, and "no offer" is the right reading of
   * both. Absence must degrade to the plain control, never to a crash.
   */
  readonly inheritable?: InheritableFieldValue | null;
}

/**
 * A custom-field value control that can defer to the item's **location** (issue #97).
 *
 * When some ancestor location offers an inheritable value for the field, a source picker
 * appears above the control offering `<Inherit>` — showing both the value it resolves to
 * and the location it comes from — alongside "custom value", which reveals the ordinary
 * typed control so freeform text/numbers/dates can still be entered.
 *
 * The picker is a separate control rather than an extra entry inside each input because a
 * custom field may be any of nine {@link FieldType}s — a date picker, a rating spinner or
 * a yes/no radiogroup has nowhere to *put* an extra option, and only SELECT is natively a
 * dropdown. One picker in front of the control gives every field type the same choice and
 * the same accessible wiring, instead of nine bespoke approximations of it.
 */
export function InheritableFieldControl({
  fieldType,
  value,
  onChange,
  options,
  controlProps,
  labelId,
  ariaLabel,
  fieldName,
  inheritable,
}: InheritableFieldControlProps) {
  const t = useT();

  // The last non-inherit value this control held, so switching Inherit → custom can put it
  // back. A ref rather than state: it must not itself trigger a render, and it only ever
  // trails the value the caller already owns.
  const lastLiteral = useRef(value === INHERIT_DRAFT_VALUE ? '' : value);
  if (value !== INHERIT_DRAFT_VALUE) lastLiteral.current = value;

  // Nothing above this item offers the field — no choice to present, so don't imply one.
  if (inheritable == null) {
    return (
      <TypedFieldControl
        fieldType={fieldType}
        value={value === INHERIT_DRAFT_VALUE ? '' : value}
        onChange={onChange}
        options={options}
        controlProps={controlProps}
        labelId={labelId}
        ariaLabel={ariaLabel}
      />
    );
  }

  const isInheriting = value === INHERIT_DRAFT_VALUE;
  const inheritedDisplay = inheritable.value ?? t('inventory.fields.inherit.empty');

  return (
    <div className="space-y-field-gap-compact">
      <Select
        value={isInheriting ? INHERIT_DRAFT_VALUE : ''}
        // Switching back to a custom value restores the literal the field held before it
        // started inheriting, rather than blanking it: a round trip through this dropdown
        // must not silently discard the user's value.
        onChange={(next) =>
          onChange(next === INHERIT_DRAFT_VALUE ? INHERIT_DRAFT_VALUE : lastLiteral.current)
        }
        options={[
          {
            value: INHERIT_DRAFT_VALUE,
            label: t('inventory.fields.inherit.option', {
              vars: { value: inheritedDisplay, location: inheritable.locationName },
            }),
          },
          { value: '', label: t('inventory.fields.inherit.custom') },
        ]}
        // Named ONLY by this label, never by the field's own label id: the picker sits
        // beside the value control, and `aria-labelledby` would win over `aria-label` and
        // leave both controls announced identically as "Manufacturer".
        aria-label={
          fieldName
            ? `${fieldName} — ${t('inventory.fields.inherit.sourceLabel')}`
            : t('inventory.fields.inherit.sourceLabel')
        }
      />
      {/* The resolved value, shown read-only: the user needs to see *what* they are
          inheriting, not just that they are. The LiveRegion is always mounted and only its
          children change — a live region inserted at the same moment as its message is
          frequently not announced at all. */}
      <LiveRegion className="text-xs text-muted-foreground">
        {isInheriting ? (
          <p>
            {t('inventory.fields.inherit.from', {
              vars: { value: inheritedDisplay, location: inheritable.locationName },
            })}
          </p>
        ) : null}
      </LiveRegion>
      {isInheriting ? null : (
        <TypedFieldControl
          fieldType={fieldType}
          value={value}
          onChange={onChange}
          options={options}
          controlProps={controlProps}
          labelId={labelId}
          ariaLabel={ariaLabel}
        />
      )}
    </div>
  );
}

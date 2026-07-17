import { useEffect, useState } from 'react';
import { Button, InfoHint, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { fieldAria } from '@/components/foundry/field-aria';
import { InfoIcon } from '@/components/icons';
import { useItemFields, useSetItemFieldValues } from '../categories';
import { validateFieldValue } from '../custom-fields';
import { TypedFieldControl } from './TypedFieldControl';

/**
 * Per-item custom-field editor (spec §4). Fields come from the item's category,
 * resolved with **lenient defaulting** — fields with no stored value show their
 * default (or blank) without erroring. Saving sends only the changed values, with
 * an emptied field clearing its stored value (back to the default).
 *
 * Phase 70 — values are validated through the pure {@link validateFieldValue} seam
 * (the same one `CategoryRepository.setItemFieldValues` enforces on write) *before*
 * the save fires: a required-but-empty or type-invalid field blocks the save and
 * surfaces an accessible `role="alert"` error wired to its control (Phase-51 a11y
 * pattern, via the {@link fieldAria} seam).
 */
export function CustomFieldsEditor({ itemId }: { itemId: string }) {
  const { data: fields, isLoading } = useItemFields(itemId);
  const setValues = useSetItemFieldValues(itemId);
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!fields) return;
    setDraft(Object.fromEntries(fields.map((f) => [f.id, f.value ?? ''])));
  }, [fields]);

  if (isLoading) return <p className="text-xs text-muted-foreground">Loading fields…</p>;
  if (!fields || fields.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No custom fields. Assign a category with fields to track bespoke parameters.
      </p>
    );
  }

  const changed = fields.filter((f) => (draft[f.id] ?? '') !== (f.value ?? ''));

  // Validate every changed field through the same seam the repository enforces, so
  // the editor blocks a save the worker would reject and shows *why*, per field.
  const errors: Record<string, string> = {};
  for (const f of changed) {
    const result = validateFieldValue(f, draft[f.id] ?? '');
    if (!result.ok) errors[f.id] = result.error;
  }
  const hasErrors = Object.keys(errors).length > 0;

  const set = (id: string, value: string) => setDraft((d) => ({ ...d, [id]: value }));

  const save = () => {
    if (hasErrors) return;
    const patch: Record<string, string | null> = {};
    for (const f of changed) {
      // Persist the coerced/normalised value (e.g. NUMBER '1.50' → '1.5'); a value
      // that validates to null clears the row back to the category default.
      const result = validateFieldValue(f, draft[f.id] ?? '');
      patch[f.id] = result.ok ? result.value : null;
    }
    setValues.mutate(patch);
  };

  return (
    <div className="space-y-3">
      {fields.map((field) => {
        const error = errors[field.id];
        const { controlProps, errorId, hasError } = fieldAria(field.id, error);
        return (
          <div key={field.id} className="block">
            {/* The info badges and the error node live *outside* the label span so their
                own accessible names ("More information", the alert text) are never folded
                into the control's name: the control is named via aria-labelledby → the
                span (which holds only the field name + required marker), and the error is
                associated via aria-describedby. */}
            <div className="mb-field-gap flex items-center gap-1.5 text-sm font-medium">
              <span id={`${field.id}-label`} className="flex items-center gap-1.5">
                {field.name}
                {field.isRequired ? <span className="text-destructive">*</span> : null}
              </span>
              {field.description ? <InfoHint content={field.description} /> : null}
              {!field.hasStoredValue && field.defaultValue ? (
                <Tooltip
                  content={`Showing the category default (**${field.defaultValue}**) — not yet set for this item.`}
                  openDelayMs={INFO_OPEN_DELAY_MS}
                >
                  <span className="text-muted-foreground [&_svg]:size-3.5">
                    <InfoIcon />
                  </span>
                </Tooltip>
              ) : null}
            </div>
            <TypedFieldControl
              fieldType={field.fieldType}
              value={draft[field.id] ?? ''}
              onChange={(v) => set(field.id, v)}
              options={field.options}
              controlProps={controlProps}
              labelId={`${field.id}-label`}
            />
            {hasError ? (
              <span id={errorId} role="alert" className="mt-1 block text-xs text-destructive">
                {error}
              </span>
            ) : null}
          </div>
        );
      })}

      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={changed.length === 0 || hasErrors || setValues.isPending}>
          {changed.length > 0 ? `Save ${changed.length} change${changed.length > 1 ? 's' : ''}` : 'Saved'}
        </Button>
      </div>
    </div>
  );
}

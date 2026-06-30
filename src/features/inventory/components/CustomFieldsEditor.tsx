import { useEffect, useState } from 'react';
import { Button, Input, Select, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { fieldAria } from '@/components/foundry/field-aria';
import { InfoIcon } from '@/components/icons';
import type { ResolvedItemField } from '@/db/repositories';
import { useItemFields, useSetItemFieldValues } from '../categories';
import { validateFieldValue } from '../custom-fields';

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
            {/* The error node lives *outside* the <label> so it is not folded into
                the control's accessible name; it is associated via aria-describedby. */}
            <label className="block">
              <span className="mb-field-gap flex items-center gap-1.5 text-sm font-medium">
                {field.name}
                {field.isRequired ? <span className="text-destructive">*</span> : null}
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
              </span>
              <FieldInput
                field={field}
                value={draft[field.id] ?? ''}
                onChange={(v) => set(field.id, v)}
                controlProps={controlProps}
              />
            </label>
            {hasError ? (
              <span id={errorId} role="alert" className="mt-1 block text-xs text-destructive">
                {error}
              </span>
            ) : null}
          </div>
        );
      })}

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={changed.length === 0 || hasErrors || setValues.isPending}
        >
          {changed.length > 0
            ? `Save ${changed.length} change${changed.length > 1 ? 's' : ''}`
            : 'Saved'}
        </Button>
      </div>
    </div>
  );
}

/** ARIA props spread onto a control when its field is invalid (else empty). */
type ControlAria = ReturnType<typeof fieldAria>['controlProps'];

function FieldInput({
  field,
  value,
  onChange,
  controlProps,
}: {
  field: ResolvedItemField;
  value: string;
  onChange: (value: string) => void;
  controlProps: ControlAria;
}) {
  switch (field.fieldType) {
    case 'NUMBER':
      return (
        <Input
          type="number"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...controlProps}
        />
      );
    case 'DATE':
      return (
        <Input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...controlProps}
        />
      );
    case 'BOOLEAN':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value === 'true'}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
            className="size-4 accent-primary"
            {...controlProps}
          />
          {value === 'true' ? 'Yes' : 'No'}
        </label>
      );
    case 'SELECT':
      return (
        <Select value={value} onChange={(e) => onChange(e.target.value)} {...controlProps}>
          <option value="">—</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      );
    default:
      return <Input value={value} onChange={(e) => onChange(e.target.value)} {...controlProps} />;
  }
}

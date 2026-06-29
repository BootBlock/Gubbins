import { useEffect, useState } from 'react';
import { Button, Input, Select, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { InfoIcon } from '@/components/icons';
import type { ResolvedItemField } from '@/db/repositories';
import { useItemFields, useSetItemFieldValues } from '../categories';

/**
 * Per-item custom-field editor (spec §4). Fields come from the item's category,
 * resolved with **lenient defaulting** — fields with no stored value show their
 * default (or blank) without erroring. Saving sends only the changed values, with
 * an emptied field clearing its stored value (back to the default).
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
  const set = (id: string, value: string) => setDraft((d) => ({ ...d, [id]: value }));

  const save = () => {
    const patch: Record<string, string | null> = {};
    for (const f of changed) {
      const v = (draft[f.id] ?? '').trim();
      patch[f.id] = v.length === 0 ? null : v;
    }
    setValues.mutate(patch);
  };

  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <label key={field.id} className="block">
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
          <FieldInput field={field} value={draft[field.id] ?? ''} onChange={(v) => set(field.id, v)} />
        </label>
      ))}

      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={changed.length === 0 || setValues.isPending}>
          {changed.length > 0 ? `Save ${changed.length} change${changed.length > 1 ? 's' : ''}` : 'Saved'}
        </Button>
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ResolvedItemField;
  value: string;
  onChange: (value: string) => void;
}) {
  switch (field.fieldType) {
    case 'NUMBER':
      return <Input type="number" step="any" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'DATE':
      return <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'BOOLEAN':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value === 'true'}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
            className="size-4 accent-primary"
          />
          {value === 'true' ? 'Yes' : 'No'}
        </label>
      );
    case 'SELECT':
      return (
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      );
    default:
      return <Input value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}

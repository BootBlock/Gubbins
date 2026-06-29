import { useEffect, useState } from 'react';
import { Button, InfoHint, Input } from '@/components/foundry';
import { AddIcon, CloseIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useUpdateItem } from '../mutations';
import { buildMetadata, metadataToRows, type MetadataRow } from '../operational-metadata';

/**
 * Editor for the §4.1.1 "flexible metadata layer" (`operational_metadata`): a
 * schema-less list of `key → value` operational parameters intrinsic to the physical
 * item (e.g. a filament's `bed_temp_celsius`, a tool's `calibration_interval_days`).
 * Available on every item, not just gauges. Rows are edited locally and saved
 * wholesale via {@link useUpdateItem}; values are coerced to their natural primitive
 * (number / boolean / string) and validated by the pure `operational-metadata.ts`
 * helpers, so e.g. `60` is stored as a number per the spec example.
 */
export function OperationalMetadataEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const savedJson = JSON.stringify(item.operationalMetadata ?? null);
  const [rows, setRows] = useState<MetadataRow[]>(() => metadataToRows(item.operationalMetadata));
  const [error, setError] = useState<string | null>(null);

  // Re-sync the draft when the persisted value changes (initial open, after a save,
  // or an incoming sync). Keyed on the stable serialisation, not the object identity.
  useEffect(() => {
    setRows(metadataToRows(item.operationalMetadata));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedJson]);

  const setRow = (index: number, patch: Partial<MetadataRow>) =>
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const removeRow = (index: number) => setRows((rs) => rs.filter((_, i) => i !== index));
  const addRow = () => setRows((rs) => [...rs, { key: '', value: '' }]);

  const built = buildMetadata(rows);
  const dirty = built.ok && JSON.stringify(built.value ?? null) !== savedJson;

  const save = () => {
    const result = buildMetadata(rows);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    update.mutate({ id: item.id, input: { operationalMetadata: result.value } });
  };

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Arbitrary operational parameters for this item. Numbers and true/false are stored typed.
        <InfoHint
          content={
            'A free-form `key → value` layer for facts intrinsic to the *physical* item — things ' +
            'no fixed field covers.\n\n' +
            '**Examples**\n' +
            '- `bed_temp_celsius` → `60`\n' +
            '- `calibration_interval_days` → `90`\n' +
            '- `rohs_compliant` → `true`\n\n' +
            'Values are **stored typed**: `60` becomes a number and `true`/`false` a boolean, so ' +
            'they sort and compare correctly. Anything else is kept as text.'
          }
        />
      </p>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No parameters yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, index) => (
            <li key={index} className="flex items-center gap-2">
              <Input
                value={row.key}
                onChange={(e) => setRow(index, { key: e.target.value })}
                placeholder="Name (e.g. bed_temp_celsius)"
                aria-label={`Parameter ${index + 1} name`}
                className="flex-1"
              />
              <Input
                value={row.value}
                onChange={(e) => setRow(index, { value: e.target.value })}
                placeholder="Value (e.g. 60)"
                aria-label={`Parameter ${index + 1} value`}
                className="flex-1"
              />
              <button
                type="button"
                aria-label={`Remove parameter ${index + 1}`}
                onClick={() => removeRow(index)}
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive [&_svg]:size-4"
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={addRow} data-testid="op-meta-add">
          <AddIcon /> Add parameter
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || update.isPending} data-testid="op-meta-save">
          {dirty ? 'Save parameters' : 'Saved'}
        </Button>
      </div>
    </div>
  );
}

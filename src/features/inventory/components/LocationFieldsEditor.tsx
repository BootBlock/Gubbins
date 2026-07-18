import { useState } from 'react';
import { Button, Checkbox, InfoHint, Select } from '@/components/foundry';
import { DeleteIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import {
  useFieldDefs,
  useLocationFieldValues,
  useRemoveLocationFieldValue,
  useSetLocationFieldValue,
} from '../categories';
import { TypedFieldControl } from './TypedFieldControl';

/**
 * The values a location sets for custom fields, and whether each is offered to the items
 * and locations inside it (issue #97).
 *
 * Marking a value *inheritable* is opt-in per row rather than implied by setting it: a
 * location often records a detail about itself (a shelf's load rating, a room's humidity)
 * that no item inside should silently adopt. Requiring the explicit opt-in is what stops
 * every field a location touches from leaking into everything it contains.
 */
export function LocationFieldsEditor({ locationId }: { locationId: string }) {
  const t = useT();
  const { data: values, isLoading } = useLocationFieldValues(locationId);
  const { data: defs } = useFieldDefs();
  const setValue = useSetLocationFieldValue(locationId);
  const removeValue = useRemoveLocationFieldValue(locationId);
  const [adding, setAdding] = useState('');

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">{t('inventory.location.fields.saving')}</p>;
  }

  const used = new Set((values ?? []).map((v) => v.defId));
  const available = (defs ?? []).filter((d) => !used.has(d.id));

  return (
    <section className="space-y-field-gap-compact">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <span>{t('inventory.location.fields.title')}</span>
        <InfoHint content={t('inventory.location.fields.intro')} />
      </div>

      {(values ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('inventory.location.fields.empty')}</p>
      ) : (
        <ul className="space-y-3">
          {(values ?? []).map((value) => {
            const labelId = `loc-field-${value.defId}`;
            return (
              <li key={value.id} className="rounded-lg border border-border bg-card p-3">
                <div className="mb-field-gap-compact flex items-center justify-between gap-2">
                  <span id={labelId} className="text-xs font-medium">
                    {value.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('inventory.location.fields.remove', { vars: { name: value.name } })}
                    onClick={() => removeValue.mutate(value.defId)}
                    disabled={removeValue.isPending}
                  >
                    <DeleteIcon aria-hidden />
                  </Button>
                </div>

                <TypedFieldControl
                  fieldType={value.fieldType}
                  value={value.value ?? ''}
                  onChange={(next) =>
                    setValue.mutate({
                      defId: value.defId,
                      value: next,
                      isInheritable: value.isInheritable,
                    })
                  }
                  options={value.options}
                  labelId={labelId}
                />

                <label className="mt-field-gap-compact flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={value.isInheritable}
                    onChange={(e) =>
                      setValue.mutate({
                        defId: value.defId,
                        value: value.value,
                        isInheritable: e.target.checked,
                      })
                    }
                  />
                  <span>{t('inventory.location.fields.inheritable')}</span>
                  <InfoHint content={t('inventory.location.fields.inheritableHint')} />
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {available.length > 0 ? (
        <div className="flex items-end gap-2">
          <Select
            value={adding}
            onChange={setAdding}
            options={[
              { value: '', label: t('inventory.location.fields.add') },
              ...available.map((d) => ({ value: d.id, label: d.name })),
            ]}
            aria-label={t('inventory.location.fields.addLabel')}
          />
          <Button
            size="sm"
            disabled={adding === '' || setValue.isPending}
            onClick={() => {
              // Seeded inheritable: adding a field to a *location* is almost always in
              // order to share it downward, and the checkbox above makes it one click to
              // undo if not.
              setValue.mutate(
                { defId: adding, value: '', isInheritable: true },
                { onSuccess: () => setAdding('') },
              );
            }}
          >
            {t('inventory.location.fields.add')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

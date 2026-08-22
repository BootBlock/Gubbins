import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, InfoHint, Select } from '@/components/foundry';
import { DeleteIcon, UnlinkIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { getDeviceId } from '@/lib/env/device-id';
import { isForeignFilePointer } from '../device-origin';
import {
  useFieldDefs,
  useLocationFieldValues,
  useRemoveLocationFieldValue,
  useSetLocationFieldValue,
} from '../categories';
import type { LocationFieldValue } from '@/db/repositories';
import { CategoryManagerDialog } from './CategoryManagerDialog';
import { TypedFieldControl } from './TypedFieldControl';

/**
 * The values a location sets for custom fields, and whether each is offered to the items
 * and locations inside it (issue #97).
 *
 * Marking a value *inheritable* is opt-in per row rather than implied by setting it: a
 * location often records a detail about itself (a shelf's load rating, a room's humidity)
 * that no item inside should silently adopt. Requiring the explicit opt-in is what stops
 * every field a location touches from leaking into everything it contains.
 *
 * The panel is titled after what it *holds* rather than after that optional behaviour (issue
 * #689): it was "Inheritable fields", which told a user looking for somewhere to record a fact
 * about a shelf that this panel was for something else — directly above a checkbox whose own
 * hint says the opposite is supported. The per-row "Offer to items here" tick carries the
 * inheritance story on its own.
 */
export function LocationFieldsEditor({ locationId }: { locationId: string }) {
  const t = useT();
  const { data: values, isLoading } = useLocationFieldValues(locationId);
  const { data: defs } = useFieldDefs();
  const setValue = useSetLocationFieldValue(locationId);
  const removeValue = useRemoveLocationFieldValue(locationId);
  const [adding, setAdding] = useState('');
  const [managerOpen, setManagerOpen] = useState(false);
  const deviceId = useMemo(() => getDeviceId(), []);

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">{t('inventory.location.fields.saving')}</p>;
  }

  const used = new Set((values ?? []).map((v) => v.defId));
  const available = (defs ?? []).filter((d) => !used.has(d.id));

  // Pending state is scoped to the definition actually being written. Both mutations are
  // shared by every row, so testing `isPending` alone would grey out the whole panel while
  // one field saves — and make an unrelated row look like it were mid-save.
  const isSaving = (defId: string) => setValue.isPending && setValue.variables?.defId === defId;
  const isRemoving = (defId: string) => removeValue.isPending && removeValue.variables === defId;

  return (
    <section className="space-y-field-gap-compact">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <span>{t('inventory.location.fields.title')}</span>
        <InfoHint content={t('inventory.location.fields.intro')} />
      </div>

      {(values ?? []).length === 0 ? (
        <div className="space-y-field-gap-compact">
          <p className="text-xs text-muted-foreground">
            {/* With an empty dictionary there is nothing to add here, so say where fields are
                defined rather than inviting an action the panel can't offer. */}
            {available.length === 0
              ? t('inventory.location.fields.emptyNoFields')
              : t('inventory.location.fields.empty')}
          </p>
          {/* …and then actually offer the trip. Pointing at "Categories & schemas" in prose
              leaves the user to find and reopen it themselves, from inside a dialog that has
              no route to it. */}
          {available.length === 0 ? (
            <Button variant="outline" size="sm" onClick={() => setManagerOpen(true)}>
              {t('inventory.location.fields.createField')}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="space-y-3">
          {(values ?? []).map((value) => {
            const labelId = `loc-field-${value.defId}`;
            return (
              <li key={value.id} className="rounded-lg border border-border bg-card p-3">
                <div className="mb-field-gap-compact flex items-center justify-between gap-2">
                  {/* The unit joins the label here for the same reason it does on an item's
                      editor — the box holds the number alone. */}
                  <span id={labelId} className="text-xs font-medium">
                    {value.unit
                      ? t('inventory.fields.unit.withName', {
                          vars: { name: value.name, unit: value.unit },
                        })
                      : value.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('inventory.location.fields.remove', { vars: { name: value.name } })}
                    onClick={() => removeValue.mutate(value.defId)}
                    disabled={isRemoving(value.defId)}
                  >
                    <DeleteIcon aria-hidden />
                  </Button>
                </div>

                <LocationFieldValueInput
                  value={value}
                  labelId={labelId}
                  onCommit={(next) =>
                    setValue.mutate({
                      defId: value.defId,
                      value: next,
                      isInheritable: value.isInheritable,
                      // The box only commits when the value actually changed, so this device
                      // did author what is being written (W1g). The tick below deliberately
                      // sends none — see the note there.
                      originDeviceId: deviceId,
                    })
                  }
                />

                {/* A path recorded on another device (W1g). Sits under the box because the box
                    is the re-link: typing a path this device can reach, or a web address,
                    re-homes the value. Not gated on a draft comparison the way the item
                    editor's is — this control commits per edit, so the row reloads and the
                    note clears itself the moment a new value is stored. */}
                {isForeignFilePointer(value.fieldType, value.value, value.originDeviceId, deviceId) ? (
                  <span className="mt-field-gap-compact flex items-start gap-1.5 text-xs text-muted-foreground">
                    <span aria-hidden className="mt-0.5 shrink-0 text-warning [&_svg]:size-3.5">
                      <UnlinkIcon />
                    </span>
                    {t('inventory.fields.file.foreignHint')}
                  </span>
                ) : null}

                <label className="mt-field-gap-compact flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={value.isInheritable}
                    onChange={(e) =>
                      setValue.mutate({
                        defId: value.defId,
                        // No `originDeviceId` (W1g): this write re-sends the value untouched to
                        // change only the tick, so it authored nothing. The repository would
                        // refuse to re-stamp an unchanged value anyway — this states the same
                        // thing at the call site rather than relying on that alone.
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
              { value: '', label: t('inventory.location.fields.addPlaceholder') },
              ...available.map((d) => ({ value: d.id, label: d.name })),
            ]}
            aria-label={t('inventory.location.fields.addLabel')}
          />
          <Button
            disabled={adding === '' || isSaving(adding)}
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

      {/* Stacked over the location dialog rather than replacing it: the user came here to set a
          value, so defining the field they need should return them to this panel, not unwind it. */}
      <CategoryManagerDialog open={managerOpen} onClose={() => setManagerOpen(false)} />
    </section>
  );
}

/**
 * One location field's value box, editing a **local draft** and committing on blur.
 *
 * Writing on every `onChange` would issue a database write and a full inheritance
 * invalidation per keystroke, and — because the box is fed from server state — let a
 * refetch land mid-word and overwrite what the user is typing. Holding the draft locally
 * keeps typing responsive and makes exactly one write per edit.
 */
function LocationFieldValueInput({
  value,
  labelId,
  onCommit,
}: {
  value: LocationFieldValue;
  labelId: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value.value ?? '');

  // Re-seed when the stored value changes underneath (another device, or the row reloaded).
  useEffect(() => {
    setDraft(value.value ?? '');
  }, [value.value]);

  // The selection types commit the moment the user picks — they emit no blur of their own,
  // so a blur-only commit would silently never fire for them. IMAGE is the same: it emits its
  // value on pick (asynchronously, after compression) with no meaningful blur (issue #453).
  //
  // COLOUR is deliberately **not** one of them, even though it too has a picker. It is a text
  // box first, and a partly-typed hex is frequently a valid colour in its own right (`#ff0`
  // is yellow), so committing per change would write a string of colours nobody chose on the
  // way to the one they did. Its swatch wires this same blur instead.
  const commitsOnPick =
    value.fieldType === 'SELECT' ||
    value.fieldType === 'BOOLEAN' ||
    value.fieldType === 'ON_OFF' ||
    value.fieldType === 'IMAGE';

  return (
    <TypedFieldControl
      fieldType={value.fieldType}
      value={draft}
      onChange={(next) => {
        setDraft(next);
        if (commitsOnPick && next !== (value.value ?? '')) onCommit(next);
      }}
      onBlur={
        commitsOnPick
          ? undefined
          : () => {
              if (draft !== (value.value ?? '')) onCommit(draft);
            }
      }
      options={value.options}
      labelId={labelId}
    />
  );
}

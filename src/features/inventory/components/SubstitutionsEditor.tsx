/**
 * SubstitutionsEditor — interchangeable-item links for one item (issue #36).
 *
 * Marks items that can be **freely substituted** for one another, so a project or list that calls
 * for one can take any of its substitutes instead. Mechanically this is a symmetric, reciprocal
 * `item_relations` link (`INTERCHANGEABLE_WITH`) — the same synced infrastructure the "Related" tab
 * uses — but it lives on its own surface, with a single implicit relationship, so it needs no kind
 * picker: choosing an item and adding is enough. Links are reciprocal (adding A↔B surfaces on both)
 * and reviewable (add/remove only, never inferred).
 */
import { useMemo, useState } from 'react';
import { Button, InfoHint, Input } from '@/components/foundry';
import { AddIcon, SubstituteIcon, UnlinkIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useItemRelations } from '../queries';
import { ItemPicker } from './ItemPicker';
import { useAddRelation, useRemoveRelation } from '../mutations';
import { describeItemRelations, isSubstitutionKind } from '../item-relations';
import { itemDisplayName } from '../item-display';
import { useErrorMessage } from '@/features/errors';

export function SubstitutionsEditor({ item }: { item: Item }) {
  const { data: relations } = useItemRelations(item.id);
  const addRelation = useAddRelation();
  const removeRelation = useRemoveRelation();

  // A substitute is some *other* item; the picker searches the whole catalogue for it rather than
  // offering a fixed first page of it (issue #484).
  const excluded = useMemo(() => new Set([item.id]), [item.id]);

  const [otherId, setOtherId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();

  const views = useMemo(() => relations ?? [], [relations]);
  const viewById = useMemo(() => new Map(views.map((v) => [v.id, v])), [views]);
  // Only the interchangeable links belong on this surface; the general cross-links stay on "Related".
  const resolved = useMemo(() => describeItemRelations(item.id, views, isSubstitutionKind), [item.id, views]);

  const substitutes = useMemo(
    () =>
      resolved.flatMap((r) => {
        const view = viewById.get(r.id);
        if (!view) return [];
        return [{ id: r.id, itemLabel: itemDisplayName(view.otherItemName, view.otherItemSerialNo) }];
      }),
    [resolved, viewById],
  );

  const add = () => {
    if (otherId === '') return;
    setError(null);
    // Symmetric kind — the repository canonicalises endpoint order, so either direction is fine.
    addRelation.mutate(
      { fromItemId: item.id, toItemId: otherId, kind: 'INTERCHANGEABLE_WITH', note: note.trim() || null },
      {
        onSuccess: () => {
          setOtherId('');
          setNote('');
        },
        onError: (e) => setError(describeError(e, 'Could not add the substitution.')),
      },
    );
  };

  return (
    <div className="space-y-4">
      {/* Existing substitutes. */}
      {substitutes.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="substitutions-empty">
          No substitutes yet. Mark other items that can be used in place of this one — any of them can stand
          in for it in a project or list.
        </p>
      ) : (
        <div data-testid="substitutions-list">
          <p className="mb-field-gap-compact flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
            <SubstituteIcon />
            Interchangeable with
          </p>
          <ul className="flex flex-col gap-1">
            {substitutes.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-2 rounded-lg bg-secondary/30 px-2.5 py-1.5 text-sm"
                data-testid="substitution-row"
              >
                <span className="flex-1 truncate font-medium">{entry.itemLabel}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const view = viewById.get(entry.id);
                    if (!view) return;
                    removeRelation.mutate({
                      relationId: entry.id,
                      fromItemId: view.fromItemId,
                      toItemId: view.toItemId,
                    });
                  }}
                  disabled={removeRelation.isPending}
                  aria-label={`Remove substitute — ${entry.itemLabel}`}
                  data-testid="remove-substitution"
                >
                  <UnlinkIcon />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Add a substitute. */}
      <div className="rounded-xl border border-border p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
          <AddIcon />
          Add a substitute
          <InfoHint
            content={
              'Mark another item as **interchangeable** with this one — freely substitutable, so ' +
              'either can be used where the other is called for (handy in **projects** and **lists**).\n\n' +
              'Substitutes are **reciprocal** — the link also shows on the other item — and distinct ' +
              'from **variants** (same product) and **related** items (works-with / accessory / spare).'
            }
          />
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-52 flex-1">
            <ItemPicker
              label="Item"
              value={otherId}
              onChange={(id) => setOtherId(id ?? '')}
              exclude={excluded}
              data-testid="substitution-item-picker"
            />
          </div>
          <Button
            onClick={add}
            disabled={addRelation.isPending || otherId === ''}
            data-testid="add-substitution"
          >
            <AddIcon />
            Add
          </Button>
        </div>
        <label className="mt-2 block">
          <span className="mb-field-gap-compact block text-xs text-muted-foreground">Note (optional)</span>
          <Input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. same pitch, different colour"
            aria-label="Substitution note"
            data-testid="substitution-note"
          />
        </label>
        {error ? (
          <p role="alert" className="mt-1.5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * RelationsEditor — related-items cross-links for one item (feature-gap G6).
 *
 * A synced many-to-many relation *between items*, distinct from **variants** (child SKUs of one
 * identity) and **kits** (an item assembled from other items): "works with" / "is an accessory for"
 * / "is a spare for". Links are **reciprocal** — adding A→B surfaces on B as B→A — and reviewable
 * (add/remove only, never inferred). All vocabulary + reciprocal-label resolution lives in the pure
 * `item-relations.ts` seam; this component is the Foundry-primitive glue.
 */
import { useMemo, useState } from 'react';
import { Button, InfoHint, Input, SelectField } from '@/components/foundry';
import { AddIcon, LinkIcon, UnlinkIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useInventoryItems, useItemRelations } from '../queries';
import { useAddRelation, useRemoveRelation } from '../mutations';
import {
  RELATION_OPTIONS,
  describeItemRelations,
  isSubstitutionKind,
  relationOptionByValue,
  relationSpecFromOption,
} from '../item-relations';

/** Display label for an item: `Name` or `Name #serial` for a serialised clone. */
function itemLabel(name: string, serialNo: number | null): string {
  return serialNo === null ? name : `${name} #${serialNo}`;
}

export function RelationsEditor({ item }: { item: Item }) {
  const { data: relations } = useItemRelations(item.id);
  const addRelation = useAddRelation();
  const removeRelation = useRemoveRelation();

  // Candidate items to link to: every other active item. A fuller search picker is a later
  // refinement (matches the KitEditor / project-BOM item Select).
  const { data: itemsPage } = useInventoryItems({}, 100);
  const candidates = useMemo(
    () => (itemsPage?.pages.flatMap((p) => p.rows) ?? []).filter((i) => i.id !== item.id),
    [itemsPage, item.id],
  );

  const [optionValue, setOptionValue] = useState<string>(RELATION_OPTIONS[0]!.value);
  const [otherId, setOtherId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const views = useMemo(() => relations ?? [], [relations]);
  // Substitutions (issue #36) live on their own tab — keep them out of the general "Related" list.
  const resolved = useMemo(
    () => describeItemRelations(item.id, views, (kind) => !isSubstitutionKind(kind)),
    [item.id, views],
  );
  const viewById = useMemo(() => new Map(views.map((v) => [v.id, v])), [views]);

  // Group the resolved relations by their (already flipped) label, preserving the seam's order.
  const groups = useMemo(() => {
    const out: { label: string; entries: { id: string; label: string; itemLabel: string }[] }[] = [];
    for (const r of resolved) {
      const view = viewById.get(r.id);
      if (!view) continue;
      const entry = {
        id: r.id,
        label: r.label,
        itemLabel: itemLabel(view.otherItemName, view.otherItemSerialNo),
      };
      const last = out[out.length - 1];
      if (last && last.label === r.label) last.entries.push(entry);
      else out.push({ label: r.label, entries: [entry] });
    }
    return out;
  }, [resolved, viewById]);

  const add = () => {
    const option = relationOptionByValue(optionValue);
    if (!option || otherId === '') return;
    setError(null);
    const spec = relationSpecFromOption(option, item.id, otherId);
    addRelation.mutate(
      { fromItemId: spec.fromItemId, toItemId: spec.toItemId, kind: spec.kind, note: note.trim() || null },
      {
        onSuccess: () => {
          setOtherId('');
          setNote('');
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not add the relationship.'),
      },
    );
  };

  return (
    <div className="space-y-4">
      {/* Existing relations, grouped by their reciprocal label. */}
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="relations-empty">
          No related items yet. Link this item to the things it works with, or is an accessory or spare for.
        </p>
      ) : (
        <div className="space-y-3" data-testid="relations-list">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="mb-field-gap-compact flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
                <LinkIcon />
                {group.label}
              </p>
              <ul className="flex flex-col gap-1">
                {group.entries.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center gap-2 rounded-lg bg-secondary/30 px-2.5 py-1.5 text-sm"
                    data-testid="relation-row"
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
                      aria-label={`Remove relationship — ${group.label} ${entry.itemLabel}`}
                      data-testid="remove-relation"
                    >
                      <UnlinkIcon />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Add a relationship. */}
      <div className="rounded-xl border border-border p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
          <AddIcon />
          Add a relationship
          <InfoHint
            content={
              'Link this item to another it relates to — distinct from **variants** (same product) ' +
              'and **kits** (an assembly).\n\n' +
              '- **Works with** — a compatible companion (symmetric).\n' +
              '- **Is an accessory for** / **Has accessory** — an add-on and the thing it fits.\n' +
              '- **Is a spare for** / **Has spare** — a replacement part and what it replaces.\n\n' +
              'Relationships are **reciprocal** — the link also shows on the other item.'
            }
          />
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-44">
            <SelectField
              label="Relationship"
              value={optionValue}
              onChange={setOptionValue}
              options={RELATION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              data-testid="relation-kind-picker"
            />
          </div>
          <div className="min-w-52 flex-1">
            <SelectField
              label="Item"
              value={otherId}
              onChange={setOtherId}
              options={[
                { value: '', label: '— Choose an item —' },
                ...candidates.map((i) => ({ value: i.id, label: itemLabel(i.name, i.serialNo) })),
              ]}
              data-testid="relation-item-picker"
            />
          </div>
          <Button
            size="sm"
            onClick={add}
            disabled={addRelation.isPending || otherId === ''}
            data-testid="add-relation"
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
            placeholder="e.g. via USB-C adapter"
            aria-label="Relationship note"
            data-testid="relation-note"
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

/**
 * Pure seam behind the location delete confirmation (issue #823): it turns a
 * {@link LocationDeleteImpact} into the two lists of message keys the dialog renders, and holds no
 * React, no DOM and no catalog of its own — the same "logic out of glue" split as
 * `location-map.ts`, so the rules about *which* consequences are worth naming are unit-tested
 * directly rather than through a rendered dialog.
 *
 * The split into `moves` and `destroys` is the whole point. Deleting a location does both, and a
 * dialog that ran them together would either understate the loss (photos and regions listed
 * alongside "items move to Unassigned", which loses nothing) or overstate it (every item in the
 * subtree read as destroyed, which it is not). Naming them separately is what lets the copy be
 * proportionate to what actually goes.
 */
import type { LocationDeleteImpact } from '@/db/repositories';
import type { MessageKey } from '@/features/i18n';

/** One consequence worth naming: a plural-stem message key plus the values it interpolates. */
export interface LocationDeleteLine {
  /** The plural *stem*; `t()` picks the `.one` / `.other` variant from `vars.count`. */
  readonly key: MessageKey;
  readonly vars: Readonly<Record<string, string | number>>;
}

export interface LocationDeleteSummary {
  /** Consequences that relocate something. Nothing here is lost. */
  readonly moves: readonly LocationDeleteLine[];
  /** Consequences that destroy something. Nothing here comes back. */
  readonly destroys: readonly LocationDeleteLine[];
}

/**
 * The consequences of deleting a location, as message keys — zero counts omitted, so a location
 * that holds only photos says only that.
 *
 * `parentLabel` is passed in already resolved (a location name, or the caller's translated wording
 * for the top level) because this seam does no translating of its own.
 */
export function summariseLocationDelete(
  impact: LocationDeleteImpact,
  parentLabel: string,
): LocationDeleteSummary {
  const moves: LocationDeleteLine[] = [];
  const destroys: LocationDeleteLine[] = [];

  const add = (
    list: LocationDeleteLine[],
    key: MessageKey,
    count: number,
    extra?: Readonly<Record<string, string | number>>,
  ) => {
    if (count > 0) list.push({ key, vars: { count, ...extra } });
  };

  add(moves, 'inventory.locations.delete.moves.items', impact.itemsHere);
  add(moves, 'inventory.locations.delete.moves.stock', impact.stockUnitsHere);
  add(moves, 'inventory.locations.delete.moves.loans', impact.openLoansHere);
  add(moves, 'inventory.locations.delete.moves.children', impact.childLocations, {
    parent: parentLabel,
  });
  // Only ever non-zero alongside the line above, and the one number the old direct-item guard
  // could not see: the collection sitting under a location that reads as empty.
  add(moves, 'inventory.locations.delete.moves.itemsBelow', impact.itemsBelow);

  add(destroys, 'inventory.locations.delete.destroys.photos', impact.photos);
  add(destroys, 'inventory.locations.delete.destroys.regions', impact.regions);
  add(destroys, 'inventory.locations.delete.destroys.tags', impact.tags);
  add(destroys, 'inventory.locations.delete.destroys.fields', impact.fieldValues);

  return { moves, destroys };
}

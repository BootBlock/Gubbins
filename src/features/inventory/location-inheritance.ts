/**
 * Pure resolution seam for **location-inherited custom-field values** (issue #97).
 *
 * A location may record a value for any dictionary definition and mark it
 * *inheritable*; the items inside that location — and the locations beneath it — can
 * then take that value instead of storing their own. This seam owns the one rule that
 * decides what a field actually resolves to, as side-effect-free functions over data
 * the repository has already read.
 *
 * Mirrors the sibling pure seams (`custom-fields.ts`, `cycle-count.ts`,
 * `audit-session.ts`): pure, injectable, **no DB**, exhaustively unit-tested. The
 * repository does the SQL (a recursive CTE for the ancestry, one read for the offers)
 * and hands the result here; the precedence logic never touches a driver.
 */
import type {
  FieldValueMode,
  FieldValueSource,
  InheritableFieldValue,
} from '@/db/repositories/types/categories';

/** One link in a location's ancestry chain, ordered nearest-first. */
export interface AncestorLocation {
  readonly id: string;
  readonly name: string;
}

/** A location's inheritable offer for one definition, as read from the DB. */
export interface InheritableOffer {
  readonly locationId: string;
  readonly defId: string;
  readonly value: string | null;
  /** The device the location's value was authored on, or null when unattributed (W1g). */
  readonly originDeviceId: string | null;
}

/** What an item has stored for one definition (absent ⇒ never set). */
export interface StoredFieldValue {
  readonly mode: FieldValueMode;
  readonly value: string | null;
  /** The device the item's own value was authored on, or null when unattributed (W1g). */
  readonly originDeviceId: string | null;
}

/** The outcome of resolving one field for one item. */
export interface ResolvedFieldValue {
  readonly value: string | null;
  readonly source: FieldValueSource;
  readonly mode: FieldValueMode;
  /** The offer in play for this def, whether or not it is currently being used. */
  readonly inheritable: InheritableFieldValue | null;
  /** The device {@link value} was authored on — see {@link ResolvedItemField.originDeviceId}. */
  readonly originDeviceId: string | null;
}

/**
 * Find the value a location chain offers for one definition: the **nearest** ancestor
 * wins, so a value set on a drawer overrides the one set on the cabinet above it.
 *
 * `chain` must be ordered nearest-first (the item's own location, then its parent, and
 * so on to the root) — the order {@link buildAncestorChain} produces. Only locations
 * that actually offer the def are considered; a location that sets a value but leaves
 * it non-inheritable is simply absent from `offers` and is skipped, *not* treated as
 * an override that blocks the ancestors above it.
 *
 * Returns null when no ancestor offers the definition.
 */
export function findInheritedValue(
  chain: readonly AncestorLocation[],
  offers: readonly InheritableOffer[],
  defId: string,
): InheritableFieldValue | null {
  const forDef = new Map<string, InheritableOffer>();
  for (const offer of offers) {
    if (offer.defId !== defId) continue;
    // First offer per location wins; the DB's UNIQUE(location_id, def_id) means there
    // is only ever one, but the guard keeps the seam total for hand-built input.
    if (!forDef.has(offer.locationId)) forDef.set(offer.locationId, offer);
  }
  if (forDef.size === 0) return null;

  for (const link of chain) {
    const offer = forDef.get(link.id);
    if (offer === undefined) continue;
    return {
      value: offer.value,
      locationId: link.id,
      locationName: link.name,
      originDeviceId: offer.originDeviceId,
    };
  }
  return null;
}

/**
 * Resolve one field to its effective value, applying the full precedence:
 *
 * 1. **stored literal** — the item holds its own value.
 * 2. **inherited** — the item's stored mode is `inherit` and some ancestor offers a
 *    value for the definition.
 * 3. **default** — the category's lenient-defaulting value (§4), or null.
 *
 * An item set to `inherit` whose offer has since disappeared (the location's value was
 * cleared, made non-inheritable, or the item moved somewhere that doesn't offer it)
 * falls through to the default rather than erroring or stranding a stale value — the
 * intent is kept stored, so restoring the offer silently restores the inheritance.
 */
export function resolveFieldValue(
  stored: StoredFieldValue | undefined,
  inheritable: InheritableFieldValue | null,
  defaultValue: string | null,
): ResolvedFieldValue {
  const mode: FieldValueMode = stored?.mode ?? 'literal';

  // The origin (W1g) follows `value` rather than being resolved separately, which is what
  // keeps the two from ever describing different rows: an inherited value takes the offering
  // *location's* origin (the item's own row holds no value to attribute), a stored literal
  // takes its own, and a category default takes none — a default is schema, not something a
  // device authored.
  if (mode === 'inherit') {
    if (inheritable !== null) {
      return {
        value: inheritable.value,
        source: 'inherited',
        mode,
        inheritable,
        originDeviceId: inheritable.originDeviceId,
      };
    }
    return { value: defaultValue, source: 'default', mode, inheritable, originDeviceId: null };
  }

  // A stored literal row is authoritative even when its value is null — clearing a
  // field is not the same as never having set it. Only the *absence* of a row defaults.
  if (stored !== undefined) {
    return {
      value: stored.value,
      source: 'stored',
      mode,
      inheritable,
      originDeviceId: stored.originDeviceId,
    };
  }
  return { value: defaultValue, source: 'default', mode, inheritable, originDeviceId: null };
}

/**
 * Order a set of ancestor rows into a nearest-first chain starting at `startId`.
 *
 * The DB hands back the ancestry as unordered rows (a recursive CTE has no inherent
 * ordering guarantee across drivers), so the walk is reconstructed here from the
 * parent links. Defensive against a cycle in the data — the loop cannot run longer
 * than the number of rows, so a corrupt parent chain terminates rather than hanging.
 */
export function buildAncestorChain(
  startId: string,
  parents: ReadonlyMap<string, { readonly name: string; readonly parentId: string | null }>,
): AncestorLocation[] {
  const chain: AncestorLocation[] = [];
  const seen = new Set<string>();
  let current: string | null = startId;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const node = parents.get(current);
    if (node === undefined) break;
    chain.push({ id: current, name: node.name });
    current = node.parentId;
  }
  return chain;
}

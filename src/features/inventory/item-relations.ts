/**
 * Pure related-items seam (feature-gap G6 — "works with" / accessory / spare-for links).
 *
 * A synced many-to-many relation *between items*, distinct from **variants** (child SKUs of
 * one identity) and **kits** (an item assembled from other items): "this camera **works with**
 * that tripod", "this cable **is an accessory for** that laptop", "this belt **is a spare for**
 * that vacuum". Relations are **reciprocal** — recording A→B surfaces on B as B→A — so the same
 * link reads correctly from either item.
 *
 * This module owns the relation vocabulary and *all* of the non-trivial logic — kind
 * normalisation, the reciprocal-label resolution, pair canonicalisation and dedupe — and nothing
 * else: no React, no repository, no SQL, no DOM. That keeps it exhaustively unit-testable in
 * isolation, the same "logic out of glue" seam as `valuation.ts` / `reorder-policy.ts`.
 *
 * ## Identity is deterministic (why there is no surrogate UUID)
 *
 * A relation's `id` is derived from its **canonical** `(from, to, kind)` triple
 * ({@link itemRelationId}), not a random UUID. Two devices that independently add the *same*
 * logical relation therefore mint the *same* id, so the syncable `item_relations` table merges
 * them by ordinary last-writer-wins on that id — no UNIQUE-business-key collision that would
 * otherwise need bespoke reconcile handling (contrast `item_aliases`). Symmetric relations
 * (`WORKS_WITH`, `INTERCHANGEABLE_WITH`) canonicalise their endpoint order, so A↔B and B↔A
 * collapse to one row.
 */

/** The relation vocabulary (SSOT). Stored verbatim in `item_relations.kind` (free TEXT — see
 * the migration note; no DB CHECK, so a future kind syncs forward without a schema change).
 * `INTERCHANGEABLE_WITH` (issue #36 — substitutions) is a symmetric "these two are freely
 *
 * @internal Exported for unit tests only.
 */
export const RELATION_KINDS = ['WORKS_WITH', 'ACCESSORY_FOR', 'SPARE_FOR', 'INTERCHANGEABLE_WITH'] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

/**
 * Relation kinds that express **interchangeability** — an item that can be freely substituted for
 * another (issue #36). These are presented on their own "Substitutions" tab and deliberately kept
 * *out* of the general "Related" surface, so the two facets read as distinct. Mechanically they are
 * ordinary symmetric, reciprocal relations; the partition is purely a presentation split.
 *
 * @internal Exported for unit tests only.
 */
export const SUBSTITUTION_KINDS = ['INTERCHANGEABLE_WITH'] as const satisfies readonly RelationKind[];

/** Is `kind` a substitution ("interchangeable with") relation rather than a general related-item link? */
export function isSubstitutionKind(kind: RelationKind): boolean {
  return (SUBSTITUTION_KINDS as readonly RelationKind[]).includes(kind);
}

/**
 * The reciprocal label pair for each kind. `forward` reads from the perspective of the relation's
 * stored `from` item; `reverse` from the `to` item. A **symmetric** kind reads the same from both
 * ends (so `forward === reverse`); a directional kind flips ("Accessory for" ⇄ "Has accessory").
 */
export interface RelationLabel {
  readonly forward: string;
  readonly reverse: string;
  readonly symmetric: boolean;
}

/** @internal Exported for unit tests only. */
export const RELATION_LABELS: Record<RelationKind, RelationLabel> = {
  WORKS_WITH: { forward: 'Works with', reverse: 'Works with', symmetric: true },
  ACCESSORY_FOR: { forward: 'Accessory for', reverse: 'Has accessory', symmetric: false },
  SPARE_FOR: { forward: 'Spare for', reverse: 'Has spare', symmetric: false },
  INTERCHANGEABLE_WITH: {
    forward: 'Interchangeable with',
    reverse: 'Interchangeable with',
    symmetric: true,
  },
};

/**
 * Type guard: is `value` one of the known relation kinds?
 *
 * @internal Exported for unit tests only.
 */
export function isRelationKind(value: unknown): value is RelationKind {
  return typeof value === 'string' && (RELATION_KINDS as readonly string[]).includes(value);
}

/**
 * Coerce arbitrary text to a known {@link RelationKind}, or `null` when it matches none. Trims
 * and upper-cases so casing/whitespace from an import or a stale peer row is forgiving; anything
 * unrecognised is rejected rather than silently coerced.
 */
export function normaliseRelationKind(raw: string | null | undefined): RelationKind | null {
  if (raw == null) return null;
  const key = raw.trim().toUpperCase();
  return isRelationKind(key) ? key : null;
}

/**
 * A symmetric kind reads identically from both ends and canonicalises its endpoint order.
 *
 * @internal Exported for unit tests only.
 */
export function isSymmetricRelationKind(kind: RelationKind): boolean {
  return RELATION_LABELS[kind].symmetric;
}

/** A directed relation triple, before or after canonicalisation. */
export interface RelationSpec {
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly kind: RelationKind;
}

/**
 * Separator for the deterministic relation id. Item ids are UUIDs (hex + hyphens) and kinds are
 * `[A-Z_]`, so `|` can never appear inside a component — making the triple unambiguous.
 */
const SEP = '|';

/**
 * Canonicalise a relation triple: for a **symmetric** kind the endpoint pair is ordered
 * deterministically (lexicographically smaller id becomes `from`) so A↔B and B↔A are one relation;
 * a **directional** kind keeps the caller's order (direction carries meaning). The `kind` is
 * unchanged. Assumes `fromItemId !== toItemId` (a self-relation is rejected upstream by
 * {@link planRelation}).
 *
 * @internal Exported for unit tests only.
 */
export function canonicaliseRelation(spec: RelationSpec): RelationSpec {
  if (isSymmetricRelationKind(spec.kind) && spec.toItemId < spec.fromItemId) {
    return { fromItemId: spec.toItemId, toItemId: spec.fromItemId, kind: spec.kind };
  }
  return spec;
}

/**
 * The deterministic id for a relation — its **canonical** `from|to|kind`. Idempotent across
 * devices (same logical relation ⇒ same id), so the LWW-leaf table merges duplicates for free.
 */
export function itemRelationId(spec: RelationSpec): string {
  const c = canonicaliseRelation(spec);
  return `${c.fromItemId}${SEP}${c.toItemId}${SEP}${c.kind}`;
}

/** Why a proposed relation was rejected (see {@link planRelation}). */
export type RelationPlanError = 'SELF' | 'INVALID_KIND';

export type RelationPlan =
  | { readonly ok: true; readonly spec: RelationSpec; readonly id: string }
  | { readonly ok: false; readonly reason: RelationPlanError };

/**
 * Validate + canonicalise a proposed relation. Rejects a self-relation (`from === to`) and an
 * unknown kind; otherwise returns the canonical triple and its deterministic id, ready to persist.
 * The single choke-point every write goes through, so the invariants live in one tested place.
 */
export function planRelation(fromItemId: string, toItemId: string, rawKind: string): RelationPlan {
  const kind = normaliseRelationKind(rawKind);
  if (kind === null) return { ok: false, reason: 'INVALID_KIND' };
  if (fromItemId === toItemId) return { ok: false, reason: 'SELF' };
  const spec = canonicaliseRelation({ fromItemId, toItemId, kind });
  return { ok: true, spec, id: itemRelationId(spec) };
}

/**
 * Dedupe key for a relation — identical to its canonical id.
 *
 * @internal Exported for unit tests only.
 */
export function relationDedupeKey(spec: RelationSpec): string {
  return itemRelationId(spec);
}

/**
 * Drop duplicate relations (same canonical triple), keeping the first occurrence. Order-preserving,
 * so a caller's chosen ordering survives. Used to sanitise a set before persisting or displaying.
 *
 * @internal Exported for unit tests only.
 */
export function dedupeRelations<T extends RelationSpec>(specs: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const spec of specs) {
    const key = relationDedupeKey(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
  }
  return out;
}

/** Which end of a stored relation the viewing item sits on. */
export type RelationDirection = 'forward' | 'reverse' | 'symmetric';

/** A stored relation resolved from the perspective of one item. */
export interface ResolvedRelation {
  /** The *other* item in the relation (the one the viewing item links to). */
  readonly otherItemId: string;
  readonly kind: RelationKind;
  readonly direction: RelationDirection;
  /** The label to show the viewing item, already flipped for its end (e.g. "Has accessory"). */
  readonly label: string;
}

/**
 * Resolve a stored relation for `itemId`: pick the *other* item and the label to show from this
 * item's end. Returns `null` when `itemId` is neither endpoint (defensive — a caller only ever
 * passes relations that touch the item). A symmetric kind resolves `direction: 'symmetric'` and
 * the same label whichever end is viewed; a directional kind flips the label on the `to` end.
 */
export function resolveRelationForItem(itemId: string, spec: RelationSpec): ResolvedRelation | null {
  const labels = RELATION_LABELS[spec.kind];
  if (itemId === spec.fromItemId) {
    return {
      otherItemId: spec.toItemId,
      kind: spec.kind,
      direction: labels.symmetric ? 'symmetric' : 'forward',
      label: labels.forward,
    };
  }
  if (itemId === spec.toItemId) {
    return {
      otherItemId: spec.fromItemId,
      kind: spec.kind,
      direction: labels.symmetric ? 'symmetric' : 'reverse',
      label: labels.reverse,
    };
  }
  return null;
}

/** A stored relation carrying its id, for resolution + removal. */
export interface StoredRelation extends RelationSpec {
  readonly id: string;
}

/** A stored relation resolved for the viewing item, carrying its id for removal. */
export interface ResolvedItemRelation extends ResolvedRelation {
  readonly id: string;
}

/** Sort order of the kinds in the UI (matches {@link RELATION_KINDS}). */
const KIND_ORDER: Record<RelationKind, number> = {
  WORKS_WITH: 0,
  ACCESSORY_FOR: 1,
  SPARE_FOR: 2,
  INTERCHANGEABLE_WITH: 3,
};

/** Directions sort forward → symmetric → reverse, so "Accessory for" precedes "Has accessory". */
const DIRECTION_ORDER: Record<RelationDirection, number> = {
  forward: 0,
  symmetric: 1,
  reverse: 2,
};

/**
 * Resolve every relation touching `itemId` for display: map each to the viewing item's perspective,
 * drop any that don't touch it (defensive) and any whose kind is unknown, and sort deterministically
 * by (kind, direction, otherItemId) so the grouped list is stable. The UI groups the result by
 * `label`.
 *
 * `includeKind` optionally restricts the result to a subset of kinds — used to split the
 * general "Related" surface from the dedicated "Substitutions" surface (issue #36) even though
 * both read from the same stored relation set. Omitted, every kind is included.
 */
export function describeItemRelations(
  itemId: string,
  relations: readonly StoredRelation[],
  includeKind?: (kind: RelationKind) => boolean,
): ResolvedItemRelation[] {
  const resolved: ResolvedItemRelation[] = [];
  for (const relation of relations) {
    if (!isRelationKind(relation.kind)) continue;
    if (includeKind && !includeKind(relation.kind)) continue;
    const view = resolveRelationForItem(itemId, relation);
    if (view === null) continue;
    resolved.push({ ...view, id: relation.id });
  }
  return resolved.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      DIRECTION_ORDER[a.direction] - DIRECTION_ORDER[b.direction] ||
      a.otherItemId.localeCompare(b.otherItemId),
  );
}

/**
 * A relation phrasing offered in the add-UI, from the perspective of the item being edited.
 * `invert` marks the phrasings where the *current* item is the relation's `to` end (e.g. "Has
 * accessory": the current item has the accessory, so the other item is the accessory → it is the
 * `from`). Symmetric kinds need only one phrasing (canonicalisation handles the order).
 */
export interface RelationOption {
  readonly value: string;
  readonly label: string;
  readonly kind: RelationKind;
  /** When true the current item is the `to` end (the other item is `from`). */
  readonly invert: boolean;
}

// The "Related" add-UI phrasings — the general cross-links only. `INTERCHANGEABLE_WITH`
// (substitutions, issue #36) is deliberately absent: it has a single implicit phrasing offered on
// its own "Substitutions" surface, so it needs no picker entry here.
export const RELATION_OPTIONS: readonly RelationOption[] = [
  { value: 'works_with', label: 'Works with', kind: 'WORKS_WITH', invert: false },
  { value: 'accessory_for', label: 'Is an accessory for', kind: 'ACCESSORY_FOR', invert: false },
  { value: 'has_accessory', label: 'Has accessory', kind: 'ACCESSORY_FOR', invert: true },
  { value: 'spare_for', label: 'Is a spare for', kind: 'SPARE_FOR', invert: false },
  { value: 'has_spare', label: 'Has spare', kind: 'SPARE_FOR', invert: true },
];

/** Look up a relation option by its `value`. */
export function relationOptionByValue(value: string): RelationOption | undefined {
  return RELATION_OPTIONS.find((o) => o.value === value);
}

/**
 * Build the directed (un-canonicalised) triple an add-UI option describes: a non-inverted option
 * puts the current item as `from`, an inverted one as `to`. `planRelation` then canonicalises +
 * validates it.
 */
export function relationSpecFromOption(
  option: RelationOption,
  currentItemId: string,
  otherItemId: string,
): RelationSpec {
  return option.invert
    ? { fromItemId: otherItemId, toItemId: currentItemId, kind: option.kind }
    : { fromItemId: currentItemId, toItemId: otherItemId, kind: option.kind };
}

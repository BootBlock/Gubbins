import { describe, expect, it } from 'vitest';
import {
  RELATION_KINDS,
  RELATION_LABELS,
  RELATION_OPTIONS,
  SUBSTITUTION_KINDS,
  canonicaliseRelation,
  describeItemRelations,
  dedupeRelations,
  isRelationKind,
  isSubstitutionKind,
  isSymmetricRelationKind,
  itemRelationId,
  normaliseRelationKind,
  planRelation,
  relationDedupeKey,
  relationOptionByValue,
  relationSpecFromOption,
  resolveRelationForItem,
  type RelationKind,
  type RelationSpec,
  type StoredRelation,
} from './item-relations';

// Stable, synthetic item ids ordered A < B < C lexicographically for canonicalisation checks.
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

function stored(id: string, from: string, to: string, kind: RelationKind): StoredRelation {
  return { id, fromItemId: from, toItemId: to, kind };
}

describe('relation kinds & labels', () => {
  it('exposes exactly the known kinds, each with a label pair', () => {
    expect([...RELATION_KINDS]).toEqual(['WORKS_WITH', 'ACCESSORY_FOR', 'SPARE_FOR', 'INTERCHANGEABLE_WITH']);
    for (const kind of RELATION_KINDS) {
      const label = RELATION_LABELS[kind];
      expect(label.forward.length).toBeGreaterThan(0);
      expect(label.reverse.length).toBeGreaterThan(0);
    }
  });

  it('marks the symmetric kinds (forward === reverse iff symmetric)', () => {
    for (const kind of RELATION_KINDS) {
      const label = RELATION_LABELS[kind];
      expect(isSymmetricRelationKind(kind)).toBe(label.symmetric);
      expect(label.forward === label.reverse).toBe(label.symmetric);
    }
    expect(isSymmetricRelationKind('WORKS_WITH')).toBe(true);
    expect(isSymmetricRelationKind('INTERCHANGEABLE_WITH')).toBe(true);
    expect(isSymmetricRelationKind('ACCESSORY_FOR')).toBe(false);
    expect(isSymmetricRelationKind('SPARE_FOR')).toBe(false);
  });

  it('partitions substitution kinds off the general related surface (issue #36)', () => {
    expect([...SUBSTITUTION_KINDS]).toEqual(['INTERCHANGEABLE_WITH']);
    expect(isSubstitutionKind('INTERCHANGEABLE_WITH')).toBe(true);
    expect(isSubstitutionKind('WORKS_WITH')).toBe(false);
    expect(isSubstitutionKind('ACCESSORY_FOR')).toBe(false);
    expect(isSubstitutionKind('SPARE_FOR')).toBe(false);
    // A substitution kind is a real relation kind — it just lives on a different tab.
    for (const kind of SUBSTITUTION_KINDS) expect(isRelationKind(kind)).toBe(true);
    // The general "Related" add-UI never offers a substitution kind (it has its own surface).
    expect(RELATION_OPTIONS.some((o) => isSubstitutionKind(o.kind))).toBe(false);
  });
});

describe('isRelationKind / normaliseRelationKind', () => {
  it('accepts the known kinds and rejects anything else', () => {
    expect(isRelationKind('WORKS_WITH')).toBe(true);
    expect(isRelationKind('ACCESSORY_FOR')).toBe(true);
    expect(isRelationKind('SPARE_FOR')).toBe(true);
    expect(isRelationKind('works_with')).toBe(false); // case-sensitive guard
    expect(isRelationKind('NONSENSE')).toBe(false);
    expect(isRelationKind(42)).toBe(false);
    expect(isRelationKind(null)).toBe(false);
    expect(isRelationKind(undefined)).toBe(false);
  });

  it('coerces forgiving casing/whitespace, rejects the unknown', () => {
    expect(normaliseRelationKind('works_with')).toBe('WORKS_WITH');
    expect(normaliseRelationKind('  Accessory_For  ')).toBe('ACCESSORY_FOR');
    expect(normaliseRelationKind('SPARE_FOR')).toBe('SPARE_FOR');
    expect(normaliseRelationKind('friends_with')).toBeNull();
    expect(normaliseRelationKind('')).toBeNull();
    expect(normaliseRelationKind(null)).toBeNull();
    expect(normaliseRelationKind(undefined)).toBeNull();
  });
});

describe('canonicaliseRelation', () => {
  it('orders a symmetric pair deterministically (smaller id becomes `from`)', () => {
    const ab = canonicaliseRelation({ fromItemId: A, toItemId: B, kind: 'WORKS_WITH' });
    const ba = canonicaliseRelation({ fromItemId: B, toItemId: A, kind: 'WORKS_WITH' });
    expect(ab).toEqual({ fromItemId: A, toItemId: B, kind: 'WORKS_WITH' });
    expect(ba).toEqual(ab); // A↔B and B↔A collapse to the same canonical triple
  });

  it('preserves a directional pair order (direction carries meaning)', () => {
    expect(canonicaliseRelation({ fromItemId: B, toItemId: A, kind: 'ACCESSORY_FOR' })).toEqual({
      fromItemId: B,
      toItemId: A,
      kind: 'ACCESSORY_FOR',
    });
    expect(canonicaliseRelation({ fromItemId: A, toItemId: B, kind: 'SPARE_FOR' })).toEqual({
      fromItemId: A,
      toItemId: B,
      kind: 'SPARE_FOR',
    });
  });
});

describe('itemRelationId (deterministic identity)', () => {
  it('is identical for both orderings of a symmetric relation', () => {
    expect(itemRelationId({ fromItemId: A, toItemId: B, kind: 'WORKS_WITH' })).toBe(
      itemRelationId({ fromItemId: B, toItemId: A, kind: 'WORKS_WITH' }),
    );
  });

  it('differs by direction for a directional relation', () => {
    const aToB = itemRelationId({ fromItemId: A, toItemId: B, kind: 'ACCESSORY_FOR' });
    const bToA = itemRelationId({ fromItemId: B, toItemId: A, kind: 'ACCESSORY_FOR' });
    expect(aToB).not.toBe(bToA);
  });

  it('differs by kind for the same ordered pair', () => {
    expect(itemRelationId({ fromItemId: A, toItemId: B, kind: 'ACCESSORY_FOR' })).not.toBe(
      itemRelationId({ fromItemId: A, toItemId: B, kind: 'SPARE_FOR' }),
    );
  });

  it('embeds the canonical triple joined by pipes', () => {
    expect(itemRelationId({ fromItemId: A, toItemId: B, kind: 'SPARE_FOR' })).toBe(`${A}|${B}|SPARE_FOR`);
  });
});

describe('planRelation', () => {
  it('accepts a valid directional relation and returns its canonical id', () => {
    const plan = planRelation(A, B, 'accessory_for');
    expect(plan).toEqual({
      ok: true,
      spec: { fromItemId: A, toItemId: B, kind: 'ACCESSORY_FOR' },
      id: `${A}|${B}|ACCESSORY_FOR`,
    });
  });

  it('canonicalises a symmetric relation regardless of the input order', () => {
    const plan = planRelation(B, A, 'WORKS_WITH');
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.spec).toEqual({ fromItemId: A, toItemId: B, kind: 'WORKS_WITH' });
      expect(plan.id).toBe(`${A}|${B}|WORKS_WITH`);
    }
  });

  it('rejects a self-relation', () => {
    expect(planRelation(A, A, 'WORKS_WITH')).toEqual({ ok: false, reason: 'SELF' });
  });

  it('rejects an unknown kind (checked before the self-guard)', () => {
    expect(planRelation(A, B, 'bestie')).toEqual({ ok: false, reason: 'INVALID_KIND' });
    expect(planRelation(A, A, 'bestie')).toEqual({ ok: false, reason: 'INVALID_KIND' });
  });
});

describe('relationDedupeKey / dedupeRelations', () => {
  it('keys equal for the two orderings of a symmetric relation', () => {
    expect(relationDedupeKey({ fromItemId: A, toItemId: B, kind: 'WORKS_WITH' })).toBe(
      relationDedupeKey({ fromItemId: B, toItemId: A, kind: 'WORKS_WITH' }),
    );
  });

  it('drops duplicates (including symmetric mirror images), keeping first, order-preserving', () => {
    const specs: RelationSpec[] = [
      { fromItemId: A, toItemId: B, kind: 'WORKS_WITH' },
      { fromItemId: B, toItemId: A, kind: 'WORKS_WITH' }, // mirror of the first → dropped
      { fromItemId: A, toItemId: C, kind: 'ACCESSORY_FOR' },
      { fromItemId: A, toItemId: C, kind: 'ACCESSORY_FOR' }, // exact dup → dropped
      { fromItemId: C, toItemId: A, kind: 'ACCESSORY_FOR' }, // opposite direction → kept
    ];
    expect(dedupeRelations(specs)).toEqual([
      { fromItemId: A, toItemId: B, kind: 'WORKS_WITH' },
      { fromItemId: A, toItemId: C, kind: 'ACCESSORY_FOR' },
      { fromItemId: C, toItemId: A, kind: 'ACCESSORY_FOR' },
    ]);
  });
});

describe('resolveRelationForItem (reciprocity)', () => {
  it('resolves a symmetric relation identically from either end', () => {
    const spec: RelationSpec = { fromItemId: A, toItemId: B, kind: 'WORKS_WITH' };
    expect(resolveRelationForItem(A, spec)).toEqual({
      otherItemId: B,
      kind: 'WORKS_WITH',
      direction: 'symmetric',
      label: 'Works with',
    });
    expect(resolveRelationForItem(B, spec)).toEqual({
      otherItemId: A,
      kind: 'WORKS_WITH',
      direction: 'symmetric',
      label: 'Works with',
    });
  });

  it('flips the label on the `to` end of a directional relation', () => {
    const spec: RelationSpec = { fromItemId: A, toItemId: B, kind: 'ACCESSORY_FOR' };
    // A is the accessory *for* B.
    expect(resolveRelationForItem(A, spec)).toEqual({
      otherItemId: B,
      kind: 'ACCESSORY_FOR',
      direction: 'forward',
      label: 'Accessory for',
    });
    // Viewed from B, B *has the accessory* A.
    expect(resolveRelationForItem(B, spec)).toEqual({
      otherItemId: A,
      kind: 'ACCESSORY_FOR',
      direction: 'reverse',
      label: 'Has accessory',
    });
  });

  it('flips SPARE_FOR too', () => {
    const spec: RelationSpec = { fromItemId: A, toItemId: B, kind: 'SPARE_FOR' };
    expect(resolveRelationForItem(A, spec)?.label).toBe('Spare for');
    expect(resolveRelationForItem(B, spec)?.label).toBe('Has spare');
  });

  it('returns null when the item is neither endpoint', () => {
    expect(resolveRelationForItem(C, { fromItemId: A, toItemId: B, kind: 'WORKS_WITH' })).toBeNull();
  });
});

describe('describeItemRelations', () => {
  it('maps to the viewing perspective, skips unrelated + unknown-kind rows, and sorts stably', () => {
    const rows: StoredRelation[] = [
      stored('r-spare', C, A, 'SPARE_FOR'), // A: "Has spare" C (reverse)
      stored('r-works', A, B, 'WORKS_WITH'), // A: "Works with" B (symmetric)
      stored('r-acc', A, C, 'ACCESSORY_FOR'), // A: "Accessory for" C (forward)
      stored('r-other', B, C, 'WORKS_WITH'), // does not touch A → skipped
      // Corrupt kind (defensive) → skipped.
      { id: 'r-bad', fromItemId: A, toItemId: B, kind: 'NONSENSE' as RelationKind },
    ];
    const resolved = describeItemRelations(A, rows);
    // Sorted by (kind order WORKS_WITH<ACCESSORY_FOR<SPARE_FOR, then direction, then otherItemId).
    expect(resolved.map((r) => [r.id, r.label, r.otherItemId])).toEqual([
      ['r-works', 'Works with', B],
      ['r-acc', 'Accessory for', C],
      ['r-spare', 'Has spare', C],
    ]);
  });

  it('orders forward before reverse within the same kind', () => {
    const rows: StoredRelation[] = [
      stored('r1', C, A, 'ACCESSORY_FOR'), // A has accessory C (reverse)
      stored('r2', A, B, 'ACCESSORY_FOR'), // A accessory for B (forward)
    ];
    expect(describeItemRelations(A, rows).map((r) => r.direction)).toEqual(['forward', 'reverse']);
  });

  it('returns an empty list when nothing touches the item', () => {
    expect(describeItemRelations(A, [stored('r', B, C, 'WORKS_WITH')])).toEqual([]);
  });

  it('restricts to the given kinds when a filter is supplied (issue #36 tab split)', () => {
    const rows: StoredRelation[] = [
      stored('r-works', A, B, 'WORKS_WITH'),
      stored('r-sub', A, C, 'INTERCHANGEABLE_WITH'),
    ];
    // The "Related" surface excludes substitutions…
    expect(describeItemRelations(A, rows, (k) => !isSubstitutionKind(k)).map((r) => r.id)).toEqual([
      'r-works',
    ]);
    // …and the "Substitutions" surface shows only them.
    expect(describeItemRelations(A, rows, isSubstitutionKind)).toMatchObject([
      { id: 'r-sub', otherItemId: C, label: 'Interchangeable with', direction: 'symmetric' },
    ]);
  });
});

describe('RELATION_OPTIONS & relationSpecFromOption', () => {
  it('offers one phrasing per symmetric kind and a pair per directional kind', () => {
    expect(RELATION_OPTIONS.map((o) => o.value)).toEqual([
      'works_with',
      'accessory_for',
      'has_accessory',
      'spare_for',
      'has_spare',
    ]);
    // Directional kinds get both a non-inverted and an inverted phrasing; symmetric only one.
    const byKind = (kind: RelationKind) => RELATION_OPTIONS.filter((o) => o.kind === kind);
    expect(byKind('WORKS_WITH')).toHaveLength(1);
    expect(byKind('ACCESSORY_FOR').map((o) => o.invert)).toEqual([false, true]);
    expect(byKind('SPARE_FOR').map((o) => o.invert)).toEqual([false, true]);
  });

  it('looks an option up by value', () => {
    expect(relationOptionByValue('has_spare')?.kind).toBe('SPARE_FOR');
    expect(relationOptionByValue('nope')).toBeUndefined();
  });

  it('puts the current item as `from` for a non-inverted option', () => {
    const opt = relationOptionByValue('accessory_for')!; // "Is an accessory for"
    expect(relationSpecFromOption(opt, A, B)).toEqual({
      fromItemId: A,
      toItemId: B,
      kind: 'ACCESSORY_FOR',
    });
  });

  it('puts the current item as `to` for an inverted option', () => {
    const opt = relationOptionByValue('has_accessory')!; // "Has accessory"
    expect(relationSpecFromOption(opt, A, B)).toEqual({
      fromItemId: B,
      toItemId: A,
      kind: 'ACCESSORY_FOR',
    });
  });

  it('round-trips an option through planRelation to a resolvable relation', () => {
    // On item A, choosing "Has accessory" for other item B stores B→A ACCESSORY_FOR…
    const opt = relationOptionByValue('has_accessory')!;
    const spec = relationSpecFromOption(opt, A, B);
    const plan = planRelation(spec.fromItemId, spec.toItemId, spec.kind);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      // …and viewed from A that reads back as "Has accessory" of B.
      const view = resolveRelationForItem(A, plan.spec);
      expect(view).toMatchObject({ otherItemId: B, label: 'Has accessory', direction: 'reverse' });
    }
  });
});

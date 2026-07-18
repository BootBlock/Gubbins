/**
 * Unit tests for the pure hard-dependency seam (issue #70) — which stored relations count as
 * prerequisites, which of them are missing, and the per-line answer a bill of materials needs.
 */
import { describe, expect, it } from 'vitest';
import { itemRelationId, type RelationKind, type StoredRelation } from './item-relations';
import {
  missingRequirements,
  missingRequirementsByLine,
  missingRequirementsOf,
  requirementsOf,
} from './item-requirements';

/** Build a stored relation with the deterministic id the repository would mint for it. */
function rel(fromItemId: string, toItemId: string, kind: RelationKind): StoredRelation {
  const spec = { fromItemId, toItemId, kind };
  return { ...spec, id: itemRelationId(spec) };
}

describe('requirementsOf', () => {
  it('returns the items the subject requires (the forward end only)', () => {
    const relations = [rel('ap', 'injector', 'REQUIRES')];
    expect(requirementsOf('ap', relations)).toEqual([
      {
        requiredItemId: 'injector',
        relationId: itemRelationId({ fromItemId: 'ap', toItemId: 'injector', kind: 'REQUIRES' }),
      },
    ]);
  });

  it('does not treat "required by" as a requirement of the subject', () => {
    // The injector is *required by* the access point; lending the injector should not nag about
    // every access point that needs one.
    expect(requirementsOf('injector', [rel('ap', 'injector', 'REQUIRES')])).toEqual([]);
  });

  it('ignores advisory kinds — only REQUIRES has teeth', () => {
    const relations = [
      rel('camera', 'tripod', 'WORKS_WITH'),
      rel('cable', 'laptop', 'ACCESSORY_FOR'),
      rel('belt', 'vacuum', 'SPARE_FOR'),
      rel('bolt-a', 'bolt-b', 'INTERCHANGEABLE_WITH'),
    ];
    expect(requirementsOf('camera', relations)).toEqual([]);
    expect(requirementsOf('cable', relations)).toEqual([]);
    expect(requirementsOf('belt', relations)).toEqual([]);
    expect(requirementsOf('bolt-a', relations)).toEqual([]);
  });

  it('collects several requirements, and ignores relations that do not touch the subject', () => {
    const relations = [
      rel('ap', 'injector', 'REQUIRES'),
      rel('ap', 'bracket', 'REQUIRES'),
      rel('printer', 'build-plate', 'REQUIRES'),
    ];
    expect(
      requirementsOf('ap', relations)
        .map((r) => r.requiredItemId)
        .sort(),
    ).toEqual(['bracket', 'injector']);
  });

  it('is empty for an item with no relations at all', () => {
    expect(requirementsOf('lonely', [])).toEqual([]);
  });
});

describe('missingRequirements', () => {
  const requirements = [
    { requiredItemId: 'injector', relationId: 'r1' },
    { requiredItemId: 'bracket', relationId: 'r2' },
  ];

  it('keeps only the prerequisites not already present', () => {
    expect(missingRequirements(requirements, ['injector'])).toEqual([
      { requiredItemId: 'bracket', relationId: 'r2' },
    ]);
  });

  it('returns everything when nothing is present, and nothing when all are', () => {
    expect(missingRequirements(requirements, [])).toEqual(requirements);
    expect(missingRequirements(requirements, ['injector', 'bracket'])).toEqual([]);
  });

  it('accepts a Set as well as an iterable', () => {
    expect(missingRequirements(requirements, new Set(['bracket']))).toEqual([
      { requiredItemId: 'injector', relationId: 'r1' },
    ]);
  });
});

describe('missingRequirementsOf', () => {
  it('reports the prerequisites of an item taken on its own', () => {
    const missing = missingRequirementsOf('ap', [rel('ap', 'injector', 'REQUIRES')]);
    expect(missing.map((m) => m.requiredItemId)).toEqual(['injector']);
  });

  it('drops a prerequisite already accounted for', () => {
    const relations = [rel('ap', 'injector', 'REQUIRES'), rel('ap', 'bracket', 'REQUIRES')];
    const missing = missingRequirementsOf('ap', relations, ['injector']);
    expect(missing.map((m) => m.requiredItemId)).toEqual(['bracket']);
  });

  it('never reports the subject as its own missing prerequisite', () => {
    // A self-relation is rejected upstream by `planRelation`; this is the defensive belt.
    const selfish: StoredRelation = { id: 'x', fromItemId: 'ap', toItemId: 'ap', kind: 'REQUIRES' };
    expect(missingRequirementsOf('ap', [selfish])).toEqual([]);
  });
});

describe('missingRequirementsByLine', () => {
  it('flags a line whose prerequisite no other line covers', () => {
    const relations = new Map([['ap', [rel('ap', 'injector', 'REQUIRES')]]]);
    const result = missingRequirementsByLine(['ap', 'cable'], relations);
    expect([...result.keys()]).toEqual(['ap']);
    expect(result.get('ap')!.map((r) => r.requiredItemId)).toEqual(['injector']);
  });

  it('reports nothing when the BOM already lists both ends', () => {
    const relations = new Map([
      ['ap', [rel('ap', 'injector', 'REQUIRES')]],
      ['injector', [rel('ap', 'injector', 'REQUIRES')]],
    ]);
    expect(missingRequirementsByLine(['ap', 'injector'], relations).size).toBe(0);
  });

  it('handles a line item with no relations recorded at all', () => {
    expect(missingRequirementsByLine(['plain'], new Map()).size).toBe(0);
  });

  it('de-duplicates a repeated line item', () => {
    const relations = new Map([['ap', [rel('ap', 'injector', 'REQUIRES')]]]);
    const result = missingRequirementsByLine(['ap', 'ap'], relations);
    expect(result.size).toBe(1);
    expect(result.get('ap')).toHaveLength(1);
  });

  it('is empty for an empty bill of materials', () => {
    expect(missingRequirementsByLine([], new Map()).size).toBe(0);
  });
});

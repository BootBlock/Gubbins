import { describe, it, expect } from 'vitest';
import {
  planKitEdgeRemap,
  planRelationRemap,
  type ItemRelationEdge,
  type KitComponentEdge,
} from './reference-remap';

/**
 * The two re-point planners a merge cannot do with a plain `UPDATE` (issue #99). Each case here
 * is a row the merge would otherwise hand to SQLite for it to refuse — a duplicate against a
 * `UNIQUE` index, a self-reference against a `CHECK`, a derived id that no longer describes its
 * row — plus the containment cycle no constraint would catch at all.
 */

const KEEP = 'keep';
const GONE = 'gone';

function edge(id: string, kitItemId: string, componentItemId: string): KitComponentEdge {
  return { id, kitItemId, componentItemId };
}

describe('planKitEdgeRemap', () => {
  it('does nothing when no edge touches the removed item', () => {
    expect(planKitEdgeRemap([edge('e1', 'a', 'b')], GONE, KEEP)).toEqual({ remapped: [], dropped: [] });
  });

  it('re-points a component edge onto the kept item', () => {
    const plan = planKitEdgeRemap([edge('e1', 'kit', GONE)], GONE, KEEP);
    expect(plan.remapped).toEqual([edge('e1', 'kit', KEEP)]);
    expect(plan.dropped).toEqual([]);
  });

  it('re-points a kit edge onto the kept item', () => {
    const plan = planKitEdgeRemap([edge('e1', GONE, 'part')], GONE, KEEP);
    expect(plan.remapped).toEqual([edge('e1', KEEP, 'part')]);
  });

  it('drops an edge that would make the kept item contain itself', () => {
    const plan = planKitEdgeRemap([edge('e1', KEEP, GONE)], GONE, KEEP);
    expect(plan.remapped).toEqual([]);
    expect(plan.dropped).toEqual(['e1']);
  });

  it('drops an edge the kit already has, rather than duplicating it', () => {
    const edges = [edge('e1', 'kit', KEEP), edge('e2', 'kit', GONE)];
    const plan = planKitEdgeRemap(edges, GONE, KEEP);
    expect(plan.remapped).toEqual([]);
    expect(plan.dropped).toEqual(['e2']);
  });

  it('drops an edge that would close a containment cycle', () => {
    // KEEP already contains "mid", and "mid" contains GONE. Re-pointing GONE's own kit edge onto
    // KEEP would make KEEP a component of something it contains.
    const edges = [edge('e1', KEEP, 'mid'), edge('e2', 'mid', GONE), edge('e3', GONE, KEEP)];
    const plan = planKitEdgeRemap(edges, GONE, KEEP);
    expect(plan.remapped).toEqual([]);
    expect(plan.dropped.sort()).toEqual(['e2', 'e3']);
  });

  it('never drops an edge that does not touch the removed item', () => {
    const untouched = edge('e1', 'kit', KEEP);
    const plan = planKitEdgeRemap([untouched, edge('e2', 'kit', GONE)], GONE, KEEP);
    expect(plan.dropped).toEqual(['e2']);
    expect(plan.remapped).toEqual([]);
  });

  it('collapses two edges that fold onto the same pair, keeping the lower id', () => {
    const edges = [edge('e2', 'kit', GONE), edge('e1', 'kit', GONE)];
    const plan = planKitEdgeRemap(edges, GONE, KEEP);
    expect(plan.remapped).toEqual([edge('e1', 'kit', KEEP)]);
    expect(plan.dropped).toEqual(['e2']);
  });
});

function relation(id: string, fromItemId: string, toItemId: string, kind: string): ItemRelationEdge {
  return { id, fromItemId, toItemId, kind };
}

describe('planRelationRemap', () => {
  it('does nothing when no relation touches the removed item', () => {
    const rows = [relation('a|b|REQUIRES', 'a', 'b', 'REQUIRES')];
    expect(planRelationRemap(rows, GONE, KEEP)).toEqual({ remapped: [], dropped: [] });
  });

  it('re-keys a moved relation, because the id is derived from its endpoints', () => {
    const rows = [relation(`${GONE}|b|REQUIRES`, GONE, 'b', 'REQUIRES')];
    const plan = planRelationRemap(rows, GONE, KEEP);
    expect(plan.remapped).toEqual([
      {
        oldId: `${GONE}|b|REQUIRES`,
        id: `${KEEP}|b|REQUIRES`,
        fromItemId: KEEP,
        toItemId: 'b',
        kind: 'REQUIRES',
      },
    ]);
    expect(plan.dropped).toEqual([]);
  });

  it('canonicalises a symmetric kind, so the new id is the one an ordinary add would mint', () => {
    const rows = [relation(`${GONE}|aaa|WORKS_WITH`, GONE, 'aaa', 'WORKS_WITH')];
    const plan = planRelationRemap(rows, GONE, KEEP);
    // 'aaa' sorts below 'keep', so it becomes the `from` endpoint.
    expect(plan.remapped[0]).toMatchObject({
      id: `aaa|${KEEP}|WORKS_WITH`,
      fromItemId: 'aaa',
      toItemId: KEEP,
    });
  });

  it('drops a relation between the two merged items — it would relate the keeper to itself', () => {
    const rows = [relation(`${GONE}|${KEEP}|WORKS_WITH`, GONE, KEEP, 'WORKS_WITH')];
    const plan = planRelationRemap(rows, GONE, KEEP);
    expect(plan.remapped).toEqual([]);
    expect(plan.dropped).toEqual([`${GONE}|${KEEP}|WORKS_WITH`]);
  });

  it('drops a relation the kept item already holds', () => {
    const rows = [
      relation(`${KEEP}|b|REQUIRES`, KEEP, 'b', 'REQUIRES'),
      relation(`${GONE}|b|REQUIRES`, GONE, 'b', 'REQUIRES'),
    ];
    const plan = planRelationRemap(rows, GONE, KEEP);
    expect(plan.remapped).toEqual([]);
    expect(plan.dropped).toEqual([`${GONE}|b|REQUIRES`]);
  });

  it('drops a relation whose kind this build does not recognise', () => {
    // A value only a newer peer understands. It cannot be re-canonicalised without guessing what
    // the kind means, and guessing wrong would mint a row under a key nothing else agrees on.
    const rows = [relation(`${GONE}|b|FROM_THE_FUTURE`, GONE, 'b', 'FROM_THE_FUTURE')];
    const plan = planRelationRemap(rows, GONE, KEEP);
    expect(plan.remapped).toEqual([]);
    expect(plan.dropped).toEqual([`${GONE}|b|FROM_THE_FUTURE`]);
  });

  it('does not let two moved relations collide on one new id', () => {
    const rows = [
      relation(`${GONE}|b|WORKS_WITH`, GONE, 'b', 'WORKS_WITH'),
      relation(`b|${GONE}|WORKS_WITH`, 'b', GONE, 'WORKS_WITH'),
    ];
    const plan = planRelationRemap(rows, GONE, KEEP);
    expect(plan.remapped).toHaveLength(1);
    expect(plan.dropped).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { findKitCycleBreaks, kitRejectionMessage, validateKitLink, type KitEdge } from './kits';

/**
 * The pure kit-linkage rules: the write-time guard (`validateKitLink`) that keeps one device's
 * containment graph acyclic, and the post-merge repair (`findKitCycleBreaks`) that restores the
 * same invariant after two devices each make a locally valid nesting move (issue #539).
 */
describe('validateKitLink', () => {
  it('rejects an item as a component of itself', () => {
    expect(validateKitLink({ kitId: 'a', componentId: 'a', componentDescendantIds: [] })).toBe('SELF');
  });

  it('rejects a link the kit already sits below', () => {
    expect(validateKitLink({ kitId: 'a', componentId: 'b', componentDescendantIds: ['b', 'a'] })).toBe(
      'CYCLE',
    );
  });

  it('accepts an ordinary link', () => {
    expect(validateKitLink({ kitId: 'a', componentId: 'b', componentDescendantIds: ['b', 'c'] })).toBeNull();
  });

  it('phrases each rejection for a toast', () => {
    expect(kitRejectionMessage('SELF')).toMatch(/itself/);
    expect(kitRejectionMessage('CYCLE')).toMatch(/circular/);
  });
});

describe('findKitCycleBreaks (issue #539)', () => {
  const edge = (id: string, kitId: string, componentId: string, createdAt: number): KitEdge => ({
    id,
    kitId,
    componentId,
    createdAt,
  });

  it('returns nothing for an acyclic graph', () => {
    expect(
      findKitCycleBreaks([edge('e1', 'X', 'Y', 100), edge('e2', 'Y', 'Z', 200), edge('e3', 'X', 'Z', 300)]),
    ).toEqual([]);
  });

  it('returns nothing for an empty edge set', () => {
    expect(findKitCycleBreaks([])).toEqual([]);
  });

  it('drops the later of the two links that close a loop', () => {
    const breaks = findKitCycleBreaks([edge('e1', 'X', 'Y', 100), edge('e2', 'Y', 'X', 200)]);
    expect(breaks.map((b) => b.id)).toEqual(['e2']);
  });

  it('reaches the same verdict whichever order the edges arrive in', () => {
    const a = edge('e1', 'X', 'Y', 100);
    const b = edge('e2', 'Y', 'X', 200);
    expect(findKitCycleBreaks([a, b])).toEqual(findKitCycleBreaks([b, a]));
  });

  it('breaks a created_at tie by the smaller id', () => {
    const breaks = findKitCycleBreaks([edge('e2', 'X', 'Y', 100), edge('e1', 'Y', 'X', 100)]);
    expect(breaks.map((b) => b.id)).toEqual(['e2']); // e1 is admitted first and keeps its link
  });

  it('drops only the newest link of a longer loop', () => {
    const breaks = findKitCycleBreaks([
      edge('e1', 'X', 'Y', 100),
      edge('e2', 'Y', 'Z', 150),
      edge('e3', 'Z', 'X', 200),
    ]);
    expect(breaks.map((b) => b.id)).toEqual(['e3']);
  });

  it('keeps a diamond, where two kits share one component but nothing loops', () => {
    expect(
      findKitCycleBreaks([
        edge('e1', 'X', 'Y', 100),
        edge('e2', 'X', 'Z', 110),
        edge('e3', 'Y', 'W', 120),
        edge('e4', 'Z', 'W', 130),
      ]),
    ).toEqual([]);
  });

  it('breaks two independent loops, one link each', () => {
    const breaks = findKitCycleBreaks([
      edge('e1', 'X', 'Y', 100),
      edge('e2', 'Y', 'X', 200),
      edge('e3', 'P', 'Q', 300),
      edge('e4', 'Q', 'P', 400),
    ]);
    expect(breaks.map((b) => b.id).sort()).toEqual(['e2', 'e4']);
  });

  it('drops a self-link a corrupt graph somehow carries', () => {
    const breaks = findKitCycleBreaks([edge('e1', 'X', 'X', 100), edge('e2', 'X', 'Y', 200)]);
    expect(breaks.map((b) => b.id)).toEqual(['e1']);
  });

  it('breaks every link that closes a loop when a graph carries two of them', () => {
    // Z → X closes X → Y → Z, and the newer Y → X closes X → Y; both have to go.
    const breaks = findKitCycleBreaks([
      edge('e1', 'X', 'Y', 100),
      edge('e2', 'Y', 'Z', 150),
      edge('e3', 'Z', 'X', 200),
      edge('e4', 'Y', 'X', 250),
    ]);
    expect(breaks.map((b) => b.id)).toEqual(['e3', 'e4']);
  });
});

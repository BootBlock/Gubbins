import { describe, it, expect } from 'vitest';
import type { LocationDeleteImpact } from '@/db/repositories';
import { summariseLocationDelete } from './location-delete-impact';

const NOTHING: LocationDeleteImpact = {
  itemsHere: 0,
  stockUnitsHere: 0,
  openLoansHere: 0,
  childLocations: 0,
  itemsBelow: 0,
  promotedToName: null,
  photos: 0,
  regions: 0,
  tags: 0,
  fieldValues: 0,
};

const keys = (lines: readonly { key: string }[]) => lines.map((l) => l.key);

describe('summariseLocationDelete', () => {
  it('says nothing about a location that holds nothing', () => {
    const summary = summariseLocationDelete(NOTHING, 'the top level');
    expect(summary.moves).toEqual([]);
    expect(summary.destroys).toEqual([]);
  });

  it('keeps what is destroyed apart from what merely moves', () => {
    const summary = summariseLocationDelete(
      { ...NOTHING, itemsHere: 3, childLocations: 1, photos: 2, tags: 1 },
      'Workshop',
    );
    expect(keys(summary.moves)).toEqual([
      'inventory.locations.delete.moves.items',
      'inventory.locations.delete.moves.children',
    ]);
    expect(keys(summary.destroys)).toEqual([
      'inventory.locations.delete.destroys.photos',
      'inventory.locations.delete.destroys.tags',
    ]);
  });

  it('names the promotion target on the sub-locations line', () => {
    const summary = summariseLocationDelete({ ...NOTHING, childLocations: 2 }, 'Workshop');
    expect(summary.moves[0]?.vars).toEqual({ count: 2, parent: 'Workshop' });
  });

  it('reports the destroyed photos, regions, tags and field values of a location with no items', () => {
    // The issue's case: a shelf the sidebar shows as empty, whose whole record goes with it.
    const summary = summariseLocationDelete(
      { ...NOTHING, photos: 1, regions: 4, tags: 2, fieldValues: 3 },
      'the top level',
    );
    expect(summary.moves).toEqual([]);
    expect(summary.destroys.map((l) => [l.key, l.vars.count])).toEqual([
      ['inventory.locations.delete.destroys.photos', 1],
      ['inventory.locations.delete.destroys.regions', 4],
      ['inventory.locations.delete.destroys.tags', 2],
      ['inventory.locations.delete.destroys.fields', 3],
    ]);
  });

  it('carries the subtree total the direct item count could not see', () => {
    const summary = summariseLocationDelete(
      { ...NOTHING, childLocations: 1, itemsBelow: 40, promotedToName: 'Workshop' },
      'Workshop',
    );
    expect(keys(summary.moves)).toEqual([
      'inventory.locations.delete.moves.children',
      'inventory.locations.delete.moves.itemsBelow',
    ]);
    expect(summary.moves[1]?.vars).toEqual({ count: 40 });
  });

  it('names the stock and the loans a location holds on other items behalf', () => {
    const summary = summariseLocationDelete({ ...NOTHING, stockUnitsHere: 12, openLoansHere: 1 }, 'X');
    expect(keys(summary.moves)).toEqual([
      'inventory.locations.delete.moves.stock',
      'inventory.locations.delete.moves.loans',
    ]);
  });
});

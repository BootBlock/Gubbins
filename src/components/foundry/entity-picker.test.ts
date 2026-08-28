import { describe, it, expect } from 'vitest';
import { buildPickerLabelMap } from './entity-picker';

/**
 * A combobox resolves what the user accepted by its *label*, so the map's job is to keep every row
 * individually reachable even when two of them are named the same. These pin the disambiguation:
 * without it the second row is shadowed by the first and can never be picked.
 */
const row = (id: string, name: string) => ({ id, name });
const access = {
  labelFor: (r: { name: string }) => r.name,
  idFor: (r: { id: string }) => r.id,
};

describe('buildPickerLabelMap', () => {
  it('labels each row by its name, in the order given', () => {
    const map = buildPickerLabelMap([row('a', 'Bolt'), row('b', 'Nut')], access);
    expect([...map.keys()]).toEqual(['Bolt', 'Nut']);
    expect(map.get('Nut')).toEqual(row('b', 'Nut'));
  });

  it('keeps a repeated name resolvable by qualifying the later rows with an id fragment', () => {
    const map = buildPickerLabelMap(
      [row('aaaaaaaa-1', 'Bolt'), row('bbbbbbbb-2', 'Bolt'), row('cccccccc-3', 'Bolt')],
      access,
    );
    expect([...map.keys()]).toEqual(['Bolt', 'Bolt (bbbbbb)', 'Bolt (cccccc)']);
    // Each label resolves back to its own row — the point of the exercise.
    expect(map.get('Bolt')?.id).toBe('aaaaaaaa-1');
    expect(map.get('Bolt (bbbbbb)')?.id).toBe('bbbbbbbb-2');
    expect(map.get('Bolt (cccccc)')?.id).toBe('cccccccc-3');
  });

  it('is empty for no rows', () => {
    expect(buildPickerLabelMap([], access).size).toBe(0);
  });
});

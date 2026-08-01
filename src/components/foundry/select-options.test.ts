import { describe, it, expect } from 'vitest';
import { filterSelectOptions, trailingActionStart } from './select-options';

const bins = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ value: `bin-${index}`, label: `Bin ${index}` }));

describe('filterSelectOptions', () => {
  const options = [
    { value: 'a', label: 'Workshop / Shelf A' },
    { value: 'b', label: 'Workshop / Shelf B' },
    { value: 'c', label: 'Garage / Bin 4' },
    { value: 'new', label: '＋ New location…', kind: 'action' as const },
  ];

  it('returns the list untouched for an empty query', () => {
    expect(filterSelectOptions(options, '   ')).toBe(options);
  });

  it('keeps only options matching every whitespace-separated term, case-insensitively', () => {
    expect(filterSelectOptions(options, 'shelf').map((o) => o.value)).toEqual(['a', 'b', 'new']);
    expect(filterSelectOptions(options, 'WORKSHOP b').map((o) => o.value)).toEqual(['b', 'new']);
  });

  it('preserves the caller’s order rather than ranking prefix matches first', () => {
    // "Bin store" is a *prefix* match and "Workshop / Bin 4" only a substring one, so a ranking
    // filter (the model `autocomplete-filter.ts` uses) would hoist it — reordering rows whose
    // indentation is drawing a hierarchy. Input order has to win.
    const hierarchy = [
      { value: 'w', label: 'Workshop / Bin 4' },
      { value: 's', label: 'Bin store / Crate 1' },
    ];
    expect(filterSelectOptions(hierarchy, 'bin').map((o) => o.value)).toEqual(['w', 's']);
  });

  it('always keeps command rows, so “create it, then” survives a query that matches nothing', () => {
    expect(filterSelectOptions(options, 'nothing-matches-this').map((o) => o.value)).toEqual(['new']);
  });
});

describe('trailingActionStart', () => {
  it('counts the ordinary options before the pinned command rows', () => {
    expect(trailingActionStart([])).toBe(0);
    expect(trailingActionStart(bins(3))).toBe(3);
    expect(trailingActionStart([...bins(3), { label: '＋ New…', kind: 'action' }])).toBe(3);
    expect(
      trailingActionStart([...bins(2), { label: '＋ A', kind: 'action' }, { label: '＋ B', kind: 'action' }]),
    ).toBe(2);
  });

  it('only treats a *trailing* run as commands, so a mid-list one stays in the windowed region', () => {
    expect(trailingActionStart([{ label: '＋ New…', kind: 'action' }, ...bins(2)])).toBe(3);
  });
});

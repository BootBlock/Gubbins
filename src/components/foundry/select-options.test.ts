import { describe, it, expect } from 'vitest';
import {
  SELECT_FALLBACK_VIEWPORT,
  SELECT_OPTION_HEIGHT,
  SELECT_WINDOW_OVERSCAN,
  filterSelectOptions,
  scrollTopForRow,
  selectWindow,
  trailingActionStart,
} from './select-options';

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

  it('preserves the caller’s order rather than ranking prefixes first', () => {
    // "Shelf B" is a later row than "Shelf A" and stays later: these labels draw a hierarchy.
    expect(filterSelectOptions(options, 'o').map((o) => o.value)).toEqual(['a', 'b', 'new']);
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

describe('selectWindow', () => {
  it('renders the top of a long list plus overscan when unscrolled', () => {
    const win = selectWindow(3000, 0, 240, 32);
    expect(win.start).toBe(0);
    // 240 / 32 rows of viewport, overscanned at both edges.
    expect(win.end).toBe(Math.ceil(240 / 32) + SELECT_WINDOW_OVERSCAN * 2);
    expect(win.padTop).toBe(0);
  });

  it('windows the list rather than capping it — the spacers restore the full height', () => {
    for (const scrollTop of [0, 1600, 48_000, 95_000]) {
      const win = selectWindow(3000, scrollTop, 240, 32);
      expect(win.padTop + (win.end - win.start) * 32 + win.padBottom).toBe(3000 * 32);
    }
  });

  it('follows the scroll position, keeping overscan above the first visible row', () => {
    const win = selectWindow(3000, 1600, 240, 32);
    expect(win.start).toBe(1600 / 32 - SELECT_WINDOW_OVERSCAN);
    expect(win.padTop).toBe(win.start * 32);
    expect(win.end).toBeGreaterThan(win.start);
  });

  it('falls back to the nominal figures when nothing has been laid out yet', () => {
    const win = selectWindow(3000, 0, 0, 0);
    expect(win.end).toBe(
      Math.ceil(SELECT_FALLBACK_VIEWPORT / SELECT_OPTION_HEIGHT) + SELECT_WINDOW_OVERSCAN * 2,
    );
    expect(win.padBottom).toBe((3000 - win.end) * SELECT_OPTION_HEIGHT);
  });

  it('is empty for an empty list and never runs past the end of a short one', () => {
    expect(selectWindow(0, 0, 240, 32)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    const win = selectWindow(3, 0, 240, 32);
    expect(win).toEqual({ start: 0, end: 3, padTop: 0, padBottom: 0 });
  });
});

describe('scrollTopForRow', () => {
  it('leaves the scroll alone when the row is already in view', () => {
    expect(scrollTopForRow(10, 320, 240, 32)).toBe(320);
  });

  it('scrolls up to the row when it sits above the viewport', () => {
    expect(scrollTopForRow(2, 320, 240, 32)).toBe(64);
  });

  it('scrolls down by the least it can when the row sits below the viewport', () => {
    // Row 20 ends at 672px; the viewport is 240px tall, so it must start at 432px.
    expect(scrollTopForRow(20, 0, 240, 32)).toBe(432);
  });
});

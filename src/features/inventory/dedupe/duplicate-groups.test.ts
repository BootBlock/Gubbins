import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DUPLICATE_SIGNALS,
  MAX_BLOCK_SIZE,
  findDuplicateGroups,
  suggestKeeper,
  type DuplicateCandidate,
} from './duplicate-groups';

/**
 * Pure duplicate detection (issue #99). Covers each signal on its own, the transitive grouping
 * that makes a cluster rather than a pile of pairs, and the two limits the fuzzy pass is honest
 * about — its threshold and its blocking.
 */

let seq = 0;

function item(over: Partial<DuplicateCandidate> & { readonly name: string }): DuplicateCandidate {
  seq += 1;
  return {
    id: `id-${String(seq).padStart(3, '0')}`,
    barcode: null,
    serialNumber: null,
    mpn: null,
    manufacturer: null,
    quantity: 0,
    createdAt: seq,
    ...over,
  };
}

const exact = { signals: DEFAULT_DUPLICATE_SIGNALS };

/**
 * One of many names sharing the word "widget" and nothing else — with each other or with
 * anything the tests probe. The long pseudo-random word keeps every pair far below any
 * similarity threshold, so the filler's only effect is the size of the "widget" block.
 */
function filler(index: number): string {
  let x = (index + 1) * 2654435761;
  let word = '';
  for (let k = 0; k < 24; k++) {
    x = (x * 1103515245 + 12345) >>> 0;
    word += 'abcdefghijklmnopqrstuvwxyz'[x % 26];
  }
  return `${word} widget`;
}

describe('findDuplicateGroups', () => {
  it('groups names that differ only by case, spacing or Unicode composition', () => {
    const rows = [item({ name: 'Socket screw' }), item({ name: '  SOCKET SCREW ' })];
    const groups = findDuplicateGroups(rows, exact);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members.map((m) => m.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(groups[0]!.signals).toEqual(['name']);
  });

  it('folds a name SQLite could not — GRÖSSE and Größe are one key', () => {
    const rows = [item({ name: 'Größe' }), item({ name: 'GRÖSSE' })];
    expect(findDuplicateGroups(rows, exact)).toHaveLength(1);
  });

  it('does not group two blank-named items', () => {
    const rows = [item({ name: '   ' }), item({ name: '' })];
    expect(findDuplicateGroups(rows, exact)).toEqual([]);
  });

  it('groups a UPC-E barcode with the UPC-A it compresses', () => {
    const rows = [
      item({ name: 'Batteries', barcode: '04963406' }),
      item({ name: 'Cells', barcode: '049000006346' }),
    ];
    const groups = findDuplicateGroups(rows, exact);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.signals).toEqual(['barcode']);
  });

  it('never pairs on a blank barcode, serial or part number', () => {
    const rows = [
      item({ name: 'Widget A', barcode: '', serialNumber: '  ', mpn: null }),
      item({ name: 'Widget B', barcode: '', serialNumber: '', mpn: '' }),
    ];
    expect(findDuplicateGroups(rows, exact)).toEqual([]);
  });

  it('keys a part number by its manufacturer, so two makers sharing an MPN stay apart', () => {
    const rows = [
      item({ name: 'Resistor A', mpn: 'RC0805', manufacturer: 'Yageo' }),
      item({ name: 'Resistor B', mpn: 'RC0805', manufacturer: 'Vishay' }),
      item({ name: 'Resistor C', mpn: 'rc0805', manufacturer: 'YAGEO' }),
    ];
    const groups = findDuplicateGroups(rows, exact);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members.map((m) => m.name).sort()).toEqual(['Resistor A', 'Resistor C']);
  });

  it('is transitive — A shares a barcode with B, B a name with C, so all three are one group', () => {
    const a = item({ name: 'Drill', barcode: '5012345678900' });
    const b = item({ name: 'Cordless drill', barcode: '5012345678900' });
    const c = item({ name: 'CORDLESS DRILL' });
    const groups = findDuplicateGroups([a, b, c], exact);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toHaveLength(3);
    expect(groups[0]!.signals).toEqual(['name', 'barcode']);
  });

  it('finds nothing when no signal is enabled', () => {
    const rows = [item({ name: 'Same' }), item({ name: 'Same' })];
    expect(findDuplicateGroups(rows, { signals: [] })).toEqual([]);
  });

  it('reports only the signals actually asked for', () => {
    const rows = [
      item({ name: 'Same', barcode: '5012345678900' }),
      item({ name: 'Same', barcode: '5012345678900' }),
    ];
    expect(findDuplicateGroups(rows, { signals: ['barcode'] })[0]!.signals).toEqual(['barcode']);
  });

  it('orders groups largest first, and members by name, so a re-scan does not reshuffle', () => {
    const rows = [
      item({ name: 'Zeta' }),
      item({ name: 'Zeta' }),
      item({ name: 'Alpha' }),
      item({ name: 'Alpha' }),
      item({ name: 'Alpha' }),
    ];
    const groups = findDuplicateGroups(rows, exact);
    expect(groups.map((g) => g.members.length)).toEqual([3, 2]);
    expect(groups[0]!.members.map((m) => m.name)).toEqual(['Alpha', 'Alpha', 'Alpha']);
  });

  it('gives a group the lowest member id, so the id survives a re-scan', () => {
    const rows = [item({ name: 'Same' }), item({ name: 'same' })];
    const expected = [...rows.map((r) => r.id)].sort()[0];
    expect(findDuplicateGroups(rows, exact)[0]!.id).toBe(expected);
    expect(findDuplicateGroups([...rows].reverse(), exact)[0]!.id).toBe(expected);
  });

  describe('the fuzzy signal', () => {
    const fuzzy = { signals: ['similar-name'] as const, similarityThreshold: 0.85 };

    it('pairs a name and its near-miss', () => {
      const rows = [item({ name: 'Screwdriver set' }), item({ name: 'Screwdriver sets' })];
      const groups = findDuplicateGroups(rows, fuzzy);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.signals).toEqual(['similar-name']);
    });

    it('leaves sibling products apart at the default threshold', () => {
      const rows = [item({ name: 'M3 x 10 socket screw' }), item({ name: 'M3 x 12 socket screw' })];
      // Deliberately close, and deliberately *not* a duplicate: one character in twenty is under
      // the threshold, which is the whole reason the threshold exists.
      expect(findDuplicateGroups(rows, { ...fuzzy, similarityThreshold: 0.98 })).toEqual([]);
    });

    it('is off unless asked for', () => {
      const rows = [item({ name: 'Screwdriver set' }), item({ name: 'Screwdriver sets' })];
      expect(findDuplicateGroups(rows, exact)).toEqual([]);
    });

    // These two are a genuine near-match (two edits in twenty-eight characters) whose *only*
    // shared block is the word "widget" — their opening three characters differ, and so does
    // every other word. That is what makes them the right probe for the block cap.
    const onlySharedWordIsWidget = ['qbcdefghij widget klmnopqrst', 'zbcdefghij widget klmnopqrsu'];

    it('finds a pair whose only shared block stays under the cap', () => {
      const rows = onlySharedWordIsWidget.map((name) => item({ name }));
      expect(findDuplicateGroups(rows, fuzzy)).toHaveLength(1);
    });

    it('skips a block larger than MAX_BLOCK_SIZE, so the same pair goes unfound', () => {
      // The filler shares "widget" with the pair and nothing else, pushing that one block past
      // the cap. Nothing else connects the pair, so the skip is the whole difference — the recall
      // cost the module documents, made visible.
      const rows = [
        ...Array.from({ length: MAX_BLOCK_SIZE }, (_, i) => item({ name: filler(i) })),
        ...onlySharedWordIsWidget.map((name) => item({ name })),
      ];
      expect(findDuplicateGroups(rows, fuzzy)).toEqual([]);
    });
  });
});

describe('suggestKeeper', () => {
  it('proposes the member holding the most stock', () => {
    const members = [
      item({ name: 'A', quantity: 2, createdAt: 1 }),
      item({ name: 'B', quantity: 9, createdAt: 2 }),
    ];
    expect(suggestKeeper(members)!.name).toBe('B');
  });

  it('breaks a stock tie by age, oldest first', () => {
    const members = [
      item({ name: 'Newer', quantity: 3, createdAt: 500 }),
      item({ name: 'Older', quantity: 3, createdAt: 100 }),
    ];
    expect(suggestKeeper(members)!.name).toBe('Older');
  });

  it('is undefined for an empty group', () => {
    expect(suggestKeeper([])).toBeUndefined();
  });
});

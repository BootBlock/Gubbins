import { describe, it, expect } from 'vitest';
import { HISTORY_ACTIONS, type ItemHistoryEntry } from '@/db/repositories';
import { describeHistoryEntry, historyActionLabel } from './history-format';

/** Build an `ItemHistoryEntry` fixture with sensible defaults. */
function entry(over: Partial<ItemHistoryEntry> = {}): ItemHistoryEntry {
  return {
    id: 'h1',
    itemId: 'i1',
    action: 'CREATED',
    quantityDelta: null,
    netValueDelta: null,
    note: null,
    metadata: null,
    actorUserId: 'user-ada',
    actorDisplayName: 'Ada Okafor',
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

describe('historyActionLabel — Activity Log action titles (spec §4 Activity Log, §4.1.3)', () => {
  it('gives every known action a non-empty British-English title', () => {
    for (const action of HISTORY_ACTIONS) {
      const label = historyActionLabel(action);
      expect(label.length).toBeGreaterThan(0);
      // Titles are human prose, never the raw SCREAMING_SNAKE enum value.
      expect(label).not.toBe(action);
      expect(label).not.toMatch(/_/);
    }
  });

  it('maps representative actions to their exact titles', () => {
    expect(historyActionLabel('CREATED')).toBe('Created');
    expect(historyActionLabel('QUANTITY_CHANGE')).toBe('Quantity changed');
    expect(historyActionLabel('GAUGE_UPDATE')).toBe('Gauge updated');
    expect(historyActionLabel('RE_PARENTED')).toBe('Re-parented');
    expect(historyActionLabel('CHECKED_OUT')).toBe('Checked out');
    expect(historyActionLabel('RECONCILED')).toBe('Reconciled');
    // Kits v2 assemble/disassemble.
    expect(historyActionLabel('ASSEMBLED')).toBe('Assembled');
    expect(historyActionLabel('DISASSEMBLED')).toBe('Disassembled');
  });

  it('humanises an unknown/forward-compat action rather than echoing the enum', () => {
    // A newer peer could sync an action this build does not yet know (§7.3).
    const label = historyActionLabel('SOME_FUTURE_ACTION');
    expect(label).toBe('Some future action');
    expect(label).not.toMatch(/_/);
  });
});

describe('describeHistoryEntry — one ledger row for the Activity Log view', () => {
  it('surfaces the stored note as the detail line', () => {
    const view = describeHistoryEntry(entry({ action: 'RENAMED', note: 'Renamed "A" → "B".' }));
    expect(view.label).toBe('Renamed');
    expect(view.detail).toBe('Renamed "A" → "B".');
  });

  it('treats a blank or whitespace-only note as no detail', () => {
    expect(describeHistoryEntry(entry({ note: '' })).detail).toBeNull();
    expect(describeHistoryEntry(entry({ note: '   ' })).detail).toBeNull();
    expect(describeHistoryEntry(entry({ note: null })).detail).toBeNull();
  });

  it('formats a positive quantity delta as a signed badge with a positive tone', () => {
    const view = describeHistoryEntry(entry({ action: 'QUANTITY_CHANGE', quantityDelta: 3 }));
    expect(view.delta).toBe('+3');
    expect(view.tone).toBe('positive');
  });

  it('formats a negative quantity delta with a leading minus and a negative tone', () => {
    const view = describeHistoryEntry(entry({ action: 'QUANTITY_CHANGE', quantityDelta: -2 }));
    expect(view.delta).toBe('−2');
    expect(view.tone).toBe('negative');
  });

  it('falls back to the net-value delta when there is no quantity delta', () => {
    const view = describeHistoryEntry(entry({ action: 'GAUGE_UPDATE', netValueDelta: -45.5 }));
    expect(view.delta).toBe('−45.5');
    expect(view.tone).toBe('negative');
  });

  it('prefers the quantity delta over the net-value delta when both are present', () => {
    const view = describeHistoryEntry(entry({ action: 'RECONCILED', quantityDelta: 4, netValueDelta: 9 }));
    expect(view.delta).toBe('+4');
  });

  it('shows no delta badge for a zero or absent delta (neutral tone)', () => {
    expect(describeHistoryEntry(entry({ action: 'MOVED' })).delta).toBeNull();
    expect(describeHistoryEntry(entry({ action: 'MOVED' })).tone).toBe('neutral');
    expect(describeHistoryEntry(entry({ quantityDelta: 0 })).delta).toBeNull();
    expect(describeHistoryEntry(entry({ quantityDelta: 0 })).tone).toBe('neutral');
  });
});

describe('parseHistoryChanges — the before/after values an entry recorded (issues #144, #486)', () => {
  it('parses the metadata records an edit writes', () => {
    const view = describeHistoryEntry(
      entry({
        action: 'ATTRIBUTES_CHANGED',
        note: 'Changed unit cost, barcode.',
        metadata: {
          fields: ['unitCost', 'barcode'],
          changes: [
            { field: 'unitCost', from: 4, to: 5.5 },
            { field: 'barcode', from: null, to: '5012345678900' },
          ],
        },
      }),
    );
    expect(view.changes).toEqual([
      { field: 'barcode', from: null, to: '5012345678900' },
      { field: 'unitCost', from: 4, to: 5.5 },
    ]);
  });

  it('orders the changes by the audited-field registry, not by how they were recorded', () => {
    // `barcode` precedes `unitCost` in the registry, so a multi-field edit reads the same way
    // whatever order the form happened to submit its fields in.
    const view = describeHistoryEntry(
      entry({
        action: 'ATTRIBUTES_CHANGED',
        metadata: {
          changes: [
            { field: 'depth', from: null, to: 30 },
            { field: 'unitCost', from: 4, to: 5 },
            { field: 'barcode', from: null, to: '5012345678900' },
          ],
        },
      }),
    );
    expect(view.changes.map((c) => c.field)).toEqual(['barcode', 'unitCost', 'depth']);
  });

  it('keeps a field this build does not know, after the ones it does', () => {
    // `item_history` unions across devices (§7.3): a newer peer can record a column this build
    // has never heard of. The entry is still a true record, so it is shown rather than dropped.
    const view = describeHistoryEntry(
      entry({
        action: 'ATTRIBUTES_CHANGED',
        metadata: {
          changes: [
            { field: 'someFutureField', from: 'a', to: 'b' },
            { field: 'unitCost', from: 4, to: 5 },
          ],
        },
      }),
    );
    expect(view.changes.map((c) => c.field)).toEqual(['unitCost', 'someFutureField']);
  });

  it('drops a record that does not name a field, and flattens a non-scalar value to null', () => {
    const view = describeHistoryEntry(
      entry({
        action: 'ATTRIBUTES_CHANGED',
        metadata: {
          changes: [
            null,
            'barcode',
            { from: 1, to: 2 },
            { field: '', from: 1, to: 2 },
            { field: 'unitCost', from: { nested: true }, to: 5 },
          ],
        },
      }),
    );
    expect(view.changes).toEqual([{ field: 'unitCost', from: null, to: 5 }]);
  });

  it('reports no changes for an entry whose metadata carries none', () => {
    expect(describeHistoryEntry(entry({ metadata: null })).changes).toEqual([]);
    expect(describeHistoryEntry(entry({ metadata: { fields: ['unitCost'] } })).changes).toEqual([]);
    expect(describeHistoryEntry(entry({ metadata: { changes: 'unitCost' } })).changes).toEqual([]);
  });
});

describe('noteRepeatsChanges — whether the note still says anything the values do not', () => {
  it('is true for an edit, whose note only re-lists the fields below it', () => {
    const view = describeHistoryEntry(
      entry({
        action: 'ATTRIBUTES_CHANGED',
        note: 'Changed unit cost.',
        metadata: { changes: [{ field: 'unitCost', from: 4, to: 5 }] },
      }),
    );
    expect(view.noteRepeatsChanges).toBe(true);
    // The note itself is untouched — the CSV/JSON export reads it.
    expect(view.detail).toBe('Changed unit cost.');
  });

  it('is false for a sync overwrite, whose note explains why the values moved', () => {
    const view = describeHistoryEntry(
      entry({
        action: 'MERGE_OVERWRITTEN',
        note: 'Two devices edited this item; the newer edit replaced its unit cost.',
        metadata: { changes: [{ field: 'unitCost', from: 4, to: 5 }] },
      }),
    );
    expect(view.noteRepeatsChanges).toBe(false);
  });

  it('is false for an edit that recorded no values, so its note is all there is', () => {
    const view = describeHistoryEntry(entry({ action: 'ATTRIBUTES_CHANGED', note: 'Changed notes.' }));
    expect(view.noteRepeatsChanges).toBe(false);
  });

  it('is false when a field is one this build cannot name, so the peer’s prose is kept', () => {
    // The list can only show `thermalRating` by its raw camelCase name; the note written by the
    // peer that knew what the field was called is the only readable naming of it in the row.
    const view = describeHistoryEntry(
      entry({
        action: 'ATTRIBUTES_CHANGED',
        note: 'Changed unit cost, thermal rating.',
        metadata: {
          changes: [
            { field: 'unitCost', from: 4, to: 5 },
            { field: 'thermalRating', from: null, to: '85C' },
          ],
        },
      }),
    );
    expect(view.noteRepeatsChanges).toBe(false);
  });
});

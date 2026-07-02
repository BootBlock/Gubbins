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

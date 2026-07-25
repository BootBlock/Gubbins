import { describe, it, expect } from 'vitest';
import type { ActivityFeedEntry } from '@/db/repositories';
import { activityExportColumns, activityExportFilename, buildActivityExport } from './activity-export';

function entry(overrides: Partial<ActivityFeedEntry> = {}): ActivityFeedEntry {
  return {
    id: 'h1',
    itemId: 'i1',
    action: 'QUANTITY_CHANGE',
    quantityDelta: 3,
    netValueDelta: null,
    note: 'Restocked from the order.',
    metadata: null,
    createdAt: Date.parse('2026-07-25T09:30:00Z'),
    itemName: 'Brass widget',
    itemIsActive: true,
    ...overrides,
  };
}

/** Read one row through the columns, keyed by header — the shape every serialiser sees. */
function cells(row: ActivityFeedEntry): Record<string, unknown> {
  return Object.fromEntries(activityExportColumns().map((c) => [c.header, c.value(row)]));
}

describe('activityExportColumns', () => {
  it('carries the row’s identity, timing and action', () => {
    expect(cells(entry())).toMatchObject({
      When: '2026-07-25T09:30:00.000Z',
      Item: 'Brass widget',
      Action: 'Quantity changed',
      Detail: 'Restocked from the order.',
    });
  });

  it('labels the kind exactly as the filter chips do', () => {
    expect(cells(entry({ action: 'MOVED' })).Kind).toBe('Moves');
    expect(cells(entry({ action: 'CHECKED_OUT' })).Kind).toBe('Loans');
    expect(cells(entry({ action: 'CREATED' })).Kind).toBe('Created');
  });

  it('keeps both deltas as raw signed numbers a spreadsheet can total', () => {
    // Deliberately not the screen's "−45" badge: that uses a true minus sign (U+2212), which a
    // spreadsheet reads as text rather than a negative number.
    const row = cells(entry({ quantityDelta: -45, netValueDelta: -12.5 }));
    expect(row['Quantity change']).toBe(-45);
    expect(row['Value change']).toBe(-12.5);
  });

  it('leaves an absent delta or note blank rather than zero', () => {
    const row = cells(entry({ quantityDelta: null, netValueDelta: null, note: null }));
    expect(row['Quantity change']).toBeNull();
    expect(row['Value change']).toBeNull();
    expect(row.Detail).toBeNull();
  });

  it('treats a whitespace-only note as no note, as the feed row does', () => {
    expect(cells(entry({ note: '   ' })).Detail).toBeNull();
  });

  it('degrades an unknown action from a newer peer to readable prose', () => {
    const row = cells(entry({ action: 'SOME_FUTURE_ACTION' as ActivityFeedEntry['action'] }));
    expect(row.Action).toBe('Some future action');
    expect(row.Kind).toBe('Lifecycle');
  });
});

describe('buildActivityExport', () => {
  it('serialises through the shared exporter, headed and captioned', async () => {
    const { content, extension } = await buildActivityExport('csv', [entry(), entry({ id: 'h2' })]);
    expect(extension).toBe('csv');
    expect(String(content)).toContain('When,Item,Kind,Action,Detail,Quantity change,Value change');
    expect(String(content)).toContain('Brass widget');
  });

  it('captions a single event in the singular', async () => {
    const { content } = await buildActivityExport('txt', [entry()]);
    expect(String(content)).toContain('1 event');
    expect(String(content)).not.toContain('1 events');
  });
});

describe('activityExportFilename', () => {
  it('is date-stamped and carries the chosen extension', () => {
    expect(activityExportFilename('json', new Date('2026-07-25T00:00:00Z'))).toBe(
      'gubbins-activity-2026-07-25.json',
    );
  });
});

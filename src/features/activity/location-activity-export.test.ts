import { describe, it, expect } from 'vitest';
import type { LocationHistoryEntry } from '@/db/repositories';
import {
  buildLocationActivityExport,
  locationActivityExportColumns,
  locationActivityExportFilename,
} from './location-activity-export';

function entry(overrides: Partial<LocationHistoryEntry> = {}): LocationHistoryEntry {
  return {
    id: 'lh1',
    locationId: 'loc1',
    locationName: 'Top shelf',
    action: 'RENAMED',
    note: 'Renamed from "Shelf B" to "Top shelf".',
    metadata: null,
    actorUserId: 'user-admin',
    createdAt: Date.parse('2026-07-31T09:30:00Z'),
    ...overrides,
  };
}

/** Read one row through the columns, keyed by header — the shape every serialiser sees. */
function cells(row: LocationHistoryEntry): Record<string, unknown> {
  return Object.fromEntries(locationActivityExportColumns().map((c) => [c.header, c.value(row)]));
}

describe('locationActivityExportColumns (issue #693)', () => {
  it('carries when, where, what and the words describing it — and nothing item-shaped', () => {
    expect(locationActivityExportColumns().map((c) => c.header)).toEqual([
      'When',
      'Location',
      'Action',
      'Detail',
    ]);
    expect(cells(entry())).toEqual({
      When: '2026-07-31T09:30:00.000Z',
      Location: 'Top shelf',
      Action: 'Renamed',
      Detail: 'Renamed from "Shelf B" to "Top shelf".',
    });
  });

  it('labels the action exactly as the lane and the History tab do', () => {
    // One seam behind all three, so a file can never call a `RE_PARENTED` entry something the
    // screen it came from does not.
    expect(cells(entry({ action: 'RE_PARENTED' })).Action).toBe('Moved');
    expect(cells(entry({ action: 'DELETED' })).Action).toBe('Deleted');
    expect(cells(entry({ action: 'ARCHIVED' })).Action).toBe('Archived');
  });

  it('keeps the name the place carried at the time, for a location that is now gone', () => {
    const removed = entry({
      action: 'DELETED',
      locationName: 'Top shelf',
      note: 'Deleted "Top shelf". 2 items were moved to Unassigned; 0 sub-locations were moved to the top level.',
    });
    expect(cells(removed)).toMatchObject({ Location: 'Top shelf', Action: 'Deleted' });
    expect(String(cells(removed).Detail)).toContain('moved to Unassigned');
  });

  it('leaves an absent or whitespace-only note blank, as the lane’s rows do', () => {
    expect(cells(entry({ note: null })).Detail).toBeNull();
    expect(cells(entry({ note: '   ' })).Detail).toBeNull();
  });

  it('degrades an unknown action from a newer peer to readable prose', () => {
    const row = cells(entry({ action: 'SOME_FUTURE_ACTION' as LocationHistoryEntry['action'] }));
    expect(row.Action).toBe('Some future action');
  });
});

describe('buildLocationActivityExport', () => {
  it('serialises through the shared exporter, headed and captioned', async () => {
    const { content, extension } = await buildLocationActivityExport('csv', [
      entry(),
      entry({ id: 'lh2', locationName: 'Bin 4' }),
    ]);
    expect(extension).toBe('csv');
    expect(String(content)).toContain('When,Location,Action,Detail');
    expect(String(content)).toContain('Bin 4');
  });

  it('captions a single event in the singular', async () => {
    const { content } = await buildLocationActivityExport('txt', [entry()]);
    expect(String(content)).toContain('1 event');
    expect(String(content)).not.toContain('1 events');
  });
});

describe('locationActivityExportFilename', () => {
  it('is date-stamped and sorts beside the other list exports', () => {
    expect(locationActivityExportFilename('csv', new Date('2026-07-31T00:00:00Z'))).toBe(
      'gubbins-location-activity-2026-07-31.csv',
    );
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';
import { ADMIN_USER_ID } from '@/db/repositories/constants';
import { exportEveryPage, isoCalendarDay, isoTimestamp, listExportFilename } from './export-every-page';
import type { TabularExportResult } from './tabular-export';

/** A stand-in serialiser: records the rows it was handed and returns a trivial file. */
function collect(seen: { rows: readonly number[] }) {
  return (rows: readonly number[]): Promise<TabularExportResult> => {
    seen.rows = rows;
    return Promise.resolve({ content: rows.join(','), mimeType: 'text/plain', extension: 'txt' });
  };
}

/** A paged read over `total` rows, serving `limit` at a time exactly as a repository would. */
function pagedRead(total: number) {
  return ({ limit, offset }: { limit: number; offset: number }) => {
    const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => offset + i);
    return Promise.resolve({ rows, hasMore: offset + rows.length < total });
  };
}

describe('exportEveryPage', () => {
  it('serialises every page, not the first one', async () => {
    const seen = { rows: [] as readonly number[] };
    await exportEveryPage(pagedRead(250), collect(seen), 'cut short');
    expect(seen.rows).toHaveLength(250);
    expect(seen.rows[0]).toBe(0);
    expect(seen.rows[249]).toBe(249);
  });

  it('attaches no notice when the whole list was read', async () => {
    const result = await exportEveryPage(pagedRead(5), collect({ rows: [] }), 'cut short');
    expect(result.notice).toBeUndefined();
  });

  it('attaches the caveat when the read stopped short of the end', async () => {
    // The walk stops at the ceiling with rows still unread, so the file is incomplete and must
    // say so — a short file reported as a clean success is the failure this seam exists to stop.
    const seen = { rows: [] as readonly number[] };
    const result = await exportEveryPage(pagedRead(10_500), collect(seen), 'cut short');
    expect(seen.rows).toHaveLength(10_000);
    expect(result.notice).toBe('cut short');
  });

  it('preserves the serialiser’s own content, MIME type and extension', async () => {
    const result = await exportEveryPage(pagedRead(3), collect({ rows: [] }), 'cut short');
    expect(result).toMatchObject({ content: '0,1,2', mimeType: 'text/plain', extension: 'txt' });
  });
});

describe('listExportFilename', () => {
  it('names the file after the list, stamped with the date', () => {
    expect(listExportFilename('activity', 'csv', new Date('2026-07-25T13:00:00Z'))).toBe(
      'gubbins-activity-2026-07-25.csv',
    );
  });

  it('carries whichever extension the chosen format produced', () => {
    const date = new Date('2026-07-25T13:00:00Z');
    expect(listExportFilename('tags', 'xlsx', date)).toBe('gubbins-tags-2026-07-25.xlsx');
    expect(listExportFilename('tags', 'md', date)).toBe('gubbins-tags-2026-07-25.md');
  });
});

describe('isoTimestamp', () => {
  it('renders a stored epoch as an unambiguous ISO instant', () => {
    expect(isoTimestamp(Date.parse('2026-07-25T13:45:00Z'))).toBe('2026-07-25T13:45:00.000Z');
  });

  it('leaves an absent timestamp blank rather than inventing an epoch date', () => {
    expect(isoTimestamp(null)).toBeNull();
    expect(isoTimestamp(undefined)).toBeNull();
  });

  it('keeps a zero epoch, which is a real instant rather than "unset"', () => {
    expect(isoTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  // One unreadable stored timestamp must not cost the user the whole file: `toISOString` throws
  // both on a NaN and on a finite number past the ±8.64e15 ms range `Date` can represent.
  it('blanks a value Date cannot represent rather than throwing the export away', () => {
    expect(isoTimestamp(Number.NaN)).toBeNull();
    expect(isoTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
    expect(isoTimestamp(8.64e15 + 1)).toBeNull();
  });
});

describe('isoCalendarDay', () => {
  it('renders a midnight-UTC day-start as that calendar day', () => {
    expect(isoCalendarDay(Date.parse('2026-07-25T00:00:00Z'))).toBe('2026-07-25');
  });

  it('does not slip the day for a value late in the UTC day', () => {
    expect(isoCalendarDay(Date.parse('2026-07-25T23:59:59Z'))).toBe('2026-07-25');
  });

  it('leaves an absent day blank', () => {
    expect(isoCalendarDay(null)).toBeNull();
  });
});

describe('exportEveryPage is the bulk-export boundary (issue #429)', () => {
  afterEach(() => {
    useSessionStore.getState().setResolved(UNRESTRICTED_AUTHORITY, ADMIN_USER_ID);
  });

  it('refuses a session without `export:run`, before a single page is read', async () => {
    // Being allowed to see the list on screen is not being allowed to take all of it to a file.
    useSessionStore.getState().setResolved({ mode: 'granted', grants: new Set(['items:read']) }, 'user-1');
    const read = vi.fn(pagedRead(250));

    await expect(exportEveryPage(read, collect({ rows: [] }), 'cut short')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('allows a role that holds `export:run`', async () => {
    useSessionStore
      .getState()
      .setResolved({ mode: 'granted', grants: new Set(['items:read', 'export:run']) }, 'user-1');

    const seen = { rows: [] as readonly number[] };
    await expect(exportEveryPage(pagedRead(5), collect(seen), 'cut short')).resolves.toBeDefined();
    expect(seen.rows).toHaveLength(5);
  });
});

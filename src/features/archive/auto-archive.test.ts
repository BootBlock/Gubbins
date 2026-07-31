import { describe, it, expect } from 'vitest';
import {
  ARCHIVE_INTERVAL_MS,
  ARCHIVE_MANIFEST_KIND,
  ARCHIVE_MANIFEST_VERSION,
  buildArchiveManifest,
  isArchiveDue,
} from './auto-archive';

describe('isArchiveDue (§2.7 weekly archive cadence, Phase 14)', () => {
  it('is due when the device has never archived', () => {
    expect(isArchiveDue(null, 1_000_000)).toBe(true);
  });

  it('is not due before the interval has elapsed', () => {
    const last = 1_000_000;
    expect(isArchiveDue(last, last + ARCHIVE_INTERVAL_MS - 1)).toBe(false);
  });

  it('is due once the weekly interval has elapsed', () => {
    const last = 1_000_000;
    expect(isArchiveDue(last, last + ARCHIVE_INTERVAL_MS)).toBe(true);
  });
});

describe('buildArchiveManifest (issue #501)', () => {
  it('records what the restore has to be able to check', () => {
    // The baseline stamp is the load-bearing field: it is what lets a restore refuse an archive
    // taken several releases ago *without needing a worker* to read the database itself.
    expect(
      buildArchiveManifest({
        appVersion: '0.9.1',
        baselineRevision: 'a1b2c3d4',
        createdAt: new Date('2026-07-27T09:30:00.000Z'),
        imageCount: 3,
      }),
    ).toEqual({
      kind: ARCHIVE_MANIFEST_KIND,
      formatVersion: ARCHIVE_MANIFEST_VERSION,
      appVersion: '0.9.1',
      baselineRevision: 'a1b2c3d4',
      createdAt: '2026-07-27T09:30:00.000Z',
      counts: { images: 3 },
    });
  });
});

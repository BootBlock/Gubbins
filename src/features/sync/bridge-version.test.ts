import { describe, it, expect } from 'vitest';
import { compareBridgeBuild, isBridgeBuildNoteworthy } from './bridge-version';

const app = { version: '1.2.0', schemaVersion: 5 };

describe('compareBridgeBuild', () => {
  it('is silent when the bridge matches the app exactly', () => {
    expect(compareBridgeBuild({ version: '1.2.0', schemaVersion: 5 }, app)).toBe('current');
  });

  it('reports an older version on the same schema as merely behind', () => {
    expect(compareBridgeBuild({ version: '1.1.0', schemaVersion: 5 }, app)).toBe('behind');
    expect(compareBridgeBuild({ version: '1.2.0', schemaVersion: 5 }, app)).not.toBe('behind');
  });

  it('escalates to schema-behind when the stored-data generation is older', () => {
    // The distinction that matters: this bridge may be reading columns that have since moved,
    // which is the "silently serving wrong data" case a version alone would under-report.
    expect(compareBridgeBuild({ version: '1.1.0', schemaVersion: 4 }, app)).toBe('schema-behind');
  });

  it('lets the schema outrank the version string entirely', () => {
    // A *newer* version on an *older* schema is still the dangerous case.
    expect(compareBridgeBuild({ version: '9.9.9', schemaVersion: 4 }, app)).toBe('schema-behind');
  });

  it('reports a bridge ahead of the app, by either measure', () => {
    expect(compareBridgeBuild({ version: '1.3.0', schemaVersion: 5 }, app)).toBe('ahead');
    expect(compareBridgeBuild({ version: '1.2.0', schemaVersion: 6 }, app)).toBe('ahead');
  });

  it('treats a bridge that reported nothing as unknown — it predates the check, so it is old', () => {
    expect(compareBridgeBuild(null, app)).toBe('unknown');
  });
});

describe('isBridgeBuildNoteworthy', () => {
  it('says nothing only when the bridge is current', () => {
    expect(isBridgeBuildNoteworthy('current')).toBe(false);
    for (const status of ['behind', 'schema-behind', 'ahead', 'unknown'] as const) {
      expect(isBridgeBuildNoteworthy(status)).toBe(true);
    }
  });
});

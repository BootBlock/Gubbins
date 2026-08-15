/**
 * Snapshot reload-health tests (issue #312) — the pure staleness verdict behind `/health`.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STALE_AFTER_FAILURES,
  HEALTHY_RELOAD,
  healthBody,
  redactReloadError,
  stalenessCaveat,
  summarizeSnapshotHealth,
  type SnapshotReloadHealth,
} from './snapshot-health.ts';

function health(overrides: Partial<SnapshotReloadHealth> = {}): SnapshotReloadHealth {
  return { ...HEALTHY_RELOAD, ...overrides };
}

describe('summarizeSnapshotHealth', () => {
  it('reports a never-failed watcher as fresh', () => {
    const report = summarizeSnapshotHealth(health({ lastSuccessAt: '2026-07-19T10:00:00.000Z' }));
    expect(report).toEqual({
      snapshotStale: false,
      reloadFailures: 0,
      lastReloadError: null,
      lastReloadErrorAt: null,
      lastReloadAt: '2026-07-19T10:00:00.000Z',
    });
  });

  it('stays fresh below the threshold and turns stale at it', () => {
    const below = summarizeSnapshotHealth(health({ consecutiveFailures: DEFAULT_STALE_AFTER_FAILURES - 1 }));
    expect(below.snapshotStale).toBe(false);

    const at = summarizeSnapshotHealth(health({ consecutiveFailures: DEFAULT_STALE_AFTER_FAILURES }));
    expect(at.snapshotStale).toBe(true);
    expect(at.reloadFailures).toBe(DEFAULT_STALE_AFTER_FAILURES);
  });

  it('honours a custom threshold', () => {
    expect(summarizeSnapshotHealth(health({ consecutiveFailures: 1 }), 1).snapshotStale).toBe(true);
    expect(summarizeSnapshotHealth(health({ consecutiveFailures: 9 }), 20).snapshotStale).toBe(false);
  });

  it('never declares staleness when the threshold is zero, but still reports the counters', () => {
    const report = summarizeSnapshotHealth(health({ consecutiveFailures: 99, lastError: 'boom' }), 0);
    expect(report.snapshotStale).toBe(false);
    expect(report.reloadFailures).toBe(99);
    expect(report.lastReloadError).toBe('boom');
  });
});

describe('redactReloadError', () => {
  it('replaces the filesystem path but keeps the failure mode readable', () => {
    expect(
      redactReloadError("ENOENT: no such file or directory, open '/srv/gubbins/gubbins-sync.json'"),
    ).toBe("ENOENT: no such file or directory, open '<path>'");
    expect(redactReloadError("EACCES: permission denied, open 'C:\\data\\gubbins-sync.json'")).toBe(
      "EACCES: permission denied, open '<path>'",
    );
  });

  it('leaves a path-free message alone', () => {
    expect(redactReloadError('Unexpected end of JSON input')).toBe('Unexpected end of JSON input');
  });

  it('keeps a lone separator that names the offending character rather than eating it', () => {
    // A snapshot starting with a `//` comment fails this way; the `/` IS the diagnosis.
    expect(redactReloadError('Unexpected token / in JSON at position 0')).toBe(
      'Unexpected token / in JSON at position 0',
    );
  });

  it('caps a runaway message', () => {
    const redacted = redactReloadError('x'.repeat(500));
    expect(redacted.length).toBe(200);
    expect(redacted.endsWith('…')).toBe(true);
  });

  it('never returns an empty string', () => {
    expect(redactReloadError('/only/a/path')).toBe('<path>');
    expect(redactReloadError('   ')).toBe('Snapshot reload failed.');
  });
});

describe('stalenessCaveat', () => {
  it('returns null when the snapshot is current', () => {
    expect(stalenessCaveat(summarizeSnapshotHealth(HEALTHY_RELOAD))).toBeNull();
    expect(
      stalenessCaveat(
        summarizeSnapshotHealth(health({ consecutiveFailures: DEFAULT_STALE_AFTER_FAILURES - 1 })),
      ),
    ).toBeNull();
  });

  it('describes the staleness, the failure count and the last good read when stale', () => {
    const caveat = stalenessCaveat(
      summarizeSnapshotHealth(
        health({
          consecutiveFailures: 5,
          lastError: "ENOENT: no such file or directory, open '/srv/gubbins-sync.json'",
          lastErrorAt: '2026-07-19T10:05:00.000Z',
          lastSuccessAt: '2026-07-19T10:00:00.000Z',
        }),
      ),
    );
    expect(caveat).not.toBeNull();
    expect(caveat).toContain('out of date');
    expect(caveat).toContain('5 attempts');
    expect(caveat).toContain('2026-07-19T10:00:00.000Z');
    // The path in the error is redacted before it ever reaches the caveat.
    expect(caveat).toContain('<path>');
    expect(caveat).not.toContain('/srv/gubbins-sync.json');
  });

  it('reads sensibly with no prior successful read', () => {
    const caveat = stalenessCaveat(summarizeSnapshotHealth(health({ consecutiveFailures: 3 })));
    expect(caveat).toContain('out of date');
    expect(caveat).not.toContain('last read successfully');
  });
});

describe('healthBody', () => {
  it('reports ok when the snapshot is fresh', () => {
    const body = healthBody(
      '2026-07-19T10:00:00.000Z',
      42,
      summarizeSnapshotHealth(HEALTHY_RELOAD),
      'workshop-nas-8787',
    );
    expect(body).toMatchObject({
      ok: true,
      bridgeId: 'workshop-nas-8787',
      itemCount: 42,
      snapshotStale: false,
      reloadFailures: 0,
    });
  });

  it('drops ok — and explains why — once the snapshot is stale', () => {
    const body = healthBody(
      '2026-07-19T10:00:00.000Z',
      42,
      summarizeSnapshotHealth(
        health({
          consecutiveFailures: 4,
          lastError: "ENOENT: no such file or directory, open '/srv/gubbins-sync.json'",
          lastErrorAt: '2026-07-19T10:05:00.000Z',
          lastSuccessAt: '2026-07-19T10:00:00.000Z',
        }),
      ),
      'workshop-nas-8787',
    );
    expect(body).toMatchObject({
      ok: false,
      snapshotStale: true,
      reloadFailures: 4,
      lastReloadError: "ENOENT: no such file or directory, open '<path>'",
      lastReloadErrorAt: '2026-07-19T10:05:00.000Z',
      lastReloadAt: '2026-07-19T10:00:00.000Z',
    });
  });

  // A bridge with no identity to report says so with `null` rather than omitting the key: a
  // consumer reads the same fields whichever bridge answered (issue #672).
  it('falls back to a fresh report when no health accessor is wired', () => {
    expect(healthBody(null, 0, undefined, undefined)).toEqual({
      ok: true,
      bridgeId: null,
      itemCount: 0,
      snapshotGeneratedAt: null,
      snapshotStale: false,
      reloadFailures: 0,
      lastReloadError: null,
      lastReloadErrorAt: null,
      lastReloadAt: null,
    });
  });
});

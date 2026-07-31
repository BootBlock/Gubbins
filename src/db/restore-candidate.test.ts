/**
 * The verdict logic behind a destructive restore's pre-flight (issues #198, #501). Kept pure so
 * the outcomes that matter — sound, damaged, *built by another schema*, and *could not be checked*
 * — are pinned down without a worker; the last one is the reason the deep check can never be made
 * mandatory.
 */
import { describe, it, expect } from 'vitest';
import { assessRestoreCandidate, type ExpectedSchema } from './restore-candidate';
import type { VerifyBinaryResult } from './rpc/protocol';
import type { SqliteHeaderReport } from './sqlite-header';

const soundHeader: SqliteHeaderReport = { isSqlite: true, ok: true, pageSize: 4096, problems: [] };
const brokenHeader: SqliteHeaderReport = {
  isSqlite: true,
  ok: false,
  pageSize: 4096,
  problems: ['The file looks truncated.'],
};

const BASELINE = 'a1b2c3d4';
const EXPECTED: ExpectedSchema = { baselineRevision: BASELINE, schemaVersion: 3 };

/** A clean deep-check result for a database with this schema identity. */
function verified(baselineRevision: string | null = BASELINE, userVersion = 3): VerifyBinaryResult {
  return { ok: true, problems: [], schema: { userVersion, baselineRevision } };
}

describe('assessRestoreCandidate', () => {
  it('passes a sound header that also passes the integrity check', () => {
    expect(assessRestoreCandidate(soundHeader, verified(), EXPECTED)).toEqual({
      status: 'ok',
      problems: [],
    });
  });

  it('reports a broken header as damaged without needing the deep check', () => {
    const assessment = assessRestoreCandidate(brokenHeader, null, EXPECTED);
    expect(assessment.status).toBe('damaged');
    expect(assessment.problems).toEqual(['The file looks truncated.']);
  });

  it('reports integrity-check failures as damaged', () => {
    const assessment = assessRestoreCandidate(
      soundHeader,
      {
        ok: false,
        problems: ['*** in database main *** Page 4: btreeInitPage() returns error code 11'],
        schema: null,
      },
      EXPECTED,
    );
    expect(assessment.status).toBe('damaged');
    expect(assessment.problems).toHaveLength(1);
  });

  it('caps the problems it carries so one rotten file cannot flood the screen', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Page ${i} is corrupt`);
    const verify: VerifyBinaryResult = { ok: false, problems: many, schema: null };
    expect(assessRestoreCandidate(soundHeader, verify, EXPECTED).problems).toHaveLength(5);
  });

  it('warns rather than blocks when the deep check could not run at all', () => {
    // The worker is exactly what may be broken on the screen this runs from; an unavailable
    // verification must never be the thing that traps a user with no way back.
    expect(assessRestoreCandidate(soundHeader, null, EXPECTED)).toEqual({
      status: 'unverified',
      problems: [],
    });
  });

  describe('schema baseline (issue #501)', () => {
    it('refuses an intact database built from a different baseline', () => {
      // The bug: this file is structurally perfect, so the header and integrity checks both pass
      // — and boot would then refuse it with SCHEMA_STALE, after the live database was gone.
      expect(assessRestoreCandidate(soundHeader, verified('deadbeef'), EXPECTED)).toEqual({
        status: 'incompatible',
        problems: [],
      });
    });

    it('refuses an intact database that carries no baseline stamp at all', () => {
      // Unstamped means "built before stamping existed", which boot refuses just the same.
      expect(assessRestoreCandidate(soundHeader, verified(null), EXPECTED).status).toBe('incompatible');
    });

    it('calls damage before incompatibility when a file is both', () => {
      const verify: VerifyBinaryResult = {
        ok: false,
        problems: ['Page 4 is corrupt.'],
        schema: { userVersion: 1, baselineRevision: 'deadbeef' },
      };
      const assessment = assessRestoreCandidate(soundHeader, verify, EXPECTED);
      expect(assessment.status).toBe('damaged');
      expect(assessment.problems).toEqual(['Page 4 is corrupt.']);
    });

    it('refuses a database from a newer build, which boot would call SCHEMA_TOO_NEW', () => {
      // Not a second spelling of the stamp check: appending a forward migration moves the version
      // while leaving the baseline's own DDL — and so its fingerprint — untouched.
      expect(assessRestoreCandidate(soundHeader, verified(BASELINE, 4), EXPECTED).status).toBe(
        'incompatible',
      );
    });

    it('accepts a database behind the current version — the engine migrates that forward', () => {
      expect(assessRestoreCandidate(soundHeader, verified(BASELINE, 2), EXPECTED).status).toBe('ok');
    });

    it('does not claim incompatibility when the schema identity could not be read', () => {
      // Issue #500's lesson: a read that merely *failed* is not evidence of a stale schema, and
      // refusing on it would block a restore the user may badly need.
      expect(assessRestoreCandidate(soundHeader, { ok: true, problems: [], schema: null }, EXPECTED)).toEqual(
        { status: 'ok', problems: [] },
      );
    });
  });
});

/**
 * The verdict logic behind a destructive restore's pre-flight (issue #198). Kept pure so the
 * three outcomes that matter — sound, damaged, and *could not be checked* — are pinned down
 * without a worker; the last one is the reason the deep check can never be made mandatory.
 */
import { describe, it, expect } from 'vitest';
import { assessRestoreCandidate } from './restore-candidate';
import type { SqliteHeaderReport } from './sqlite-header';

const soundHeader: SqliteHeaderReport = { isSqlite: true, ok: true, pageSize: 4096, problems: [] };
const brokenHeader: SqliteHeaderReport = {
  isSqlite: true,
  ok: false,
  pageSize: 4096,
  problems: ['The file looks truncated.'],
};

describe('assessRestoreCandidate', () => {
  it('passes a sound header that also passes the integrity check', () => {
    expect(assessRestoreCandidate(soundHeader, { ok: true, problems: [] })).toEqual({
      status: 'ok',
      problems: [],
    });
  });

  it('reports a broken header as damaged without needing the deep check', () => {
    const assessment = assessRestoreCandidate(brokenHeader, null);
    expect(assessment.status).toBe('damaged');
    expect(assessment.problems).toEqual(['The file looks truncated.']);
  });

  it('reports integrity-check failures as damaged', () => {
    const assessment = assessRestoreCandidate(soundHeader, {
      ok: false,
      problems: ['*** in database main *** Page 4: btreeInitPage() returns error code 11'],
    });
    expect(assessment.status).toBe('damaged');
    expect(assessment.problems).toHaveLength(1);
  });

  it('caps the problems it carries so one rotten file cannot flood the screen', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Page ${i} is corrupt`);
    expect(assessRestoreCandidate(soundHeader, { ok: false, problems: many }).problems).toHaveLength(5);
  });

  it('warns rather than blocks when the deep check could not run at all', () => {
    // The worker is exactly what may be broken on the screen this runs from; an unavailable
    // verification must never be the thing that traps a user with no way back.
    expect(assessRestoreCandidate(soundHeader, null)).toEqual({ status: 'unverified', problems: [] });
  });
});

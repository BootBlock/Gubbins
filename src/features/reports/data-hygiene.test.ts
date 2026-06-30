import { describe, expect, it } from 'vitest';
import {
  buildHygieneReport,
  HYGIENE_KIND_ORDER,
  type HygieneItemFlags,
  type HygieneIssueKind,
} from './data-hygiene';

const NOW = Date.parse('2026-06-30T00:00:00Z');
const MS_PER_DAY = 86_400_000;

/** A fully-healthy item; override individual flags to introduce an issue. */
function ok(over: Partial<HygieneItemFlags>): HygieneItemFlags {
  return {
    id: over.id ?? 'i',
    name: over.name ?? 'Item',
    mpn: null,
    hasCategory: true,
    hasLocation: true,
    hasPrice: true,
    hasPhoto: true,
    everCounted: true,
    lastActivityAt: NOW,
    ...over,
  };
}

function sectionFor(report: ReturnType<typeof buildHygieneReport>, kind: HygieneIssueKind) {
  return report.sections.find((s) => s.kind === kind)!;
}

describe('buildHygieneReport', () => {
  it('emits every check in canonical order even when all pass', () => {
    const report = buildHygieneReport([ok({ id: 'a' })], { now: NOW, staleDays: 180 });
    expect(report.sections.map((s) => s.kind)).toEqual(HYGIENE_KIND_ORDER);
    expect(report.sections.every((s) => s.count === 0)).toBe(true);
    expect(report.totalItems).toBe(1);
    expect(report.flaggedItems).toBe(0);
  });

  it('flags each single-predicate issue', () => {
    const items = [
      ok({ id: 'cat', hasCategory: false }),
      ok({ id: 'loc', hasLocation: false }),
      ok({ id: 'price', hasPrice: false }),
      ok({ id: 'photo', hasPhoto: false }),
      ok({ id: 'count', everCounted: false }),
      ok({ id: 'stale', lastActivityAt: NOW - 200 * MS_PER_DAY }),
    ];
    const r = buildHygieneReport(items, { now: NOW, staleDays: 180 });
    expect(sectionFor(r, 'missing-category').samples.map((s) => s.id)).toEqual(['cat']);
    expect(sectionFor(r, 'missing-location').samples.map((s) => s.id)).toEqual(['loc']);
    expect(sectionFor(r, 'missing-price').samples.map((s) => s.id)).toEqual(['price']);
    expect(sectionFor(r, 'missing-photo').samples.map((s) => s.id)).toEqual(['photo']);
    expect(sectionFor(r, 'never-counted').samples.map((s) => s.id)).toEqual(['count']);
    expect(sectionFor(r, 'stale').samples.map((s) => s.id)).toEqual(['stale']);
    expect(r.flaggedItems).toBe(6);
  });

  it('treats the stale boundary as inclusive and annotates the idle age', () => {
    const exactly = ok({ id: 'edge', lastActivityAt: NOW - 180 * MS_PER_DAY });
    const fresh = ok({ id: 'fresh', lastActivityAt: NOW - 179 * MS_PER_DAY });
    const r = buildHygieneReport([exactly, fresh], { now: NOW, staleDays: 180 });
    const stale = sectionFor(r, 'stale');
    expect(stale.samples.map((s) => s.id)).toEqual(['edge']);
    expect(stale.samples[0].detail).toBe('idle 180d');
  });

  it('groups duplicate MPNs (case-insensitively), flagging every member of a ≥2 group', () => {
    const items = [
      ok({ id: 'a', name: 'A', mpn: 'NE555P' }),
      ok({ id: 'b', name: 'B', mpn: 'ne555p' }),
      ok({ id: 'c', name: 'C', mpn: ' NE555P ' }),
      ok({ id: 'lonely', name: 'D', mpn: 'UNIQUE' }),
      ok({ id: 'blank', name: 'E', mpn: '   ' }),
      ok({ id: 'null', name: 'F', mpn: null }),
    ];
    const r = buildHygieneReport(items, { now: NOW, staleDays: 180 });
    const dup = sectionFor(r, 'duplicate-mpn');
    expect(dup.count).toBe(3);
    expect(new Set(dup.samples.map((s) => s.id))).toEqual(new Set(['a', 'b', 'c']));
    expect(dup.samples[0].detail).toContain('shared with 2 others');
  });

  it('counts a multiply-flagged item once in flaggedItems', () => {
    const item = ok({ id: 'bad', hasCategory: false, hasPrice: false, hasPhoto: false });
    const r = buildHygieneReport([item], { now: NOW, staleDays: 180 });
    expect(r.flaggedItems).toBe(1);
    expect(sectionFor(r, 'missing-category').count).toBe(1);
    expect(sectionFor(r, 'missing-price').count).toBe(1);
  });

  it('caps samples at sampleLimit while keeping the exact count', () => {
    const items = Array.from({ length: 5 }, (_, n) => ok({ id: `x${n}`, name: `x${n}`, hasPhoto: false }));
    const r = buildHygieneReport(items, { now: NOW, staleDays: 180, sampleLimit: 2 });
    const photo = sectionFor(r, 'missing-photo');
    expect(photo.count).toBe(5);
    expect(photo.samples).toHaveLength(2);
  });

  it('handles an empty inventory', () => {
    const r = buildHygieneReport([], { now: NOW, staleDays: 180 });
    expect(r.totalItems).toBe(0);
    expect(r.flaggedItems).toBe(0);
    expect(r.sections.every((s) => s.count === 0)).toBe(true);
  });
});

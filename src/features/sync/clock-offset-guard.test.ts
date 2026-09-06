/**
 * Issue #872: the gate between a measured server-time reading and the frame this device publishes
 * in.
 *
 * The offset is added to every row a pass pushes, so it decides which device wins every
 * Last-Write-Wins comparison in the vault. Its only source is an unauthenticated HTTP `Date`
 * header, and a wrong one does not merely mis-date this device's work: the inflated rows *win*,
 * which records no conflict, so a peer's genuinely newer edits are destroyed with no trace.
 *
 * These drive the pure decision. `sync-engine.clock-guard.test.ts` drives the same rules through a
 * real pass, where the point is that a refused reading changes nothing at all.
 */
import { describe, expect, it } from 'vitest';
import { SKEW_REMEASURE_INTERVAL_MS, SKEW_SANITY_LIMIT_MS } from '@/features/clock-skew/skew';
import { OFFSET_CORROBORATION_TOLERANCE_MS, resolveSyncOffset } from './clock';
import { SyncClockUntrustedError } from './sync-errors';

const LOCAL_NOW = 1_788_172_254_093;

/** A measurement as `measureClockOffset` returns it, with the local clock fixed. */
function reading(serverNow: number | null): {
  offset: number;
  serverNow: number | null;
  localNow: number;
} {
  return {
    offset: serverNow === null || !Number.isFinite(serverNow) ? 0 : serverNow - LOCAL_NOW,
    serverNow,
    localNow: LOCAL_NOW,
  };
}

/** A persisted skew measured recently enough that the clock-skew feature still believes it. */
function fresh(skewMs: number) {
  return { skewMs, measuredAt: LOCAL_NOW - 60_000 };
}

describe('resolveSyncOffset', () => {
  it('trusts the local clock when the provider has no clock of its own', () => {
    // Every shipped provider answers `null`, and `httpTimeSource` degrades every failure to it.
    expect(resolveSyncOffset(reading(null), null)).toEqual({ offset: 0, effectiveNow: LOCAL_NOW });
  });

  it('adopts an ordinary reading and derives "now" from it', () => {
    const resolved = resolveSyncOffset(reading(LOCAL_NOW + 4_000), fresh(4_000));
    expect(resolved).toEqual({ offset: 4_000, effectiveNow: LOCAL_NOW + 4_000 });
  });

  it('adopts an uncorroborated reading when the device has never measured its own skew', () => {
    // Nothing to compare against is not the same as a contradiction, and refusing here would stop
    // a first-ever sync on a device whose clock is genuinely wrong.
    const resolved = resolveSyncOffset(reading(LOCAL_NOW + 90_000), { skewMs: 0, measuredAt: 0 });
    expect(resolved.offset).toBe(90_000);
  });

  it('refuses the reading behind the reported data loss: a Date header 400 days ahead', () => {
    const fourHundredDays = 400 * 24 * 60 * 60 * 1_000;
    expect(fourHundredDays).toBeGreaterThan(SKEW_SANITY_LIMIT_MS);
    expect(() => resolveSyncOffset(reading(LOCAL_NOW + fourHundredDays), fresh(0))).toThrow(
      SyncClockUntrustedError,
    );
  });

  it('refuses a four-hour reading a bound alone would have let through', () => {
    // The realistic vector. Four hours is comfortably inside the 365-day sanity limit, so only the
    // corroboration check catches it — and four hours is more than enough to beat every edit a
    // peer makes for the rest of the day.
    const fourHours = 4 * 60 * 60 * 1_000;
    expect(fourHours).toBeLessThan(SKEW_SANITY_LIMIT_MS);
    expect(() => resolveSyncOffset(reading(LOCAL_NOW + fourHours), fresh(0))).toThrow(
      SyncClockUntrustedError,
    );
  });

  it('keeps a genuinely year-slow device publishing in the true frame', () => {
    // The reason a refused reading stops the pass rather than falling back to an offset of 0:
    // zeroing this device would have it publish every row a year in the past and lose every
    // comparison it should win. Corroborated, so it is not refused at all.
    const elevenMonths = 330 * 24 * 60 * 60 * 1_000;
    const resolved = resolveSyncOffset(reading(LOCAL_NOW + elevenMonths), fresh(elevenMonths));
    expect(resolved.offset).toBe(elevenMonths);
  });

  it('accepts a disagreement at the tolerance and refuses one past it', () => {
    const at = OFFSET_CORROBORATION_TOLERANCE_MS;
    expect(resolveSyncOffset(reading(LOCAL_NOW + at), fresh(0)).offset).toBe(at);
    expect(() => resolveSyncOffset(reading(LOCAL_NOW + at + 1), fresh(0))).toThrow(SyncClockUntrustedError);
  });

  it('ignores a persisted measurement too stale to still be believed', () => {
    // A user who has just corrected their system clock leaves exactly this behind. Holding the
    // fresh reading to it would refuse every pass until the stored one aged out.
    const stale = { skewMs: 0, measuredAt: LOCAL_NOW - SKEW_REMEASURE_INTERVAL_MS - 1 };
    expect(resolveSyncOffset(reading(LOCAL_NOW + 4 * 60 * 60 * 1_000), stale).offset).toBe(
      4 * 60 * 60 * 1_000,
    );
  });

  it('reads a non-finite server time as no reading rather than propagating NaN', () => {
    // The second limb: `effectiveNow` used to be `serverNow ?? localNow`, and `??` does not catch
    // `NaN`, so a provider returning one pushed `NaN` into every timestamp the pass wrote.
    const resolved = resolveSyncOffset(reading(Number.NaN), fresh(0));
    expect(resolved).toEqual({ offset: 0, effectiveNow: LOCAL_NOW });
    expect(Number.isFinite(resolved.effectiveNow)).toBe(true);
  });
});

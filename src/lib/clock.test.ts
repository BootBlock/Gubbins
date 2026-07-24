import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  clockOffsetMs,
  clockSkewMs,
  isClockShifted,
  nowDate,
  nowMs,
  offsetForDate,
  setClockOffsetMs,
  setClockSkewMs,
} from './clock';

afterEach(() => {
  setClockOffsetMs(0);
  setClockSkewMs(0);
  vi.useRealTimers();
});

describe('clock', () => {
  it('reads the real time when unshifted', () => {
    expect(clockOffsetMs()).toBe(0);
    expect(isClockShifted()).toBe(false);
    expect(Math.abs(nowMs() - Date.now())).toBeLessThan(50);
  });

  it('shifts nowMs and nowDate by the offset', () => {
    setClockOffsetMs(86_400_000);
    expect(isClockShifted()).toBe(true);
    expect(nowMs() - Date.now()).toBeCloseTo(86_400_000, -2);
    expect(nowDate().getTime() - Date.now()).toBeCloseTo(86_400_000, -2);
  });

  it('restores the real clock when reset to zero', () => {
    setClockOffsetMs(5_000);
    setClockOffsetMs(0);
    expect(isClockShifted()).toBe(false);
    expect(Math.abs(nowMs() - Date.now())).toBeLessThan(50);
  });

  it('ignores a non-finite offset rather than poisoning every comparison with NaN', () => {
    setClockOffsetMs(Number.NaN);
    expect(clockOffsetMs()).toBe(0);
    expect(Number.isFinite(nowMs())).toBe(true);
    setClockOffsetMs(Number.POSITIVE_INFINITY);
    expect(clockOffsetMs()).toBe(0);
  });

  describe('skew correction (#326)', () => {
    it('corrects nowMs for a wrong device clock', () => {
      setClockSkewMs(-604_800_000); // a device running a week fast
      expect(clockSkewMs()).toBe(-604_800_000);
      expect(nowMs() - Date.now()).toBeCloseTo(-604_800_000, -2);
    });

    it('composes with the lab offset rather than replacing it', () => {
      setClockSkewMs(-3_600_000);
      setClockOffsetMs(86_400_000);
      expect(nowMs() - Date.now()).toBeCloseTo(82_800_000, -2);
    });

    it('keeps a corrected clock distinguishable from a pretending one', () => {
      // A device whose clock is merely wrong must not be badged as being in lab test mode.
      setClockSkewMs(-3_600_000);
      expect(isClockShifted()).toBe(false);
      expect(clockOffsetMs()).toBe(0);
    });

    it('ignores a non-finite skew rather than poisoning every comparison with NaN', () => {
      setClockSkewMs(Number.NaN);
      expect(clockSkewMs()).toBe(0);
      expect(Number.isFinite(nowMs())).toBe(true);
    });
  });

  describe('offsetForDate', () => {
    it('moves the UTC calendar date while preserving the time of day', () => {
      const from = new Date(Date.UTC(2026, 6, 18, 14, 30, 15, 250)); // 18 Jul 2026, 14:30:15.250 UTC
      const shifted = new Date(from.getTime() + offsetForDate('2026-12-24', from));
      expect([shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()]).toEqual([
        2026, 12, 24,
      ]);
      expect([shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds()]).toEqual([14, 30, 15]);
    });

    it('shifts the UTC day, not the local day, so it matches UTC-midnight boundaries (#327)', () => {
      // Late-evening local time east of UTC is already tomorrow in UTC. The lab clock exists to
      // test judgements that compare against UTC-midnight expiry/warranty values, so picking a
      // date must land the *UTC* day on that date — a local-day shift left the tool a day off at
      // exactly the boundaries it was built to probe.
      const from = new Date(Date.UTC(2026, 6, 18, 23, 30, 0)); // 18 Jul 23:30 UTC
      const shifted = new Date(from.getTime() + offsetForDate('2026-12-24', from));
      expect(shifted.toISOString().slice(0, 10)).toBe('2026-12-24');
    });

    it('handles a backwards shift', () => {
      const from = new Date(Date.UTC(2026, 6, 18, 9, 0, 0));
      const shifted = new Date(from.getTime() + offsetForDate('2020-01-01', from));
      expect([shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()]).toEqual([
        2020, 1, 1,
      ]);
    });

    it('lands on the chosen date even when a skew correction is active (#326)', () => {
      // The offset is added *on top of* the skew inside nowMs, so measuring it from the raw
      // clock double-counted the device's error: a machine three days fast picked 24 December
      // and the app then believed it was the 21st.
      setClockSkewMs(-3 * 86_400_000);
      setClockOffsetMs(offsetForDate('2026-12-24'));
      const believed = nowDate();
      expect([believed.getUTCFullYear(), believed.getUTCMonth() + 1, believed.getUTCDate()]).toEqual([
        2026, 12, 24,
      ]);
    });

    it('is zero for the current date', () => {
      const from = new Date(Date.UTC(2026, 6, 18, 9, 0, 0));
      expect(offsetForDate('2026-07-18', from)).toBe(0);
    });

    it('degrades to the real clock for an unparseable date rather than throwing', () => {
      const from = new Date(Date.UTC(2026, 6, 18));
      for (const bad of ['', 'tomorrow', '2026-13', '18/07/2026', 'yyyy-mm-dd']) {
        expect(offsetForDate(bad, from)).toBe(0);
      }
    });
  });
});

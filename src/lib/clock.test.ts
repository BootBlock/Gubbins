import { describe, expect, it, afterEach, vi } from 'vitest';
import { clockOffsetMs, isClockShifted, nowDate, nowMs, offsetForDate, setClockOffsetMs } from './clock';

afterEach(() => {
  setClockOffsetMs(0);
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

  describe('offsetForDate', () => {
    it('moves the calendar date while preserving the time of day', () => {
      const from = new Date(2026, 6, 18, 14, 30, 15, 250); // 18 Jul 2026, 14:30:15.250
      const shifted = new Date(from.getTime() + offsetForDate('2026-12-24', from));
      expect([shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate()]).toEqual([2026, 12, 24]);
      expect([shifted.getHours(), shifted.getMinutes(), shifted.getSeconds()]).toEqual([14, 30, 15]);
    });

    it('handles a backwards shift', () => {
      const from = new Date(2026, 6, 18, 9, 0, 0);
      const shifted = new Date(from.getTime() + offsetForDate('2020-01-01', from));
      expect([shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate()]).toEqual([2020, 1, 1]);
    });

    it('is zero for the current date', () => {
      const from = new Date(2026, 6, 18, 9, 0, 0);
      expect(offsetForDate('2026-07-18', from)).toBe(0);
    });

    it('degrades to the real clock for an unparseable date rather than throwing', () => {
      const from = new Date(2026, 6, 18);
      for (const bad of ['', 'tomorrow', '2026-13', '18/07/2026', 'yyyy-mm-dd']) {
        expect(offsetForDate(bad, from)).toBe(0);
      }
    });
  });
});

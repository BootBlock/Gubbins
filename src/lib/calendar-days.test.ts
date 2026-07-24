/**
 * Calendar-day arithmetic (issue #325).
 *
 * The DST-sensitive behaviour — the whole point of these helpers — can only be observed in a time
 * zone that actually springs forward and falls back, and the Vitest worker pool is pinned to UTC
 * (setting `process.env.TZ` inside a `worker_threads` worker does not re-seat V8's cached zone). So
 * the daylight-saving cases run in a **child Node process** pinned to `America/New_York`, driving the
 * real module (it is dependency-free, so the child imports it directly under type-stripping). The
 * structural cases that hold in any zone stay as ordinary in-worker tests.
 *
 * New York DST boundaries for 2025:
 *  · spring forward — 2025-03-09, 02:00 EST → 03:00 EDT (any local day-window spanning it is 23h)
 *  · fall back      — 2025-11-02, 02:00 EDT → 01:00 EST (any local day-window spanning it is 25h)
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../test/repo-path';
import { addCalendarDays, startOfLocalDay } from './calendar-days';

// ---------------------------------------------------------------------------
// Structural cases — true in any time zone (the worker runs in UTC).
// ---------------------------------------------------------------------------

describe('startOfLocalDay', () => {
  it("snaps any instant to that day's local midnight and is idempotent", () => {
    const noon = new Date(2025, 5, 15, 12, 34, 56, 789).getTime();
    const midnight = startOfLocalDay(noon);
    expect(new Date(midnight).getHours()).toBe(0);
    expect(new Date(midnight).getMinutes()).toBe(0);
    expect(new Date(midnight).getSeconds()).toBe(0);
    expect(startOfLocalDay(midnight)).toBe(midnight);
  });
});

describe('addCalendarDays (structural)', () => {
  it('adds whole days at a steady wall-clock time', () => {
    const t = new Date(2025, 5, 10, 9, 30).getTime();
    const plus3 = addCalendarDays(t, 3);
    expect(new Date(plus3).getDate()).toBe(13);
    expect(new Date(plus3).getHours()).toBe(9);
    expect(new Date(plus3).getMinutes()).toBe(30);
  });

  it('steps backwards and rolls month/year boundaries', () => {
    const mar1 = new Date(2025, 2, 1, 8, 0).getTime();
    const back = addCalendarDays(mar1, -1); // into February
    expect(new Date(back).getMonth()).toBe(1);
    expect(new Date(back).getDate()).toBe(28);
    expect(new Date(back).getHours()).toBe(8);

    const jan1 = new Date(2025, 0, 1, 0, 0).getTime();
    const nye = addCalendarDays(jan1, -1);
    expect(new Date(nye).getFullYear()).toBe(2024);
    expect(new Date(nye).getMonth()).toBe(11);
    expect(new Date(nye).getDate()).toBe(31);
  });

  it('truncates a fractional day rather than adding a fractional span', () => {
    const t = new Date(2025, 5, 10, 9, 30).getTime();
    expect(addCalendarDays(t, 2.9)).toBe(addCalendarDays(t, 2));
    expect(addCalendarDays(t, 0)).toBe(t);
  });
});

// ---------------------------------------------------------------------------
// Daylight-saving cases — run in a child process pinned to America/New_York.
// ---------------------------------------------------------------------------

/**
 * Compute the DST probe values in a child Node process fixed to `America/New_York`. TZ is set as the
 * child's first statement (before any `Date`, which is when V8 seats the zone) rather than via the
 * spawn environment, which Windows Node does not honour. The child imports the real, dependency-free
 * module under type-stripping and prints a JSON result the parent asserts against.
 */
function dstProbe(): {
  fallMidnightDeltaH: number;
  fallMidnightIsMidnight: boolean;
  fallMidnightNaiveDiffers: boolean;
  springMidnightDeltaH: number;
  intervalHour: number;
  intervalDeltaH: number;
} {
  // `import.meta.url` is rewritten to an `http:` self-URL under Vite's transform, so resolve the
  // real filesystem path from the test's own `import.meta.dirname` (see `repoPath`).
  const moduleUrl = pathToFileURL(repoPath(import.meta.dirname, 'src', 'lib', 'calendar-days.ts')).href;
  const script = `
    process.env.TZ = 'America/New_York';
    const { addCalendarDays, startOfLocalDay } = await import(${JSON.stringify(moduleUrl)});
    const MS_PER_DAY = 86_400_000, H = 3_600_000;
    // Fall-back: 2 Nov 00:00 -> 3 Nov 00:00 spans the 02:00 change, so the local day is 25h.
    const n2 = startOfLocalDay(new Date(2025, 10, 2, 12).getTime());
    const n3 = addCalendarDays(n2, 1);
    // Spring-forward: 9 Mar 00:00 -> 10 Mar 00:00 spans the 02:00 change, so the local day is 23h.
    const m9 = startOfLocalDay(new Date(2025, 2, 9, 12).getTime());
    const m10 = addCalendarDays(m9, 1);
    // Maintenance interval anchored at an arbitrary wall-clock time across the fall-back.
    const serviced = new Date(2025, 10, 1, 14, 0).getTime();
    const due = addCalendarDays(serviced, 1);
    process.stdout.write(JSON.stringify({
      fallMidnightDeltaH: (n3 - n2) / H,
      fallMidnightIsMidnight: startOfLocalDay(n3) === n3,
      fallMidnightNaiveDiffers: n3 !== n2 + MS_PER_DAY,
      springMidnightDeltaH: (m10 - m9) / H,
      intervalHour: new Date(due).getHours(),
      intervalDeltaH: (due - serviced) / H,
    }));
  `;
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

describe('addCalendarDays across DST (America/New_York)', () => {
  const probe = dstProbe();

  it('lands on the next local midnight across the autumn fall-back (a 25-hour day)', () => {
    expect(probe.fallMidnightDeltaH).toBe(25);
    expect(probe.fallMidnightIsMidnight).toBe(true);
    // A naive `+ MS_PER_DAY` would have stopped an hour short of midnight.
    expect(probe.fallMidnightNaiveDiffers).toBe(true);
  });

  it('lands on the next local midnight across the spring forward (a 23-hour day)', () => {
    expect(probe.springMidnightDeltaH).toBe(23);
  });

  it('keeps an arbitrary wall-clock time steady across a crossing (the maintenance-interval case)', () => {
    // Serviced at 14:00 the day before the fall-back; due one calendar day later is still 14:00
    // local — 25 hours on in absolute ms, where a fixed-day add would read 13:00.
    expect(probe.intervalHour).toBe(14);
    expect(probe.intervalDeltaH).toBe(25);
  });
});

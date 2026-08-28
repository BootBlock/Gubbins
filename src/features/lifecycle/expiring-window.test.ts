/**
 * The "expiring soon" / "expiring-soon" boundary, driven in real time zones (issue #498).
 *
 * `expiryStatus` and `warrantyStatus` compare a **stored calendar day** (a midnight-UTC stamp,
 * issue #320) against a window measured from `now`. While that window was stepped off the raw
 * wall-clock instant it kept `now`'s time of day, so the boundary sat hours either side of the
 * stored midnight and a badge flipped between fresh/active and expiring-soon as the day went on —
 * west of UTC a 30-day window admitted a 31-days-out item by the evening, east of UTC it dropped a
 * 30-days-out one until mid-morning. Nothing about the item or the calendar had changed.
 *
 * The skew is invisible in UTC, where local and UTC midnight coincide, and the Vitest worker pool
 * cannot be re-zoned (assigning `process.env.TZ` inside a `worker_threads` worker does not re-seat
 * V8's cached zone). So these drive the **real** classifiers in **child Node processes** pinned to
 * `America/New_York` (behind UTC) and `Asia/Tokyo` (ahead of it) — the two zones the issue's own
 * reproduction table used. The repo's shared `registerAppTsHooks` teaches the child the `@/` alias
 * and extensionless imports, so it runs the shipping code rather than a copy of it.
 *
 * Reverting either classifier to `addCalendarDays(now, N)` turns three of the six cases below red —
 * the Tokyo pair and New York's beyond-the-window case. New York's inside-the-window case survives
 * the revert, because a wall-clock window still holds `2026-08-24` at both of its readings; it is
 * kept as the control that says the boundary did not move the other way.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../../test/repo-path';

/** One classification of one stored day, taken twice on the same local calendar day. */
interface Probe {
  /** The status early in the local day (New York 09:00 / Tokyo 07:00). */
  readonly morning: string;
  /** The status late in the same local day (New York 20:30 / Tokyo 12:00). */
  readonly evening: string;
  /** Whole local calendar days between "today" and the stored day, from `daysUntilExpiry`. */
  readonly daysOut: number;
}

interface ZoneProbe {
  /** Perishable expiry, keyed by the stored `YYYY-MM-DD` day. */
  readonly expiry: Record<string, Probe>;
  /** Warranty expiry, keyed by the stored `YYYY-MM-DD` day. */
  readonly warranty: Record<string, Probe>;
}

/**
 * Classify a handful of stored days twice on one local day, in a child process pinned to `zone`.
 *
 * TZ is set as the child's very first statement rather than through the spawn environment, which
 * Windows Node does not honour (the same constraint `calendar-days.test.ts` works around).
 */
function probeZone(zone: string, morningHour: number, eveningHour: number, eveningMinute: number): ZoneProbe {
  // `import.meta.url` is rewritten to an `http:` self-URL by Vite's transform, so resolve the real
  // checkout root from the test's own `import.meta.dirname` (see `repoPath`).
  const root = `${pathToFileURL(repoPath(import.meta.dirname)).href}/`;
  const hooks = `${root}scripts/app-ts-hooks.mjs`;
  const script = `
    process.env.TZ = ${JSON.stringify(zone)};
    // The app's '@/' alias and extensionless imports are bundler concerns; the repo's shared resolve
    // hook teaches plain Node both, so the child imports the shipping modules rather than a
    // transcription of them.
    const { registerAppTsHooks } = await import(${JSON.stringify(hooks)});
    registerAppTsHooks();
    const { expiryStatus, daysUntilExpiry } = await import(${JSON.stringify(root)} + 'src/features/lifecycle/expiry.ts');
    const { warrantyStatus } = await import(${JSON.stringify(root)} + 'src/features/inventory/asset-lifecycle.ts');

    // Two readings of the same local calendar day, 25 July 2026.
    const morning = new Date(2026, 6, 25, ${morningHour}, 0).getTime();
    const evening = new Date(2026, 6, 25, ${eveningHour}, ${eveningMinute}).getTime();

    // Stored days either side of the default 30-day window's boundary.
    const days = ['2026-08-23', '2026-08-24', '2026-08-25'];
    const expiry = {}, warranty = {};
    for (const day of days) {
      const stamp = Date.parse(day); // midnight UTC, the storage convention (#320)
      expiry[day] = {
        morning: expiryStatus(stamp, morning),
        evening: expiryStatus(stamp, evening),
        daysOut: daysUntilExpiry(stamp, morning),
      };
      warranty[day] = {
        morning: warrantyStatus({ warrantyExpiresAt: day }, morning),
        evening: warrantyStatus({ warrantyExpiresAt: day }, evening),
        daysOut: daysUntilExpiry(stamp, morning),
      };
    }
    process.stdout.write(JSON.stringify({ expiry, warranty }));
  `;
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  return JSON.parse(out) as ZoneProbe;
}

/**
 * The zones and readings from the issue's reproduction table. New York is UTC−4 in July, so its
 * evening reading pushed a wall-clock window a day *out*; Tokyo is UTC+9, so its morning reading
 * pulled one a day *in*.
 */
const ZONES = [
  { zone: 'America/New_York', probe: probeZone('America/New_York', 9, 20, 30) },
  { zone: 'Asia/Tokyo', probe: probeZone('Asia/Tokyo', 7, 12, 0) },
] as const;

describe.each(ZONES)('expiring-soon window in $zone', ({ probe }) => {
  const stableAcrossTheDay = (p: Probe) => {
    expect(p.evening).toBe(p.morning);
    return p.morning;
  };

  it('calls a day inside the 30-day window expiring-soon, whatever the time of day', () => {
    // 30 days out — the last day the window covers, and the edge the skew moved.
    expect(probe.expiry['2026-08-24'].daysOut).toBe(30);
    expect(stableAcrossTheDay(probe.expiry['2026-08-24'])).toBe('EXPIRING_SOON');
    expect(stableAcrossTheDay(probe.warranty['2026-08-24'])).toBe('expiring-soon');

    // Well inside the window, so it was never at risk of flipping — a control.
    expect(stableAcrossTheDay(probe.expiry['2026-08-23'])).toBe('EXPIRING_SOON');
    expect(stableAcrossTheDay(probe.warranty['2026-08-23'])).toBe('expiring-soon');
  });

  it('leaves a day beyond the window fresh, whatever the time of day', () => {
    expect(probe.expiry['2026-08-25'].daysOut).toBe(31);
    expect(stableAcrossTheDay(probe.expiry['2026-08-25'])).toBe('FRESH');
    expect(stableAcrossTheDay(probe.warranty['2026-08-25'])).toBe('active');
  });

  it('agrees with daysUntilExpiry, which is what the window claims to mean', () => {
    // The point of measuring the window in local days: "expiring soon" and "N days or fewer to go"
    // finally state the same thing, rather than two arithmetics that happen to coincide in UTC.
    for (const [day, p] of Object.entries(probe.expiry)) {
      expect({ day, soon: p.morning === 'EXPIRING_SOON' }).toEqual({ day, soon: p.daysOut <= 30 });
    }
  });
});

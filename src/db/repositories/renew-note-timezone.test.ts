/**
 * The loan-renewal ledger note names the borrower's own day, driven in real time zones (#516).
 *
 * A loan due date is the deliberate exception to the app's midnight-UTC day convention:
 * `fromDueDateInputValue` anchors the picked day at **local** 23:59:59 so a loan is not overdue
 * until the borrower's own day has ended. `renewNote` formatted those instants back through
 * `toISOString()`, and local 23:59:59 anywhere behind UTC is already the *next* day in UTC — so
 * the `LOAN_RENEWED` note claimed a day later than the renew dialog, the loans list and the
 * agenda all showed. The note is the durable record of the change and is never recomputed, so a
 * note written a day out stays a day out.
 *
 * The skew is invisible in UTC and east of it, and the Vitest worker pool cannot be re-zoned
 * (assigning `process.env.TZ` inside a `worker_threads` worker does not re-seat V8's cached
 * zone). So these drive the **real** repository — migrations, `checkout`, `renew` and the ledger
 * read-back — in child Node processes pinned to `America/New_York` (behind UTC) and
 * `Asia/Tokyo` (ahead of it), exactly as `expiring-window.test.ts` drives the classifiers. The
 * repo's shared `registerAppTsHooks` teaches the child the `@/` alias and extensionless imports,
 * so it runs the shipping code rather than a copy of it.
 *
 * Reverting `renewNote` to `toISOString().slice(0, 10)` turns the New York case red; Tokyo is the
 * control that says the fix did not move the day the other way.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../../test/repo-path';

interface RenewProbe {
  /** The note the `LOAN_RENEWED` ledger row stored, verbatim. */
  readonly note: string | null;
  /** The two days the renew editor shows for the same instants, via `toDueDateInputValue`. */
  readonly shown: readonly [string, string];
  /** The child's own July UTC offset, in minutes behind UTC — proof it took the zone on. */
  readonly offsetMinutes: number;
}

/**
 * Renew a loan from 16 to 20 July in a child process pinned to `zone`, and report both the note
 * the ledger stored and the days the editor reads those instants back as.
 *
 * TZ is set as the child's very first statement rather than through the spawn environment, which
 * Windows Node does not honour (the same constraint `expiring-window.test.ts` works around).
 */
function probeZone(zone: string): RenewProbe {
  // `import.meta.url` is rewritten to an `http:` self-URL by Vite's transform, so resolve the real
  // checkout root from the test's own `import.meta.dirname` (see `repoPath`).
  const root = `${pathToFileURL(repoPath(import.meta.dirname)).href}/`;
  const hooks = `${root}scripts/app-ts-hooks.mjs`;
  const script = `
    process.env.TZ = ${JSON.stringify(zone)};
    const { registerAppTsHooks } = await import(${JSON.stringify(hooks)});
    registerAppTsHooks();
    const root = ${JSON.stringify(root)};
    const { createMemoryDriver } = await import(root + 'src/test/drivers/memory-driver.ts');
    const { runMigrations, migrations } = await import(root + 'src/db/migrations/index.ts');
    const { ItemRepository } = await import(root + 'src/db/repositories/ItemRepository.ts');
    const { CheckoutRepository } = await import(root + 'src/db/repositories/CheckoutRepository.ts');
    const { fromDueDateInputValue, toDueDateInputValue } = await import(root + 'src/lib/date-input.ts');

    const driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    const items = new ItemRepository(driver);
    const checkouts = new CheckoutRepository(driver);

    // The two days a user picks in the renew dialog, anchored the way the app anchors them.
    const from = fromDueDateInputValue('2026-07-16');
    const to = fromDueDateInputValue('2026-07-20');

    const item = await items.create({ name: 'Impact driver', quantity: 1 });
    const loan = await checkouts.checkout({ itemId: item.id, contactName: 'Bob', dueDate: from });
    await checkouts.renew(loan.id, { dueDate: to });

    const history = await items.getHistory(item.id);
    const row = history.rows.find((h) => h.action === 'LOAN_RENEWED');
    process.stdout.write(JSON.stringify({
      note: row ? row.note : null,
      shown: [toDueDateInputValue(from), toDueDateInputValue(to)],
      offsetMinutes: new Date(Date.UTC(2026, 6, 20, 12)).getTimezoneOffset(),
    }));
    await driver.close();
  `;
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  return JSON.parse(out) as RenewProbe;
}

/**
 * `offsetMinutes` is each zone's July offset, in minutes *behind* UTC. Asserting it is what stops
 * a silent false pass: a Node build without full time-zone data would ignore `TZ` and run the
 * probe in UTC, where the bug this file exists for is invisible and the mutated code passes too.
 */
const ZONES = [
  { zone: 'America/New_York', offsetMinutes: 240, probe: probeZone('America/New_York') },
  { zone: 'Asia/Tokyo', offsetMinutes: -540, probe: probeZone('Asia/Tokyo') },
] as const;

describe.each(ZONES)('the LOAN_RENEWED note in $zone', ({ offsetMinutes, probe }) => {
  it('really ran in that zone', () => {
    expect(probe.offsetMinutes).toBe(offsetMinutes);
  });

  it('names the days the user picked', () => {
    expect(probe.note).toBe('Loan due date changed from 2026-07-16 to 2026-07-20.');
  });

  it('agrees with the days the renew editor reads those instants back as', () => {
    // Both sides driven, rather than the note compared against a hard-coded expectation alone:
    // whichever way a future edit moves the seam, the ledger and the editor move together.
    const [from, to] = probe.shown;
    expect(probe.note).toBe(`Loan due date changed from ${from} to ${to}.`);
  });
});

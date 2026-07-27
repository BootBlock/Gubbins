/**
 * `getRescueDatabaseDriver` — the seam every Safe Mode rescue reaches the database through
 * (issue #503).
 *
 * A crashed worker latches its driver permanently unusable (issue #299), which is right for the
 * app but wrong for the crash screen: a dead worker is one of the main reasons a user is looking
 * at it. This replaces the worker so the rescue can run, and — just as important — leaves a
 * healthy one alone, since rebuilding it would drop the live connection for no reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Drivers handed out in order, so a test can decide which ones report themselves dead. */
const constructed = vi.hoisted(() => [] as { isUnavailable: boolean; close: () => Promise<void> }[]);
/** Whether the *next* driver constructed reports a worker that has already died. */
const unavailable = vi.hoisted(() => ({ next: false }));

vi.mock('./rpc/worker-driver', () => {
  class FakeWorkerDatabaseDriver {
    readonly isUnavailable = unavailable.next;
    readonly close = vi.fn(async () => {});
    constructor() {
      constructed.push(this);
    }
  }
  return { WorkerDatabaseDriver: FakeWorkerDatabaseDriver };
});

import { getDatabaseDriver, getRescueDatabaseDriver, disposeDatabase } from './client';

beforeEach(async () => {
  // The driver is a module singleton, so each test starts from a torn-down one.
  unavailable.next = false;
  await disposeDatabase();
  constructed.length = 0;
});

describe('getRescueDatabaseDriver (issue #503)', () => {
  it('hands back the live driver untouched when the worker is healthy', async () => {
    const live = getDatabaseDriver();

    expect(await getRescueDatabaseDriver()).toBe(live);
    expect(constructed).toHaveLength(1);
  });

  it('replaces a driver whose worker has died, so the rescue can still read', async () => {
    unavailable.next = true;
    const dead = getDatabaseDriver();
    unavailable.next = false;

    const rescued = await getRescueDatabaseDriver();

    expect(rescued).not.toBe(dead);
    expect(rescued.isUnavailable).toBe(false);
  });

  it('disposes the dead driver rather than leaking its worker', async () => {
    unavailable.next = true;
    const dead = getDatabaseDriver();

    await getRescueDatabaseDriver();

    expect(dead.close).toHaveBeenCalled();
  });
});

/**
 * A driver standing in for one whose database worker has died (issue #503).
 *
 * `WorkerDatabaseDriver` latches permanently once its worker fails: `#send` rejects every
 * subsequent call without posting anything, so *nothing* the caller asks for can succeed. That is
 * the state the Safe Mode rescues have to cope with, and the state their old best-effort reads
 * quietly turned into an empty result. Shared by the rescue-path tests so there is one copy of
 * what "dead" means to keep in step with the driver.
 */
import { vi } from 'vitest';
import { DbError } from '@/db/errors';
import type { IDatabaseDriver } from '@/db/rpc/driver';

/**
 * The rejection a real latched driver produces, down to the code and the message shape: `#fatal`
 * is built as `Database worker error: ${detail}` under `WORKER_UNAVAILABLE`, and every later call
 * is rejected with a copy of it (`db/rpc/worker-driver.ts`).
 */
export const CRASHED_WORKER_MESSAGE = 'Database worker error: the worker has gone away.';

/** A driver that rejects every call, as a crashed worker's latched one does. */
export function crashedDriver(): IDatabaseDriver {
  const fail = async (): Promise<never> => {
    throw new DbError('WORKER_UNAVAILABLE', CRASHED_WORKER_MESSAGE);
  };
  return {
    query: fail as IDatabaseDriver['query'],
    queryOne: fail as IDatabaseDriver['queryOne'],
    exportBinary: fail as IDatabaseDriver['exportBinary'],
    execute: fail as IDatabaseDriver['execute'],
    transaction: fail as IDatabaseDriver['transaction'],
    close: vi.fn(),
  } as unknown as IDatabaseDriver;
}

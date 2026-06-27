/**
 * Shared repository plumbing (spec §2.1.1, §7.6.1).
 *
 * Repositories depend only on the injected {@link IDatabaseDriver} (never the
 * worker), keeping them unit-testable against the in-memory driver (§8.5.2). The
 * optional `isWriteSuspended` hook wires in the storage Hard Stop: production
 * passes `() => isWriteSuspended(useStorageStore.getState().tier)`; tests omit it
 * (defaulting to "never suspended") so the store is not a test dependency.
 */
import { DbError } from '../errors';
import type { IDatabaseDriver } from '../rpc/driver';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants';
import type { Page, PageParams } from './types';

export interface RepositoryOptions {
  /** Returns true when storage is locked and growth-writes must be refused. */
  readonly isWriteSuspended?: () => boolean;
}

export abstract class BaseRepository {
  protected readonly driver: IDatabaseDriver;
  private readonly isWriteSuspended: () => boolean;

  constructor(driver: IDatabaseDriver, options: RepositoryOptions = {}) {
    this.driver = driver;
    this.isWriteSuspended = options.isWriteSuspended ?? (() => false);
  }

  /**
   * Refuse a storage-growing write at the locked tier (the Hard Stop, §7.6.1).
   * Deletions (which free space) must bypass this guard.
   */
  protected assertWritable(): void {
    if (this.isWriteSuspended()) {
      throw new DbError(
        'WRITE_SUSPENDED',
        'Storage is full (Hard Stop): new writes are suspended. Delete items or free space to continue.',
      );
    }
  }

  /** Clamp caller pagination to the strict RPC ceiling (spec §2.1). */
  protected resolvePage(params: PageParams = {}): { limit: number; offset: number } {
    const requested = params.limit ?? DEFAULT_PAGE_SIZE;
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(requested)));
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    return { limit, offset };
  }

  /** Wrap a fetched chunk in a Page envelope (hasMore = a full page came back). */
  protected toPage<T>(rows: readonly T[], limit: number, offset: number): Page<T> {
    return { rows, limit, offset, hasMore: rows.length === limit };
  }
}

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
import { ADMIN_USER_ID, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants';
import type { Page, PageParams } from './types';

export interface RepositoryOptions {
  /** Returns true when storage is locked and growth-writes must be refused. */
  readonly isWriteSuspended?: () => boolean;
  /**
   * Resolves the user every write of this repository is attributed to (issue #79, plan §2.4).
   *
   * Resolved per call rather than captured once, so signing in or out changes attribution
   * without rebuilding the repository graph. Production wires it in `repositories/index.ts`:
   * today that is a constant `Admin` (the users module does not exist yet, and plan §3 says
   * single-user mode acts as Admin), and phase 3 swaps the session in at that one point.
   *
   * Tests omit it and get `Admin` too, which keeps existing fixtures compiling unchanged.
   * Callers that genuinely have no user — maintenance, sync reconciliation, the Bridge —
   * pass {@link SYSTEM_USER_ID} explicitly at the call site instead of relying on this.
   */
  readonly resolveActor?: () => string;
  /**
   * Resolves the user's **base currency** — the single ISO-4217 currency every valuation
   * total is expressed in (issue #284). A supplier part records the currency its price was
   * quoted in, and Gubbins holds no exchange rates, so a price quoted in anything other than
   * the base currency cannot be summed into a total; the valuation queries use this to
   * recognise (and exclude) those prices rather than adding them as if they were base-currency
   * figures.
   *
   * Resolved per call rather than captured once, for the same reason as {@link resolveActor}:
   * changing the base currency in Settings must take effect without rebuilding the repository
   * graph. Production wires it in `repositories/index.ts` to the preferences store.
   *
   * Tests omit it and get `null` — "base currency unknown", which disables the exclusion so
   * existing fixtures value exactly as they did before. Tests covering the mixed-currency rule
   * pass it explicitly.
   */
  readonly resolveBaseCurrency?: () => string | null;
}

export abstract class BaseRepository {
  protected readonly driver: IDatabaseDriver;
  private readonly isWriteSuspended: () => boolean;
  private readonly resolveActor: () => string;
  private readonly resolveBaseCurrency: () => string | null;

  constructor(driver: IDatabaseDriver, options: RepositoryOptions = {}) {
    this.driver = driver;
    this.isWriteSuspended = options.isWriteSuspended ?? (() => false);
    this.resolveActor = options.resolveActor ?? (() => ADMIN_USER_ID);
    this.resolveBaseCurrency = options.resolveBaseCurrency ?? (() => null);
  }

  /**
   * The user id to attribute this write to. Every `historyStatement` call in the repository
   * layer passes this explicitly — the ledger builder takes the actor as a required argument
   * precisely so that omitting it is a compile error rather than a silent `System` entry.
   */
  protected actorId(): string {
    return this.resolveActor();
  }

  /**
   * The base currency to value in, as a normalised upper-case ISO-4217 code, or `null` when it
   * is unknown or not a well-formed code. Normalising here (rather than at each call site) is
   * what makes it safe to embed in a SQL fragment: only three ASCII letters can ever come back,
   * so there is no quoting or injection surface. See {@link RepositoryOptions.resolveBaseCurrency}.
   */
  protected baseCurrency(): string | null {
    const raw = this.resolveBaseCurrency();
    if (raw == null) return null;
    const code = raw.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : null;
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

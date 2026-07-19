/**
 * ApiTokenRepository (issue #79, plan §1.3).
 *
 * Per-user Bridge credentials: minting, listing and revocation. A token grants the Bridge
 * the authority of the user it belongs to — no more — so the rows here are the mapping from
 * "a secret somebody presented" to "who that is".
 *
 * Three properties are load-bearing:
 *
 * - **The plaintext is never stored, and never recoverable.** {@link mint} is the only method
 *   that ever holds one; it returns it alongside the row so the caller can show it once. A
 *   lost token is replaced, not looked up.
 * - **Revocation is a hard delete**, not a `revoked_at` flag. A flag means every consumer has
 *   to remember to check it, and a consumer that forgets keeps honouring a revoked
 *   credential; a missing row cannot be honoured by anybody. `api_tokens` syncs, so the
 *   delete records a tombstone in the same transaction (§7.2) and the revocation reaches
 *   every device — and the Bridge — the same way any other deletion does.
 * - **Minting is `users:manage`.** A token speaks with its owner's authority, so being able to
 *   mint one for an arbitrary user is exactly the power to act as them. That is account
 *   administration, and it is gated as such.
 */
import { mintApiToken, hashApiToken } from '@/features/users/api-token';
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { rowToApiToken } from './mappers';
import { tombstoneStatement } from './tombstone';
import type { ApiToken, ApiTokenRow, CreateApiTokenInput, MintedApiTokenResult } from './types';

/** A token's label has a bound so a name cannot smuggle an unbounded string into the row. */
export const MAX_API_TOKEN_NAME_LENGTH = 100;

export class ApiTokenRepository extends BaseRepository {
  async getById(id: string): Promise<ApiToken | undefined> {
    const row = await this.driver.queryOne<ApiTokenRow>('SELECT * FROM api_tokens WHERE id = ?;', [id]);
    return row ? rowToApiToken(row) : undefined;
  }

  /** Every token belonging to `userId`, newest first. */
  async listByUser(userId: string): Promise<readonly ApiToken[]> {
    const rows = await this.driver.query<ApiTokenRow>(
      'SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC;',
      [userId],
    );
    return rows.map(rowToApiToken);
  }

  /**
   * Resolve a presented token to the id of the user it belongs to, or `undefined`.
   *
   * This is the Bridge's entry point on every request, and it is deliberately **not**
   * permission-gated: the caller is authenticating, so by definition holds no authority yet —
   * the same exception `UserRepository.verifySignIn` makes for the same reason.
   *
   * The lookup is by hash against a UNIQUE index, so it is a single indexed probe rather than
   * a scan-and-compare, and the stored hash never leaves this method.
   */
  async resolveUserId(token: string): Promise<string | undefined> {
    if (token.trim().length === 0) return undefined;
    const row = await this.driver.queryOne<Pick<ApiTokenRow, 'user_id'>>(
      'SELECT user_id FROM api_tokens WHERE token_hash = ?;',
      [await hashApiToken(token)],
    );
    return row?.user_id;
  }

  /**
   * Mint a token for a user, returning the stored row **and** the plaintext.
   *
   * The plaintext is the only copy that will ever exist: it is hashed here and the hash alone
   * is written, so the caller's one chance to show it is now.
   */
  async mint(input: CreateApiTokenInput): Promise<MintedApiTokenResult> {
    this.assertPermission('users:manage');
    this.assertWritable();

    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A token must have a name.');
    }
    if (name.length > MAX_API_TOKEN_NAME_LENGTH) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `A token name may be at most ${MAX_API_TOKEN_NAME_LENGTH} characters.`,
      );
    }

    const minted = await mintApiToken();
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix)
       VALUES (?, ?, ?, ?, ?);`,
      [id, input.userId, name, minted.hash, minted.prefix],
    );
    return { apiToken: (await this.getById(id))!, token: minted.token };
  }

  /**
   * Revoke a token. Bypasses the Hard Stop, as deletes free space. Records a tombstone in the
   * same transaction so the revocation syncs (§7.2) — which is what makes it reach the Bridge.
   */
  async revoke(id: string): Promise<void> {
    this.assertPermission('users:manage');
    if ((await this.getById(id)) === undefined) {
      throw new DbError('SQLITE_CONSTRAINT', 'That token no longer exists.');
    }
    await this.driver.transaction([
      { sql: 'DELETE FROM api_tokens WHERE id = ?;', params: [id] },
      tombstoneStatement('api_tokens', id),
    ]);
  }
}

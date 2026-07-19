/**
 * Test-only helper: mint an API token against a hydrated fixture driver.
 *
 * Since issue #79 the bridge has no shared bearer token to hand a test — a caller is
 * identified by a per-user token that lives in the database, so a test that wants to be
 * *anybody* has to mint one. This wraps that in a line.
 *
 * The default owner is the built-in **Admin**, whose authority resolves to `unrestricted`, so a
 * test using the default is authenticated and permitted everywhere — the same posture the old
 * shared token had. Pass a `userId` to mint for a restricted user instead, which is how the
 * enforcement tests check that a role actually narrows what the bridge will answer.
 *
 * The returned token is random per call and exists only in the test process; nothing
 * credential-shaped is committed.
 */
import { ApiTokenRepository } from '@/db/repositories/ApiTokenRepository';
import { ADMIN_USER_ID } from '@/db/repositories/constants';
import type { IDatabaseDriver } from '@/db/rpc/driver';

/** Mint a token for `userId` (default: the built-in Admin) and return the plaintext. */
export async function mintTestToken(
  driver: IDatabaseDriver,
  userId: string = ADMIN_USER_ID,
): Promise<string> {
  const { token } = await new ApiTokenRepository(driver).mint({ userId, name: 'Test client' });
  return token;
}

/**
 * Read-side hooks for users and roles (issue #79, plan §4 phase 4).
 *
 * Components never touch a repository directly (spec §2.1) — they go through these hooks, and
 * through the separate `mutations.ts` for writes. The split is load-bearing rather than tidy:
 * component tests `vi.mock` this module wholesale, so a mutation co-located here would resolve
 * to `undefined` in every screen test.
 */
import { useQuery } from '@tanstack/react-query';
import { getRoleRepository, getUserRepository } from '@/db/repositories';

export const userKeys = {
  all: ['users'] as const,
  list: () => [...userKeys.all, 'list'] as const,
  /** The sign-in screen's candidate list, invalidated by every account edit. */
  signInCandidates: () => [...userKeys.all, 'sign-in-candidates'] as const,
} as const;

export const roleKeys = {
  all: ['roles'] as const,
  list: () => [...roleKeys.all, 'list'] as const,
} as const;

/**
 * Every account. A household's user list is small by nature — an account is a deliberate,
 * hand-made thing — so it is fetched in one page rather than paginated.
 */
export function useUsers() {
  return useQuery({
    queryKey: userKeys.list(),
    queryFn: () => getUserRepository().list({ limit: 100 }),
    staleTime: 60_000,
  });
}

/** Every role, built-ins first. Same sizing argument as {@link useUsers}. */
export function useRoles() {
  return useQuery({
    queryKey: roleKeys.list(),
    queryFn: () => getRoleRepository().list({ limit: 100 }),
    staleTime: 60_000,
  });
}

/**
 * Write-side hooks for users and roles (issue #79, plan §4 phase 4).
 *
 * Kept in a separate module from `queries.ts` on purpose: component tests `vi.mock` the queries
 * module wholesale, and a mutation co-located there would resolve to `undefined` at every call
 * site. See the same split in `features/webhooks` and `features/suppliers`.
 *
 * Every mutation here also calls {@link refreshAuthority}. Editing an account or a role can
 * change what the *signed-in* user may do — assigning yourself a narrower role, or retuning the
 * role you hold — and the repository guards read a cached authority. Without the refresh the app
 * would keep enforcing the permissions the session started with until the next reload.
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  getRoleRepository,
  getUserRepository,
  type CreateRoleInput,
  type CreateUserInput,
  type UpdateRoleInput,
  type UpdateUserInput,
} from '@/db/repositories';
import { refreshAuthority } from './authority-refresh';
import { roleKeys, userKeys } from './queries';

/**
 * Re-resolve the current session, then drop every cached user/role read.
 *
 * The order matters: the authority is refreshed *before* the invalidation so that the refetches
 * it triggers run under the new permissions rather than the ones being replaced.
 */
async function refreshAfterWrite(client: QueryClient): Promise<void> {
  await refreshAuthority();
  await client.invalidateQueries({ queryKey: userKeys.all });
  await client.invalidateQueries({ queryKey: roleKeys.all });
}

export function useCreateUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) => getUserRepository().create(input),
    onSuccess: () => refreshAfterWrite(client),
  });
}

export function useUpdateUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { readonly id: string; readonly input: UpdateUserInput }) =>
      getUserRepository().update(id, input),
    onSuccess: () => refreshAfterWrite(client),
  });
}

export function useDeleteUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getUserRepository().delete(id),
    onSuccess: () => refreshAfterWrite(client),
  });
}

/** Set or replace a user's password. The plaintext goes no further than the repository. */
export function useSetUserPassword() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password }: { readonly id: string; readonly password: string }) =>
      getUserRepository().setPassword(id, password),
    onSuccess: () => refreshAfterWrite(client),
  });
}

/** Remove a user's password, leaving them able to sign in without one (plan §1.1). */
export function useClearUserPassword() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getUserRepository().clearPassword(id),
    onSuccess: () => refreshAfterWrite(client),
  });
}

export function useCreateRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoleInput) => getRoleRepository().create(input),
    onSuccess: () => refreshAfterWrite(client),
  });
}

export function useUpdateRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { readonly id: string; readonly input: UpdateRoleInput }) =>
      getRoleRepository().update(id, input),
    onSuccess: () => refreshAfterWrite(client),
  });
}

export function useDeleteRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getRoleRepository().delete(id),
    onSuccess: () => refreshAfterWrite(client),
  });
}

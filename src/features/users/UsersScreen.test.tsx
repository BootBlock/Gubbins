/**
 * Users screen tests (issue #79, plan §4 phase 4).
 *
 * Beyond "does it list accounts", three things here are load-bearing:
 *
 *  - the **no-password warning appears on the admin row** in the same words the sign-in tile
 *    uses (plan §1.1), so the two surfaces cannot drift;
 *  - the **built-in principals are not offered edits the schema would refuse** — a control that
 *    exists only to produce a constraint error is worse than no control;
 *  - the screen **says which mode you are in**, since it looks identical whether permissions are
 *    being enforced or entirely ignored.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role, User } from '@/db/repositories/types';
import { ADMIN_USER_ID, SYSTEM_USER_ID } from '@/db/repositories/constants';

// Plain-anchor Link so PageHeader renders without a RouterProvider.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({ BrandMark: () => <span data-testid="brand-mark" /> }));

// The global nav menu and the header's command-palette search have their own suites; stub them
// (foundry-page-header convention) so this screen test needs no router or preferences context.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));
vi.mock('@/features/command-palette/HeaderSearch', () => ({
  HeaderSearch: () => <button type="button" data-testid="header-search" />,
}));

const usersResult = { data: { rows: [] as User[] }, isPending: false, isError: false, refetch: vi.fn() };
const rolesResult = { data: { rows: [] as Role[] }, isPending: false, isError: false, refetch: vi.fn() };
vi.mock('./queries', () => ({
  useUsers: () => usersResult,
  useRoles: () => rolesResult,
  // The token dialog is closed in every test here, so this stays inert — but it must still be
  // mocked, or the hook resolves to `undefined` and the screen fails to render at all.
  useApiTokens: () => ({ data: [], isPending: false }),
  userKeys: { all: ['users'] },
  roleKeys: { all: ['roles'] },
  apiTokenKeys: { all: ['api-tokens'] },
}));

// `vi.mock` is hoisted above this file's bindings, so the spy the factory closes over is created
// through `vi.hoisted` — a plain `const` would still be in its temporal dead zone when it runs.
const deleteUserMutate = vi.hoisted(() => vi.fn());
vi.mock('./mutations', () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useCreateUser: idle,
    useUpdateUser: idle,
    useDeleteUser: () => ({ mutate: deleteUserMutate, isPending: false }),
    useSetUserPassword: idle,
    useClearUserPassword: idle,
    useCreateRole: idle,
    useUpdateRole: idle,
    useDeleteRole: idle,
    useMintApiToken: idle,
    useRevokeApiToken: idle,
  };
});

import { UsersScreen } from './UsersScreen';
import { useModulesStore } from '@/state/stores/useModulesStore';

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    username: 'sam',
    displayName: 'Sam Okafor',
    email: null,
    hasPassword: true,
    isEnabled: true,
    disabledMessage: null,
    kind: 'normal',
    roleId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function role(overrides: Partial<Role> = {}): Role {
  return {
    id: 'r1',
    name: 'Stocker',
    description: null,
    permissions: ['items:read'],
    isBuiltin: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** The row element for a named account, so assertions stay scoped to it. */
function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('li')!;
}

beforeEach(() => {
  usersResult.data = { rows: [user()] };
  rolesResult.data = { rows: [] };
  usersResult.isPending = usersResult.isError = false;
  rolesResult.isPending = rolesResult.isError = false;
  useModulesStore.setState({ intent: {} });
  deleteUserMutate.mockReset();
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
});

describe('UsersScreen — accounts', () => {
  it('lists each account with its username and role', () => {
    usersResult.data = { rows: [user({ roleId: 'r1' })] };
    rolesResult.data = { rows: [role()] };
    render(<UsersScreen />);

    const row = rowFor('Sam Okafor');
    expect(within(row).getByText(/sam/)).toBeInTheDocument();
    expect(within(row).getByText(/Stocker/)).toBeInTheDocument();
  });

  it('warns on the row when an account has no password, in the sign-in tile’s words', () => {
    // Plan §1.1 requires this warning in both places; asserting the exact string is what stops
    // the two surfaces describing the same state differently.
    usersResult.data = { rows: [user({ hasPassword: false })] };
    render(<UsersScreen />);

    expect(within(rowFor('Sam Okafor')).getByText('No password set')).toBeInTheDocument();
  });

  it('does not warn about the System account, which has no password by design', () => {
    usersResult.data = {
      rows: [user({ id: SYSTEM_USER_ID, displayName: 'System', kind: 'system', hasPassword: false })],
    };
    render(<UsersScreen />);

    expect(within(rowFor('System')).queryByText('No password set')).toBeNull();
  });

  it('offers no password, edit or delete control on System — it is an actor, not a person', () => {
    usersResult.data = {
      rows: [user({ id: SYSTEM_USER_ID, displayName: 'System', kind: 'system', hasPassword: false })],
    };
    render(<UsersScreen />);

    const row = rowFor('System');
    expect(within(row).queryByRole('button', { name: 'Password' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Edit account' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Delete account' })).toBeNull();
  });

  it('lets Admin take a password but not be renamed or deleted', () => {
    // The one built-in that can be signed in as, so it must be protectable — but the schema
    // still refuses every other edit (phase 3 narrowed the trigger to exactly this).
    usersResult.data = {
      rows: [user({ id: ADMIN_USER_ID, displayName: 'Admin', kind: 'admin', hasPassword: false })],
    };
    render(<UsersScreen />);

    const row = rowFor('Admin');
    expect(within(row).getByRole('button', { name: 'Password' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Edit account' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Delete account' })).toBeNull();
  });

  it('does not badge System as "sign-in turned off", which reads as an undoable decision', () => {
    usersResult.data = {
      rows: [
        user({
          id: SYSTEM_USER_ID,
          displayName: 'System',
          kind: 'system',
          hasPassword: false,
          isEnabled: false,
        }),
      ],
    };
    render(<UsersScreen />);
    expect(within(rowFor('System')).queryByText('Sign-in turned off')).toBeNull();
  });

  it('marks a disabled account rather than hiding it', () => {
    usersResult.data = { rows: [user({ isEnabled: false })] };
    render(<UsersScreen />);
    expect(within(rowFor('Sam Okafor')).getByText('Sign-in turned off')).toBeInTheDocument();
  });

  it('shows an error instead of an empty list when the accounts fail to load', () => {
    // "No accounts" would be a lie that reads like success and hides a real failure.
    usersResult.isError = true;
    usersResult.data = { rows: [] };
    render(<UsersScreen />);

    expect(screen.getByRole('alert')).toHaveTextContent('The accounts couldn’t be loaded.');
  });
});

describe('UsersScreen — failures are shown, not swallowed', () => {
  it('surfaces a refused delete instead of leaving the dialog looking dead', async () => {
    // A delete can be refused by the permission guard or a built-in trigger. With no `onError`
    // the confirm button simply did nothing, which reads as a broken button.
    deleteUserMutate.mockImplementation((_id, opts) => opts?.onError?.(new Error('Nope')));
    usersResult.data = { rows: [user()] };
    render(<UsersScreen />);

    await userEvent.click(within(rowFor('Sam Okafor')).getByRole('button', { name: 'Delete account' }));
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Delete account' }));

    expect(dialog.getByRole('alert')).toBeInTheDocument();
  });

  it('does not carry an error from one dialog into the next', async () => {
    // `formError` is shared by every dialog, so an opener that forgets to clear it shows the
    // previous failure in a fresh, unsubmitted form.
    deleteUserMutate.mockImplementation((_id, opts) => opts?.onError?.(new Error('Nope')));
    usersResult.data = { rows: [user()] };
    render(<UsersScreen />);

    await userEvent.click(within(rowFor('Sam Okafor')).getByRole('button', { name: 'Delete account' }));
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Delete account' }));
    expect(dialog.getByRole('alert')).toBeInTheDocument();

    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add user' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('UsersScreen — module status', () => {
  it('says plainly that nothing is being enforced while the module is off', () => {
    render(<UsersScreen />);
    expect(screen.getByText(/not asking anyone to sign in/)).toBeInTheDocument();
  });

  it('says sign-in is required once the module is on', () => {
    useModulesStore.getState().setFeatureIntent('users', true);
    render(<UsersScreen />);
    expect(screen.getByText(/Sign-in is required on this device/)).toBeInTheDocument();
  });

  it('still lists accounts with the module off, so the data never looks lost', () => {
    // Accounts and roles survive the module being switched off (plan §3). Hiding them here would
    // make a reversible toggle look like it had deleted something.
    render(<UsersScreen />);
    expect(screen.getByText('Sam Okafor')).toBeInTheDocument();
  });
});

describe('UsersScreen — roles', () => {
  it('offers no delete on a built-in role, which would strand everyone holding it', () => {
    rolesResult.data = { rows: [role({ name: 'Administrator', isBuiltin: true })] };
    render(<UsersScreen />);

    const row = rowFor('Administrator');
    expect(within(row).getByRole('button', { name: 'Edit role' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Delete role' })).toBeNull();
  });

  it('counts how many people hold each role', () => {
    rolesResult.data = { rows: [role()] };
    usersResult.data = {
      rows: [user({ roleId: 'r1' }), user({ id: 'u2', displayName: 'Alex', roleId: 'r1' })],
    };
    render(<UsersScreen />);

    expect(within(rowFor('Stocker')).getByText('2 people have this role')).toBeInTheDocument();
  });
});

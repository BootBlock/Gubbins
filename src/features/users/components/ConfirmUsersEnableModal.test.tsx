/**
 * The enable-time lockout guard (issue #79, plan §3).
 *
 * Switching the users module on is the one toggle that can put somebody outside their own data.
 * These tests pin the states in which confirming is *refused* — the guard is a gate, not just
 * reassuring copy.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { User } from '@/db/repositories/types';
import { SYSTEM_USER_ID } from '@/db/repositories/constants';

const usersResult = {
  data: { rows: [] as User[] },
  isPending: false,
  isError: false,
};
vi.mock('../queries', () => ({ useUsers: () => usersResult }));

import { ConfirmUsersEnableModal, signInCapableAccounts } from './ConfirmUsersEnableModal';

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

const confirmButton = () => screen.getByTestId('confirm-users-enable');

beforeEach(() => {
  usersResult.data = { rows: [user()] };
  usersResult.isPending = false;
  usersResult.isError = false;
});
afterEach(cleanup);

describe('signInCapableAccounts', () => {
  it('excludes System, which is an actor rather than a person', () => {
    const rows = [user(), user({ id: SYSTEM_USER_ID, kind: 'system', displayName: 'System' })];
    expect(signInCapableAccounts(rows).map((u) => u.id)).toEqual(['u1']);
  });

  it('excludes disabled accounts, which cannot sign in', () => {
    const rows = [user(), user({ id: 'u2', isEnabled: false })];
    expect(signInCapableAccounts(rows).map((u) => u.id)).toEqual(['u1']);
  });
});

describe('ConfirmUsersEnableModal', () => {
  it('refuses to confirm while the accounts are still loading', () => {
    // Enabling on the back of an unfinished read would be deciding this is safe without looking.
    usersResult.isPending = true;
    usersResult.data = { rows: [] };
    render(<ConfirmUsersEnableModal onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(confirmButton()).toBeDisabled();
  });

  it('refuses to confirm when the accounts could not be read', () => {
    usersResult.isError = true;
    usersResult.data = { rows: [] };
    render(<ConfirmUsersEnableModal onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(confirmButton()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('sign-in hasn’t been turned on');
  });

  it('refuses to confirm when no account could sign in', () => {
    usersResult.data = { rows: [user({ id: SYSTEM_USER_ID, kind: 'system', displayName: 'System' })] };
    render(<ConfirmUsersEnableModal onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(confirmButton()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('would lock you out');
  });

  it('names a passwordless account as the guaranteed way back in', () => {
    usersResult.data = { rows: [user({ hasPassword: false, displayName: 'Admin' })] };
    render(<ConfirmUsersEnableModal onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText(/You can always get back in as Admin/)).toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it('warns, but still allows, when every account that can sign in has a password', () => {
    // Not blocked: the operator may well know the password. The job here is to make them check
    // before it matters, not to refuse a legitimate configuration.
    usersResult.data = { rows: [user({ hasPassword: true, displayName: 'Sam Okafor' })] };
    render(<ConfirmUsersEnableModal onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText(/Every account that can sign in has a password: Sam Okafor/)).toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it('says that this is reversible and that it does not encrypt anything', () => {
    render(<ConfirmUsersEnableModal onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/switch this back off at any time/)).toBeInTheDocument();
    expect(screen.getByText(/does not encrypt your data/)).toBeInTheDocument();
  });
});

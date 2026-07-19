/**
 * Sign-in screen tests (issue #79, plan §3).
 *
 * Two things are load-bearing here beyond "does it sign in": that an account with no password
 * says so plainly rather than implying a protection it does not have (plan §1.1), and that a
 * disabled account is refused with the administrator's own words where they left any.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from '@/db/repositories/types';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { SignInScreen } from './SignInScreen';

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    username: 'sam',
    displayName: 'Sam',
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

const ok = (u: User) => ({ ok: true as const, user: u });

describe('SignInScreen', () => {
  it('lists the accounts on offer', async () => {
    render(
      <SignInScreen
        users={[user(), user({ id: 'u2', displayName: 'Alex' })]}
        loading={false}
        onSignIn={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Sam/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Alex/ })).toBeInTheDocument();
  });

  it('says plainly when an account has no password', async () => {
    render(<SignInScreen users={[user({ hasPassword: false })]} loading={false} onSignIn={vi.fn()} />);
    expect(screen.getByText('No password set')).toBeInTheDocument();
  });

  it('signs straight in for an account with no password, asking for nothing', async () => {
    const onSignIn = vi.fn().mockResolvedValue(ok(user()));
    render(<SignInScreen users={[user({ hasPassword: false })]} loading={false} onSignIn={onSignIn} />);

    await userEvent.click(screen.getByRole('button', { name: /Sam/ }));

    await waitFor(() => expect(onSignIn).toHaveBeenCalledWith('u1', ''));
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('asks for a password when the account has one, and submits it', async () => {
    const onSignIn = vi.fn().mockResolvedValue(ok(user()));
    render(<SignInScreen users={[user()]} loading={false} onSignIn={onSignIn} />);

    await userEvent.click(screen.getByRole('button', { name: /Sam/ }));
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(onSignIn).toHaveBeenCalledWith('u1', 'correct horse'));
  });

  it('reports a wrong password in an alert, and clears the box to retry', async () => {
    const onSignIn = vi.fn().mockResolvedValue({ ok: false, reason: 'wrong-password' });
    render(<SignInScreen users={[user()]} loading={false} onSignIn={onSignIn} />);

    await userEvent.click(screen.getByRole('button', { name: /Sam/ }));
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/doesn’t match/i);
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('refuses a disabled account with the administrator’s own message', async () => {
    const onSignIn = vi.fn();
    render(
      <SignInScreen
        users={[user({ isEnabled: false, disabledMessage: 'On leave until March.' })]}
        loading={false}
        onSignIn={onSignIn}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Sam/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('On leave until March.');
    // Never even attempted — a disabled account is refused before any password is considered.
    expect(onSignIn).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('falls back to standard wording for a disabled account with no message', async () => {
    render(<SignInScreen users={[user({ isEnabled: false })]} loading={false} onSignIn={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /Sam/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/turned off for this account/i);
  });

  it('lets the user go back and pick a different account', async () => {
    render(
      <SignInScreen
        users={[user(), user({ id: 'u2', displayName: 'Alex' })]}
        loading={false}
        onSignIn={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Sam/ }));
    expect(screen.getByLabelText('Password')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: /Alex/ })).toBeInTheDocument();
  });

  it('says something when the attempt fails outright rather than looking untouched', async () => {
    // A wrong password comes back as an outcome; a dead worker or locked table throws. Without
    // a catch the button just re-enables and the screen reads as "nothing happened".
    const onSignIn = vi.fn().mockRejectedValue(new Error('database unavailable'));
    render(<SignInScreen users={[user({ hasPassword: false })]} loading={false} onSignIn={onSignIn} />);

    await userEvent.click(screen.getByRole('button', { name: /Sam/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('announces a disabled account as unavailable, and describes why', async () => {
    render(
      <SignInScreen
        users={[user({ isEnabled: false, hasPassword: false })]}
        loading={false}
        onSignIn={vi.fn()}
      />,
    );

    const tile = screen.getByRole('button', { name: /Sam/ });
    expect(tile).toHaveAttribute('aria-disabled', 'true');
    // The description must name the note actually rendered — the disabled line wins over the
    // unprotected one, so pointing at the latter would dangle.
    const describedBy = tile.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(/turned off/i);
  });

  it('says so when there is nobody to sign in as', async () => {
    render(<SignInScreen users={[]} loading={false} onSignIn={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/no accounts/i);
  });

  it('offers no way past itself — no navigation and no search', async () => {
    // The whole point of a gate: PageHeader would have mounted app nav and the command
    // palette, either of which walks straight around it.
    render(<SignInScreen users={[user()]} loading={false} onSignIn={vi.fn()} />);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('SignInScreen — the locked-out escape hatch (plan §3)', () => {
  beforeEach(() => {
    useModulesStore.setState({ intent: { users: true } });
  });
  afterEach(() => {
    useModulesStore.setState({ intent: {} });
  });

  it('offers a way out, so a forgotten password cannot strand anyone', async () => {
    // Without this the Modules manager — the only place the module can be switched off — sits
    // behind the very gate a forgotten password closes.
    render(<SignInScreen users={[user()]} loading={false} onSignIn={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Can’t sign in/ })).toBeInTheDocument();
  });

  it('does not switch the module off until the warning is confirmed', async () => {
    render(<SignInScreen users={[user()]} loading={false} onSignIn={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /Can’t sign in/ }));
    // Opening the dialog alone must change nothing — a mis-tap is not a decision.
    expect(useModulesStore.getState().intent.users).toBe(true);

    // The honest explanation of *why* this is possible is part of the deal, not a footnote.
    expect(screen.getByText(/not whether the data is encrypted/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is deleted/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('sign-in-turn-off-users'));
    expect(useModulesStore.getState().intent.users).toBe(false);
  });

  it('cancelling leaves the gate exactly as it was', async () => {
    render(<SignInScreen users={[user()]} loading={false} onSignIn={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /Can’t sign in/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useModulesStore.getState().intent.users).toBe(true);
  });
});

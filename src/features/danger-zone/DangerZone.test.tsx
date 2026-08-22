import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ADMIN_USER_ID } from '@/db/repositories/constants';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { DangerZone } from './DangerZone';

/**
 * The Danger-Zone section and who is offered it (issue #519).
 *
 * The executor is the boundary — these assert the courtesy that goes with it. A role that may
 * erase nothing is not shown the button that would only refuse, and the app-shell reset beside
 * it stays for everyone, because it destroys no data at all.
 */
afterEach(() => {
  cleanup();
  useSessionStore.getState().setResolved(UNRESTRICTED_AUTHORITY, ADMIN_USER_ID);
});

describe('DangerZone', () => {
  it('offers the erase in single-user mode, where every session is unrestricted', () => {
    render(<DangerZone />);
    expect(screen.getByTestId('open-erase-data')).toBeInTheDocument();
  });

  it('hides the erase from a role that may erase nothing, keeping the app-shell reset', () => {
    // A Viewer: reads everything, deletes nothing.
    useSessionStore
      .getState()
      .setResolved({ mode: 'granted', grants: new Set(['items:read', 'stock:read']) }, 'user-1');

    render(<DangerZone />);

    expect(screen.queryByTestId('open-erase-data')).not.toBeInTheDocument();
    expect(screen.getByTestId('reset-app-shell')).toBeInTheDocument();
  });

  it('offers the erase to a role holding one category’s key, not only to an administrator', () => {
    useSessionStore.getState().setResolved({ mode: 'granted', grants: new Set(['tags:delete']) }, 'user-1');

    render(<DangerZone />);

    expect(screen.getByTestId('open-erase-data')).toBeInTheDocument();
  });
});

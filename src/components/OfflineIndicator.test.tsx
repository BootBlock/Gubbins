import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { OfflineIndicator } from './OfflineIndicator';
import type { OnlineStatusApi } from '@/components/foundry/useOnlineStatus';

afterEach(cleanup);

function makeFakeApi(initial: boolean) {
  let online = initial;
  const listeners = new Set<() => void>();
  const api: OnlineStatusApi = {
    isOnline: () => online,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    api,
    set(next: boolean) {
      online = next;
      listeners.forEach((l) => l());
    },
  };
}

describe('OfflineIndicator (spec §2 offline-first / WCAG 4.1.3)', () => {
  it('shows nothing visible while online but keeps a pre-mounted live region', () => {
    const fake = makeFakeApi(true);
    render(<OfflineIndicator api={fake.api} />);
    expect(screen.queryByTestId('offline-indicator')).toBeNull();
    // The announcer is always mounted (empty) so a later change is actually spoken.
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('reveals the reassurance pill when connectivity is lost', () => {
    const fake = makeFakeApi(false);
    render(<OfflineIndicator api={fake.api} />);
    const pill = screen.getByTestId('offline-indicator');
    expect(pill.textContent).toContain('Offline');
    expect(screen.getByRole('status').textContent).toContain('offline');
  });

  it('announces going offline and coming back online, and hides the pill again', () => {
    const fake = makeFakeApi(true);
    render(<OfflineIndicator api={fake.api} />);

    act(() => fake.set(false));
    expect(screen.getByTestId('offline-indicator')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('offline');

    act(() => fake.set(true));
    expect(screen.queryByTestId('offline-indicator')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Back online');
  });
});

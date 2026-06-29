import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { PwaUpdatePrompt } from './PwaUpdatePrompt';
import { usePwaUpdateSnoozeStore } from '@/components/foundry/usePwaUpdateSnoozeStore';
import type { PwaUpdateApi, PwaUpdateHandlers } from '@/components/foundry/usePwaUpdate';

beforeEach(() => {
  // The persist store is a module-level singleton — reset it (and its backing storage)
  // so a snooze set by one test never leaks into the next.
  usePwaUpdateSnoozeStore.setState({ snoozedUntil: 0 });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Fake seam: `emitWaiting()` simulates a new worker becoming available. */
function makeFakeApi() {
  let handlers: PwaUpdateHandlers | undefined;
  const update = vi.fn(async (_reloadPage?: boolean) => {});
  const api: PwaUpdateApi = {
    register(h) {
      handlers = h;
      return update;
    },
    checkForUpdate: vi.fn(async () => {}),
  };
  return { api, update, emitWaiting: () => handlers?.onNeedRefresh() };
}

describe('PwaUpdatePrompt (spec §2 PWA update — no surprise reload)', () => {
  it('renders nothing until an update is waiting', () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();
  });

  it('surfaces the "Reload now" prompt once a new version is waiting', () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    act(() => fake.emitWaiting());
    const prompt = screen.getByTestId('pwa-update-prompt');
    expect(prompt.getAttribute('role')).toBe('alert');
    expect(prompt.textContent).toContain('new version');
  });

  it('applies the waiting worker only when the user clicks Reload now', () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    act(() => fake.emitWaiting());
    // Nothing applied just because an update exists — the user is in control.
    expect(fake.update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('pwa-reload-now'));
    expect(fake.update).toHaveBeenCalledWith(true);
  });

  it('dismissing the prompt snoozes (hides) it', () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    act(() => fake.emitWaiting());
    expect(screen.getByTestId('pwa-update-prompt')).toBeTruthy();

    fireEvent.click(screen.getByTestId('pwa-dismiss'));
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();
  });

  it('does not apply the waiting worker when dismissing', () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    act(() => fake.emitWaiting());

    fireEvent.click(screen.getByTestId('pwa-dismiss'));
    expect(fake.update).not.toHaveBeenCalled();
  });

  it('re-shows the prompt when a genuinely new worker arrives after dismissal', () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    act(() => fake.emitWaiting());
    fireEvent.click(screen.getByTestId('pwa-dismiss'));
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();

    // A new waiting worker ticks `updateAvailableSeq`, which clears the snooze.
    act(() => fake.emitWaiting());
    expect(screen.getByTestId('pwa-update-prompt')).toBeTruthy();
  });

  it('keeps the prompt snoozed across a reload (the first notification re-announces the same worker)', () => {
    const fake = makeFakeApi();
    const { unmount } = render(<PwaUpdatePrompt api={fake.api} />);
    act(() => fake.emitWaiting());
    fireEvent.click(screen.getByTestId('pwa-dismiss'));
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();

    // Simulate a full page reload: tear down and re-mount with a fresh seam, so the hook's
    // `updateAvailableSeq` resets to 0 while the persisted snooze (singleton store +
    // localStorage) survives. The still-waiting worker re-announces on the new load…
    unmount();
    const reloaded = makeFakeApi();
    render(<PwaUpdatePrompt api={reloaded.api} />);
    act(() => reloaded.emitWaiting());
    // …and that first-of-session notification must NOT clear the snooze — the banner stays
    // hidden for the rest of the ~8h window.
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();

    // But a genuinely newer worker installing during this session still re-surfaces it.
    act(() => reloaded.emitWaiting());
    expect(screen.getByTestId('pwa-update-prompt')).toBeTruthy();
  });

  it('re-shows the prompt once the snooze has expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-29T09:00:00Z'));

    const fake = makeFakeApi();
    const { rerender } = render(<PwaUpdatePrompt api={fake.api} />);
    act(() => fake.emitWaiting());
    fireEvent.click(screen.getByTestId('pwa-dismiss'));
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();

    // Jump past the ~8h snooze window and re-render — the deadline is in the past now.
    vi.setSystemTime(new Date('2026-06-29T18:00:00Z'));
    rerender(<PwaUpdatePrompt api={fake.api} />);
    expect(screen.getByTestId('pwa-update-prompt')).toBeTruthy();
  });
});

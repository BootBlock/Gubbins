import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { PwaUpdatePrompt } from './PwaUpdatePrompt';
import type { PwaUpdateApi, PwaUpdateHandlers } from '@/components/foundry/usePwaUpdate';

afterEach(cleanup);

/** Fake seam: `emitWaiting()` simulates a new worker becoming available. */
function makeFakeApi() {
  let handlers: PwaUpdateHandlers | undefined;
  const update = vi.fn(async (_reloadPage?: boolean) => {});
  const api: PwaUpdateApi = {
    register(h) {
      handlers = h;
      return update;
    },
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
});

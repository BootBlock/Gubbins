import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { PwaUpdatePrompt } from './PwaUpdatePrompt';
import { usePwaUpdateSnoozeStore } from '@/components/foundry/usePwaUpdateSnoozeStore';
import type { DeployedVersion, PwaUpdateApi, PwaUpdateHandlers } from '@/components/foundry/usePwaUpdate';
import { APP_SCHEMA_VERSION } from '@/lib/app-version';

beforeEach(() => {
  // The persist store is a module-level singleton — reset it (and its backing storage)
  // so a snooze/skip set by one test never leaks into the next.
  usePwaUpdateSnoozeStore.setState({ snoozedUntil: 0, skippedVersion: null });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Fake seam: `emitWaiting()` simulates a new worker becoming available. `fetchDeployedVersion`
 * returns the configured incoming-deploy identity; the build define pins the running build to
 * `schemaVersion` 1, so a deploy at `schemaVersion` 1 is data-compatible and any other value is
 * a data-resetting update.
 */
function makeFakeApi(deployed: DeployedVersion | null = { version: '0.1.1', schemaVersion: 1 }) {
  let handlers: PwaUpdateHandlers | undefined;
  let deployedValue = deployed;
  const update = vi.fn(async (_reloadPage?: boolean) => {});
  const api: PwaUpdateApi = {
    register(h) {
      handlers = h;
      return update;
    },
    checkForUpdate: vi.fn(async () => {}),
    fetchDeployedVersion: vi.fn(async () => deployedValue),
  };
  return {
    api,
    update,
    emitWaiting: () => handlers?.onNeedRefresh(),
    setDeployed: (value: DeployedVersion | null) => {
      deployedValue = value;
    },
  };
}

/** Announce a waiting worker and flush the async `version.json` read it kicks off. */
async function emitAndSettle(fake: ReturnType<typeof makeFakeApi>) {
  await act(async () => {
    fake.emitWaiting();
  });
}

describe('PwaUpdatePrompt (spec §2 PWA update — no surprise reload)', () => {
  it('renders nothing until an update is waiting', () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();
  });

  it('surfaces the "Reload now" prompt once a new version is waiting', async () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    await emitAndSettle(fake);
    const prompt = screen.getByTestId('pwa-update-prompt');
    expect(prompt.getAttribute('role')).toBe('alert');
    expect(prompt.textContent).toContain('new version');
  });

  it('applies the waiting worker only when the user clicks Reload now', async () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    await emitAndSettle(fake);
    // Nothing applied just because an update exists — the user is in control.
    expect(fake.update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('pwa-reload-now'));
    expect(fake.update).toHaveBeenCalledWith(true);
  });

  it('dismissing the prompt snoozes (hides) it', async () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    await emitAndSettle(fake);
    expect(screen.getByTestId('pwa-update-prompt')).toBeTruthy();

    fireEvent.click(screen.getByTestId('pwa-dismiss'));
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();
  });

  it('does not apply the waiting worker when dismissing', async () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    await emitAndSettle(fake);

    fireEvent.click(screen.getByTestId('pwa-dismiss'));
    expect(fake.update).not.toHaveBeenCalled();
  });

  it('re-shows the prompt when a genuinely new worker arrives after dismissal', async () => {
    const fake = makeFakeApi();
    render(<PwaUpdatePrompt api={fake.api} />);
    await emitAndSettle(fake);
    fireEvent.click(screen.getByTestId('pwa-dismiss'));
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();

    // A new waiting worker ticks `updateAvailableSeq`, which clears the snooze.
    await emitAndSettle(fake);
    expect(screen.getByTestId('pwa-update-prompt')).toBeTruthy();
  });

  it('keeps the prompt snoozed across a reload (the first notification re-announces the same worker)', async () => {
    const fake = makeFakeApi();
    const { unmount } = render(<PwaUpdatePrompt api={fake.api} />);
    await emitAndSettle(fake);
    fireEvent.click(screen.getByTestId('pwa-dismiss'));
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();

    // Simulate a full page reload: tear down and re-mount with a fresh seam, so the hook's
    // `updateAvailableSeq` resets to 0 while the persisted snooze (singleton store +
    // localStorage) survives. The still-waiting worker re-announces on the new load…
    unmount();
    const reloaded = makeFakeApi();
    render(<PwaUpdatePrompt api={reloaded.api} />);
    await emitAndSettle(reloaded);
    // …and that first-of-session notification must NOT clear the snooze — the banner stays
    // hidden for the rest of the ~8h window.
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();

    // But a genuinely newer worker installing during this session still re-surfaces it.
    await emitAndSettle(reloaded);
    expect(screen.getByTestId('pwa-update-prompt')).toBeTruthy();
  });

  it('re-shows the prompt once the snooze has expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-29T09:00:00Z'));

    const fake = makeFakeApi();
    const { rerender } = render(<PwaUpdatePrompt api={fake.api} />);
    await act(async () => {
      fake.emitWaiting();
    });
    fireEvent.click(screen.getByTestId('pwa-dismiss'));
    expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();

    // Jump past the ~8h snooze window and re-render — the deadline is in the past now.
    vi.setSystemTime(new Date('2026-06-29T18:00:00Z'));
    rerender(<PwaUpdatePrompt api={fake.api} />);
    expect(screen.getByTestId('pwa-update-prompt')).toBeTruthy();
  });

  describe('data-safety check (issue #74)', () => {
    it('reassures when the incoming build keeps the same schema', async () => {
      // Relative to the *running* schema version, never a hard-coded number — this constant
      // is meant to change whenever the schema does, and the assertion is about sameness.
      const fake = makeFakeApi({ version: '0.2.0', schemaVersion: APP_SCHEMA_VERSION });
      render(<PwaUpdatePrompt api={fake.api} />);
      await emitAndSettle(fake);
      expect(screen.getByTestId('pwa-update-prompt').textContent).toContain('stays intact');
    });

    it('warns that data will be reset when the incoming build changes schema', async () => {
      const fake = makeFakeApi({ version: '0.2.0', schemaVersion: APP_SCHEMA_VERSION + 1 });
      render(<PwaUpdatePrompt api={fake.api} />);
      await emitAndSettle(fake);
      const prompt = screen.getByTestId('pwa-update-prompt');
      expect(prompt.textContent).toContain('reset your saved inventory');
      expect(prompt.textContent).not.toContain('stays intact');
    });

    it('makes no promise when the incoming build cannot be identified', async () => {
      const fake = makeFakeApi(null);
      render(<PwaUpdatePrompt api={fake.api} />);
      await emitAndSettle(fake);
      const prompt = screen.getByTestId('pwa-update-prompt');
      expect(prompt.textContent).not.toContain('stays intact');
      expect(prompt.textContent).not.toContain('reset your saved inventory');
      // Without a known version there is nothing specific to skip.
      expect(screen.queryByTestId('pwa-skip-version')).toBeNull();
    });
  });

  describe('skip this version (issue #74)', () => {
    it('hides the prompt and records the skipped version', async () => {
      // Relative to the *running* schema version, never a hard-coded number — this constant
      // is meant to change whenever the schema does, and the assertion is about sameness.
      const fake = makeFakeApi({ version: '0.2.0', schemaVersion: APP_SCHEMA_VERSION });
      render(<PwaUpdatePrompt api={fake.api} />);
      await emitAndSettle(fake);

      fireEvent.click(screen.getByTestId('pwa-skip-version'));
      expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();
      expect(usePwaUpdateSnoozeStore.getState().skippedVersion).toBe('0.2.0');
      // Skipping is not reloading — the waiting worker is left untouched.
      expect(fake.update).not.toHaveBeenCalled();
    });

    it('stays hidden when the same skipped version re-announces after a reload', async () => {
      usePwaUpdateSnoozeStore.setState({ skippedVersion: '0.2.0' });
      // Relative to the *running* schema version, never a hard-coded number — this constant
      // is meant to change whenever the schema does, and the assertion is about sameness.
      const fake = makeFakeApi({ version: '0.2.0', schemaVersion: APP_SCHEMA_VERSION });
      render(<PwaUpdatePrompt api={fake.api} />);
      await emitAndSettle(fake);
      expect(screen.queryByTestId('pwa-update-prompt')).toBeNull();
    });

    it('re-appears once a newer version than the skipped one is deployed', async () => {
      usePwaUpdateSnoozeStore.setState({ skippedVersion: '0.2.0' });
      const fake = makeFakeApi({ version: '0.3.0', schemaVersion: 1 });
      render(<PwaUpdatePrompt api={fake.api} />);
      await emitAndSettle(fake);
      expect(screen.getByTestId('pwa-update-prompt')).toBeTruthy();
    });
  });
});

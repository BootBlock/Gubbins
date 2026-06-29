import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import {
  useInstallPrompt,
  type BeforeInstallPromptEventLike,
  type InstallPromptApi,
  type InstallPromptHandlers,
} from './useInstallPrompt';

afterEach(cleanup);

/** A controllable fake seam that lets a test fire the platform install events. */
class FakeInstallApi implements InstallPromptApi {
  private handlers: InstallPromptHandlers | null = null;
  constructor(private standalone = false) {}
  isStandalone() {
    return this.standalone;
  }
  subscribe(handlers: InstallPromptHandlers) {
    this.handlers = handlers;
    return () => {
      this.handlers = null;
    };
  }
  get subscribed() {
    return this.handlers !== null;
  }
  firePrompt(event: BeforeInstallPromptEventLike) {
    this.handlers?.onPrompt(event);
  }
  fireInstalled() {
    this.handlers?.onInstalled();
  }
}

/** A fake `beforeinstallprompt` event recording preventDefault + prompt calls. */
function fakeEvent(): BeforeInstallPromptEventLike & {
  preventDefault: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
} {
  return {
    preventDefault: vi.fn(),
    prompt: vi.fn(async () => {}),
  };
}

describe('useInstallPrompt (spec §2 PWA installation)', () => {
  it('cannot install until the platform fires beforeinstallprompt', () => {
    const { result } = renderHook(() => useInstallPrompt(new FakeInstallApi()));
    expect(result.current.canInstall).toBe(false);
    expect(result.current.installed).toBe(false);
  });

  it('becomes installable and suppresses the default infobar when the event fires', () => {
    const api = new FakeInstallApi();
    const { result } = renderHook(() => useInstallPrompt(api));
    const event = fakeEvent();
    act(() => api.firePrompt(event));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(result.current.canInstall).toBe(true);
  });

  it('triggers the native dialog and consumes the single-use event on promptInstall', async () => {
    const api = new FakeInstallApi();
    const { result } = renderHook(() => useInstallPrompt(api));
    const event = fakeEvent();
    act(() => api.firePrompt(event));

    await act(async () => {
      await result.current.promptInstall();
    });
    expect(event.prompt).toHaveBeenCalledTimes(1);
    // The captured event is single-use, so the affordance retracts after prompting.
    expect(result.current.canInstall).toBe(false);
  });

  it('reports already-installed and never offers install when launched standalone', () => {
    const api = new FakeInstallApi(true);
    const { result } = renderHook(() => useInstallPrompt(api));
    expect(result.current.installed).toBe(true);
    act(() => api.firePrompt(fakeEvent()));
    expect(result.current.canInstall).toBe(false);
  });

  it('marks installed and retracts the affordance on appinstalled', () => {
    const api = new FakeInstallApi();
    const { result } = renderHook(() => useInstallPrompt(api));
    act(() => api.firePrompt(fakeEvent()));
    expect(result.current.canInstall).toBe(true);
    act(() => api.fireInstalled());
    expect(result.current.installed).toBe(true);
    expect(result.current.canInstall).toBe(false);
  });

  it('promptInstall is a no-op when nothing is installable', async () => {
    const { result } = renderHook(() => useInstallPrompt(new FakeInstallApi()));
    await act(async () => {
      await result.current.promptInstall();
    });
    expect(result.current.canInstall).toBe(false);
  });

  it('unsubscribes on unmount (no leak)', () => {
    const api = new FakeInstallApi();
    const { unmount } = renderHook(() => useInstallPrompt(api));
    expect(api.subscribed).toBe(true);
    unmount();
    expect(api.subscribed).toBe(false);
  });
});

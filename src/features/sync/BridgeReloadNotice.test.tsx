import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { BridgeReloadNotice } from './BridgeReloadNotice';

/**
 * The "reload to connect to this bridge" notice (issue #385).
 *
 * The *decision* it renders is tested as pure logic in `src/csp.test.ts`; what matters here is
 * that it stays **silent**. It sits on three screens a user visits constantly, so the failure
 * mode worth guarding is not "it didn't appear" but "it nags" — about an address that already
 * works, or about a reload that could not possibly help because nothing is there to widen the
 * policy. Only the one case where a reload genuinely fixes something may show anything at all.
 */
const policy = vi.hoisted(() => ({ controlled: true, allows: false, registered: [] as (string | null)[] }));

vi.mock('@/lib/bridge-connect-policy', () => ({
  hasServiceWorkerControl: () => policy.controlled,
  documentAllowsBridgeOrigin: () => policy.allows,
  registerBridgeOrigin: (origin: string | null) => {
    policy.registered.push(origin);
    return Promise.resolve();
  },
}));

const BRIDGE = 'http://gubbins-bridge.test:8787';

beforeEach(() => {
  policy.controlled = true;
  policy.allows = false;
  policy.registered = [];
  usePreferencesStore.setState({ bridgeUrl: '' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BridgeReloadNotice', () => {
  it('says nothing when no bridge address has been entered', () => {
    render(<BridgeReloadNotice />);
    expect(screen.queryByTestId('bridge-reload-notice')).toBeNull();
  });

  it('says nothing when the policy already covers the address', () => {
    policy.allows = true;
    usePreferencesStore.setState({ bridgeUrl: BRIDGE });
    render(<BridgeReloadNotice />);
    expect(screen.queryByTestId('bridge-reload-notice')).toBeNull();
  });

  it('says nothing when no service worker is in control, because no reload could help', () => {
    policy.controlled = false;
    usePreferencesStore.setState({ bridgeUrl: BRIDGE });
    render(<BridgeReloadNotice />);
    expect(screen.queryByTestId('bridge-reload-notice')).toBeNull();
  });

  it('offers the reload, naming the address, when that is what the bridge is waiting on', () => {
    usePreferencesStore.setState({ bridgeUrl: `${BRIDGE}/` });
    render(<BridgeReloadNotice />);

    const notice = screen.getByTestId('bridge-reload-notice');
    // The address is named so the user can tell *which* bridge, and can spot a typo here rather
    // than after a fruitless reload. The trailing slash is normalised away.
    expect(notice.textContent).toContain(BRIDGE);
    expect(notice.textContent).not.toContain(`${BRIDGE}/`);
    expect(screen.getByTestId('bridge-reload')).toBeTruthy();
  });

  it('tells the worker the address once it stops changing, not once per keystroke', () => {
    vi.useFakeTimers();
    usePreferencesStore.setState({ bridgeUrl: 'http://gub' });
    render(<BridgeReloadNotice />);

    // Mid-typing: each of these parses as a valid — but different — origin, and registering
    // eagerly would post a message and write to CacheStorage for every one of them.
    act(() => {
      vi.advanceTimersByTime(200);
      usePreferencesStore.setState({ bridgeUrl: 'http://gubbins-bridge.test' });
      vi.advanceTimersByTime(200);
      usePreferencesStore.setState({ bridgeUrl: BRIDGE });
    });
    expect(policy.registered).toEqual([]);

    act(() => vi.advanceTimersByTime(1_000));
    expect(policy.registered).toEqual([BRIDGE]);
  });
});

/**
 * Wire-version negotiation across the bridge (issue #664).
 *
 * The PWA and the companion extension update independently, so they are routinely a generation
 * apart — and §9.1 has the receiving side drop an unrecognised message in silence, which makes
 * that drift look exactly like a hostile page. What this pins is the handshake that ends the
 * silence: the app records what the peer said about itself, gates each capability on the
 * generation the peer actually speaks, and answers with its own hello so the extension can do
 * the same in reverse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ScrapeBridgeProvider, useScrapeBridge } from './ScrapeBridgeContext';
import { ASSUMED_PROTOCOL_VERSION, makeMessage, PROTOCOL_VERSION } from './protocol';

let bridge: ReturnType<typeof useScrapeBridge>;

function Probe() {
  bridge = useScrapeBridge();
  return null;
}

/** Deliver a message into the page exactly as the content script would. */
function deliver(message: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message, origin: window.location.origin }));
  });
}

let post: ReturnType<typeof vi.fn>;

function mount(): void {
  render(
    <ScrapeBridgeProvider>
      <Probe />
    </ScrapeBridgeProvider>,
  );
}

/** One outbound hello as it went onto the wire. */
type PostedHello = { type: string; payload?: { version?: string; protocol?: number } };

/** Every message the provider posted, in order. */
function posted(): PostedHello[] {
  return post.mock.calls.map((call) => call[0] as PostedHello);
}

beforeEach(() => {
  post = vi.fn();
  vi.spyOn(window, 'postMessage').mockImplementation(post as unknown as typeof window.postMessage);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EXTENSION_READY carries a peer the app keeps', () => {
  it('records the announced version and generation instead of discarding them', () => {
    mount();
    expect(bridge.peer).toBeNull();

    deliver(makeMessage('EXTENSION_READY', { version: '1.7.0', protocol: PROTOCOL_VERSION }));

    expect(bridge.ready).toBe(true);
    expect(bridge.peer).toEqual({ version: '1.7.0', protocol: PROTOCOL_VERSION });
    expect(bridge.peerOutdated).toBe(false);
  });

  it('credits a hello with no generation at all with the pre-negotiation set', () => {
    mount();
    // Every build before negotiation shipped the full generation-4 message set, so an installed
    // one keeps all four capabilities rather than being demoted to scrape-only.
    deliver(makeMessage('EXTENSION_READY', { version: '1.6.0' }));

    expect(bridge.peer).toEqual({ version: '1.6.0', protocol: ASSUMED_PROTOCOL_VERSION });
    expect(bridge.supports('dataFetch')).toBe(true);
  });

  it('answers the hello with the app’s own, so the extension learns this generation', () => {
    mount();
    deliver(makeMessage('EXTENSION_READY', { version: '1.7.0', protocol: PROTOCOL_VERSION }));

    const hello = posted().find((msg) => msg.type === 'APP_READY');
    expect(hello?.payload?.protocol).toBe(PROTOCOL_VERSION);
    expect(typeof hello?.payload?.version).toBe('string');
  });
});

describe('capabilities are gated on the generation the peer speaks', () => {
  it('supports nothing before any extension has announced itself', () => {
    mount();
    expect(bridge.supports('scrape')).toBe(false);
    expect(bridge.supports('productLookup')).toBe(false);
  });

  it('offers only what a generation-1 peer understands', () => {
    mount();
    deliver(makeMessage('EXTENSION_READY', { version: '1.0.0', protocol: 1 }));

    // Ready, but three of the four capabilities would go unanswered — so they are not offered.
    expect(bridge.ready).toBe(true);
    expect(bridge.supports('scrape')).toBe(true);
    expect(bridge.supports('productLookup')).toBe(false);
    expect(bridge.supports('activeTab')).toBe(false);
    expect(bridge.supports('dataFetch')).toBe(false);
  });

  it('offers every capability to a peer a generation ahead of this build', () => {
    mount();
    deliver(makeMessage('EXTENSION_READY', { version: '9.0.0', protocol: PROTOCOL_VERSION + 1 }));

    expect(bridge.supports('dataFetch')).toBe(true);
    expect(bridge.peerOutdated).toBe(false);
  });
});

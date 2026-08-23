/**
 * The Settings row that names the connected companion extension (issue #664).
 *
 * An extension a generation behind is silent by design (§9.1), so without this row it looks
 * identical to no extension at all and a report of "the lookup button does nothing" has nowhere
 * to start. What is pinned here is that the three states read differently, and that the row
 * survives a screen with no bridge mounted above it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PROTOCOL_VERSION, type BridgeStatus } from '@/features/scraping';
import { CompanionExtensionStatus } from './CompanionExtensionStatus';

const status = vi.hoisted(() => ({
  value: { ready: false, peer: null, peerBehind: false } as BridgeStatus,
}));
vi.mock('@/features/scraping', async (orig) => ({
  ...(await orig<typeof import('@/features/scraping')>()),
  useScrapeBridgeStatus: () => status.value,
}));

afterEach(cleanup);

describe('CompanionExtensionStatus', () => {
  it('says nothing has announced itself when no extension is connected', () => {
    status.value = { ready: false, peer: null, peerBehind: false };
    render(<CompanionExtensionStatus />);

    expect(screen.getByTestId('companion-extension-status')).toHaveTextContent('Not detected');
  });

  it('names the build version and the wire generation of a connected extension', () => {
    status.value = {
      ready: true,
      peer: { version: '1.7.0', protocol: PROTOCOL_VERSION },
      peerBehind: false,
    };
    render(<CompanionExtensionStatus />);

    expect(screen.getByTestId('companion-extension-status')).toHaveTextContent('Connected');
    expect(
      screen.getByText((text) => text.includes('1.7.0') && text.includes(`generation ${PROTOCOL_VERSION}`)),
    ).toBeInTheDocument();
  });

  it('says an update is available when the extension is a generation behind', () => {
    // The state every user with a pre-1.7.0 build is in: nothing is broken, but the app offers
    // it nothing newer, and the row is the only place that says so.
    status.value = {
      ready: true,
      peer: { version: '1.6.0', protocol: PROTOCOL_VERSION - 1 },
      peerBehind: true,
    };
    render(<CompanionExtensionStatus />);

    expect(screen.getByTestId('companion-extension-status')).toHaveTextContent('Update available');
    expect(screen.getByText(/Rebuild the extension and reload it/)).toBeInTheDocument();
  });
});

/**
 * The Settings row that names the connected companion extension (issue #664).
 *
 * Before it, the app read the extension's version off the wire and discarded it, so an extension
 * a generation behind — silent by design (§9.1) — looked identical to no extension at all, and a
 * report of "the lookup button does nothing" had nowhere to start. What is pinned here is that
 * the three states read differently, and that the row survives a screen with no bridge mounted
 * above it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { BridgeStatus } from '@/features/scraping';
import { CompanionExtensionStatus } from './CompanionExtensionStatus';

const status = vi.hoisted(() => ({
  value: { ready: false, peer: null, peerOutdated: false } as BridgeStatus,
}));
vi.mock('@/features/scraping', async (orig) => ({
  ...(await orig<typeof import('@/features/scraping')>()),
  useScrapeBridgeStatus: () => status.value,
}));

afterEach(cleanup);

describe('CompanionExtensionStatus', () => {
  it('says nothing has announced itself when no extension is connected', () => {
    status.value = { ready: false, peer: null, peerOutdated: false };
    render(<CompanionExtensionStatus />);

    expect(screen.getByTestId('companion-extension-status')).toHaveTextContent('Not detected');
  });

  it('names the build version and the wire generation of a connected extension', () => {
    status.value = { ready: true, peer: { version: '1.7.0', protocol: 5 }, peerOutdated: false };
    render(<CompanionExtensionStatus />);

    expect(screen.getByTestId('companion-extension-status')).toHaveTextContent('Connected');
    expect(screen.getByText(/1\.7\.0/)).toBeInTheDocument();
    expect(screen.getByText(/generation 5/)).toBeInTheDocument();
  });

  it('tells the user to update an extension too old to work with', () => {
    status.value = { ready: true, peer: { version: '0.1.0', protocol: 0 }, peerOutdated: true };
    render(<CompanionExtensionStatus />);

    expect(screen.getByTestId('companion-extension-status')).toHaveTextContent('Update needed');
    expect(screen.getByText('Update the companion extension')).toBeInTheDocument();
  });
});

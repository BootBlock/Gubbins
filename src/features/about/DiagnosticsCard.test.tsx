import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { DiagnosticsCard } from './DiagnosticsCard';
import type { Diagnostics } from './diagnostics';

const SAMPLE: Diagnostics = {
  version: '2026.07.11',
  buildDate: '2026-07-11',
  userAgent: 'Mozilla/5.0 (Test) ExampleBrowser/1.0',
  platform: 'TestPlatform',
  language: 'en-GB',
  timeZone: 'Europe/London',
  utcOffset: 'UTC+01:00',
  viewportWidth: 1280,
  viewportHeight: 720,
  screenWidth: 1920,
  screenHeight: 1080,
  devicePixelRatio: 2,
  colorScheme: 'dark',
  reducedMotion: false,
  online: true,
  displayMode: 'browser',
  storageUsage: 45_200_000,
  storageQuota: 2_000_000_000,
};

// The card reads the environment via `gatherDiagnostics`; pin it so the assertions are stable.
vi.mock('./diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./diagnostics')>();
  return { ...actual, gatherDiagnostics: vi.fn(async () => SAMPLE) };
});

afterEach(cleanup);

describe('DiagnosticsCard', () => {
  beforeEach(() => {
    // `navigator.clipboard` is a getter-only property in the test DOM; redefine it.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
  });

  it('is collapsed and unpopulated by default', () => {
    render(<DiagnosticsCard />);
    const toggle = screen.getByRole('button', { name: 'Diagnostics' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Press Refresh to gather diagnostics from this device.')).toBeNull();
  });

  it('expands to the empty prompt without gathering until Refresh is pressed', async () => {
    render(<DiagnosticsCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));

    expect(screen.getByText('Press Refresh to gather diagnostics from this device.')).toBeInTheDocument();
    // No diagnostics rendered yet.
    expect(screen.queryByText('Browser')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(screen.getByText('Browser')).toBeInTheDocument());
    expect(screen.getByText('Mozilla/5.0 (Test) ExampleBrowser/1.0')).toBeInTheDocument();
    expect(screen.getByText('1280 × 720')).toBeInTheDocument();
  });

  it('copies the (unredacted) diagnostics to the clipboard', async () => {
    render(<DiagnosticsCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('Europe/London (UTC+01:00)'),
      ),
    );
    await waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument());
  });

  it('offers a GitHub issue link that pre-fills the bug-report form with redacted details', async () => {
    render(<DiagnosticsCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    const link = await screen.findByRole('link', { name: 'Open issue on GitHub' });
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('/issues/new');
    expect(href).toContain('template=bug_report.yml');
    // Redacted: the region-identifying zone name must not appear in the public issue URL.
    expect(decodeURIComponent(href)).not.toContain('Europe/London');
  });
});

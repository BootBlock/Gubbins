/**
 * Behaviour tests for the shared {@link ScannerViewfinder} chrome — the in-frame states both
 * camera surfaces (the full overlay and the focused barcode dialog) render identically.
 *
 * The camera failing is the state worth pinning hardest: a screen-reader user cannot tell a dead
 * viewfinder from a live one by looking, so the reason has to be announced rather than merely
 * drawn (issue #317).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScannerViewfinder } from './ScannerViewfinder';

function renderViewfinder(props: Partial<Parameters<typeof ScannerViewfinder>[0]> = {}) {
  return render(
    <ScannerViewfinder
      status="ERROR_STATE"
      hint="Point at a barcode"
      error="The camera preview could not be started. You can still enter codes manually."
      onRetry={vi.fn()}
      {...props}
    />,
  );
}

describe('ScannerViewfinder — camera failure', () => {
  it('announces the failure reason rather than only drawing it', () => {
    renderViewfinder();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'The camera preview could not be started. You can still enter codes manually.',
    );
  });

  it('offers a way back to the camera alongside the reason', () => {
    renderViewfinder();

    expect(screen.getByRole('button', { name: 'Try the camera again' })).toBeInTheDocument();
  });

  it('raises no alert while the camera is working', () => {
    renderViewfinder({ status: 'STREAM_ACTIVE', error: null });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Scanning…')).toBeInTheDocument();
  });
});

describe('ScannerViewfinder — waiting for permission', () => {
  it('announces the wait as well as drawing it', () => {
    renderViewfinder({ status: 'REQUESTING_PERMISSIONS', error: null });

    expect(screen.getByRole('status')).toHaveTextContent('Requesting camera access…');
  });

  it('keeps the status region mounted before there is anything to say', () => {
    // The region has to pre-exist the message: one inserted at the moment its text appears is
    // frequently never announced, so mounting it with the message would defeat the point.
    renderViewfinder({ status: 'IDLE', error: null });

    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(region).toBeEmptyDOMElement();
  });

  it('keeps the empty region out of flow so it cannot shift the centred video', () => {
    renderViewfinder({ status: 'STREAM_ACTIVE', error: null });

    expect(screen.getByRole('status')).toHaveClass('absolute');
  });
});

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
import userEvent from '@testing-library/user-event';
import { ScannerViewfinder } from './ScannerViewfinder';
import type { ScannerCameraControls } from '../useScanner';

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

/**
 * The camera's own hardware controls (issue #135): a torch, because inventory lives in garages and
 * under-stair cupboards, and a camera picker, because a phone's default rear lens is often the
 * ultra-wide that cannot focus at barcode-reading distance. The rule worth pinning is that a
 * control never appears where the hardware can't honour it — a dead switch is worse than none.
 */
describe('ScannerViewfinder — camera controls', () => {
  function controls(overrides: Partial<ScannerCameraControls> = {}): ScannerCameraControls {
    return {
      torch: { supported: false, on: false, toggle: vi.fn() },
      cameras: [],
      activeCameraId: null,
      ...overrides,
    };
  }

  const live = { status: 'STREAM_ACTIVE', error: null } as const;

  it('shows nothing at all when the camera offers neither', () => {
    renderViewfinder({ ...live, camera: controls(), onSelectCamera: vi.fn() });

    expect(screen.queryByTestId('scanner-camera-controls')).not.toBeInTheDocument();
  });

  it('shows nothing when no camera controls were wired at all (the pre-#135 viewfinder)', () => {
    renderViewfinder(live);

    expect(screen.queryByTestId('scanner-camera-controls')).not.toBeInTheDocument();
  });

  it('offers the torch as a pressable toggle where the camera has one', async () => {
    const toggle = vi.fn();
    renderViewfinder({ ...live, camera: controls({ torch: { supported: true, on: false, toggle } }) });

    const button = screen.getByRole('button', { name: 'Turn the torch on' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(button);
    expect(toggle).toHaveBeenCalled();
  });

  it('names and marks the torch by its current state, not by its glyph alone', () => {
    // The icon swap is invisible to a screen reader, so the label and pressed state carry it.
    renderViewfinder({
      ...live,
      camera: controls({ torch: { supported: true, on: true, toggle: vi.fn() } }),
    });

    expect(screen.getByRole('button', { name: 'Turn the torch off' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('hides the controls while the camera is not live', () => {
    renderViewfinder({
      status: 'REQUESTING_PERMISSIONS',
      error: null,
      camera: controls({ torch: { supported: true, on: false, toggle: vi.fn() } }),
    });

    expect(screen.queryByTestId('scanner-camera-controls')).not.toBeInTheDocument();
  });

  it('offers no camera picker for a device with only one camera', () => {
    renderViewfinder({
      ...live,
      camera: controls({ cameras: [{ deviceId: 'cam-1', label: 'Back Camera' }] }),
      onSelectCamera: vi.fn(),
    });

    expect(screen.queryByTestId('scanner-camera-menu')).not.toBeInTheDocument();
  });

  it('lets the user pick a camera, marking the one actually streaming', async () => {
    const onSelectCamera = vi.fn();
    renderViewfinder({
      ...live,
      camera: controls({
        cameras: [
          { deviceId: 'cam-wide', label: 'Back Ultra Wide Camera' },
          { deviceId: 'cam-main', label: '' },
        ],
        activeCameraId: 'cam-wide',
      }),
      onSelectCamera,
    });

    await userEvent.click(screen.getByTestId('scanner-camera-menu'));
    const chosen = screen.getByRole('menuitemradio', { name: 'Back Ultra Wide Camera' });
    expect(chosen).toHaveAttribute('aria-checked', 'true');
    // An unnamed camera is still distinguishable — browsers withhold labels in some situations.
    const other = screen.getByRole('menuitemradio', { name: 'Camera 2' });
    expect(other).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(other);
    expect(onSelectCamera).toHaveBeenCalledWith('cam-main');
  });
});

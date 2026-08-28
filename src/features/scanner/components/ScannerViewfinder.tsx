import { Button, LiveRegion, Menu, MenuAction, Surface, Tooltip } from '@/components/foundry';
import { CameraOffIcon, SwitchCameraIcon, TorchIcon, TorchOffIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import type { CameraOption } from '../camera-devices';
import type { ScannerStatus } from '../scanner-machine';
import type { ScannerCameraControls } from '../useScanner';

/**
 * The shared in-frame chrome for both camera surfaces — the full {@link ScannerOverlay} and the
 * focused {@link BarcodeScanDialog} — so the framing reticle, the live "Scanning…" activity
 * feedback, and the permission/error states stay identical across the two (issue #58). Rendered
 * as an overlay sibling of the caller's own `<video>` element (which keeps the ref), it covers
 * every camera state *except* the caller-specific result cards.
 *
 * Two things it exists to fix (issue #58):
 *  - **The reticle is large** — it frames roughly the middle of the view rather than a small
 *    central box, so a barcode can be held close enough to fill the frame (more pixels per bar =
 *    a far better read on a low-quality camera) instead of far back to fit a tiny window. The
 *    reticle is only a *guide*: the decoder reads the whole frame regardless of where the code sits.
 *  - **The scanner shows it is working** — an animated sweep line plus a "Scanning…" status make
 *    it obvious the camera is live and actively looking, so a not-yet-read code never reads as a
 *    frozen, dead screen. The status text carries the same meaning without the motion (and the
 *    reduced-motion catch-all stills the sweep), keeping the feedback accessible.
 *
 * It also carries the camera's own hardware controls (issue #135) — the **torch**, and the
 * **camera picker** where the device has more than one. Both sit under the reticle in the same
 * centred stack as the status text, so they are within thumb reach on a phone and can't collide
 * with the caller-specific cards along the bottom edge or the NFC indicator along the top. Each is
 * rendered only when the live camera actually offers it, so a control is never a dead switch.
 */
export function ScannerViewfinder({
  status,
  hint,
  hintTestId,
  error,
  onRetry,
  reticleRef,
  camera,
  onSelectCamera,
}: {
  status: ScannerStatus;
  /** The directional guidance shown under the reticle ("Point at …"). */
  hint: string;
  /** Test id for the directional hint (each surface keeps its own). */
  hintTestId?: string;
  /** The failure reason to show in the error card when `status === 'ERROR_STATE'`. */
  error: string | null;
  /** Re-request the camera from the error card. */
  onRetry: () => void;
  /**
   * Ref to the framing-reticle box (issue #59): the decoder crops each frame to it, so a barcode
   * framed in the box is large relative to the analysed pixels. Attached to the reticle only while
   * the stream is live (the only time it is shown and the decoder runs).
   */
  reticleRef?: React.Ref<HTMLDivElement>;
  /**
   * The live camera's hardware controls, as {@link useScanner} reports them (issue #135). Omitted
   * (or with nothing supported) renders no controls at all — the pre-#135 viewfinder.
   */
  camera?: ScannerCameraControls;
  /** Remember and open a different camera. Omitted hides the picker even where several exist. */
  onSelectCamera?: (deviceId: string) => void;
}) {
  const t = useT();
  const torch = camera?.torch;
  // Only worth a picker when there is something to pick *between* — a device with one camera gets
  // no control, which is every laptop and most tablets.
  const pickableCameras = camera && onSelectCamera && camera.cameras.length > 1 ? camera.cameras : null;

  return (
    <>
      {status === 'STREAM_ACTIVE' ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4">
          {/* The framing reticle. `overflow-hidden` clips the sweep line at its edges; the huge
              spread shadow dims everything outside it (box-shadow is not clipped by overflow). The
              decoder crops each frame to this box's on-screen rectangle (issue #59). */}
          <div
            ref={reticleRef}
            className="relative size-[min(28rem,80vmin)] overflow-hidden rounded-3xl border-2 border-white/70 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]"
          >
            {/* A full-height track that translates by its own height, carrying the 2px bar at its
                top edge — so the sweep animates on `transform` rather than on `top`. See the
                `gubbins-scanline` keyframe. */}
            <div className="animate-scanline absolute inset-0" aria-hidden>
              <div className="absolute inset-x-0 top-0 h-0.5 -translate-y-1/2 bg-gradient-to-r from-transparent via-primary to-transparent" />
            </div>
          </div>
          {/* Live status + guidance. "Scanning…" is the plain answer to "is anything happening?";
              the hint says what to point at. */}
          <div className="flex flex-col items-center gap-1 px-6 text-center" data-testid="scanner-status">
            <span className="inline-flex items-center gap-2 text-sm font-medium text-white">
              <span className="size-2 animate-pulse rounded-full bg-primary" aria-hidden />
              Scanning…
            </span>
            <p className="text-sm text-white/85" data-testid={hintTestId}>
              {hint}
            </p>
          </div>

          {/* The camera's own controls (issue #135). `pointer-events-auto` re-enables clicks the
              surrounding guide layer switches off, so the reticle stays click-through. */}
          {torch?.supported || pickableCameras ? (
            <div
              className="pointer-events-auto flex items-center gap-2"
              data-testid="scanner-camera-controls"
            >
              {torch?.supported ? (
                <Tooltip content={t('scanner.torch.tooltip')} triggerTabIndex={-1}>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={torch.toggle}
                    aria-pressed={torch.on}
                    aria-label={t(torch.on ? 'scanner.torch.turnOff' : 'scanner.torch.turnOn')}
                    className="bg-white/10 text-white backdrop-blur hover:bg-white/20"
                    data-testid="scanner-torch-toggle"
                  >
                    {torch.on ? <TorchIcon /> : <TorchOffIcon />}
                  </Button>
                </Tooltip>
              ) : null}
              {pickableCameras ? (
                <Menu
                  label={t('scanner.camera.menuLabel')}
                  trigger={<SwitchCameraIcon />}
                  triggerVariant="ghost"
                  triggerSize="icon"
                  triggerClassName="bg-white/10 text-white backdrop-blur hover:bg-white/20"
                  triggerProps={{ 'data-testid': 'scanner-camera-menu' }}
                >
                  {pickableCameras.map((option, index) => (
                    <MenuAction
                      key={option.deviceId}
                      selectionRole="radio"
                      selected={option.deviceId === camera?.activeCameraId}
                      onSelect={() => onSelectCamera?.(option.deviceId)}
                    >
                      {cameraLabel(option, index, t)}
                    </MenuAction>
                  ))}
                </Menu>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {status === 'ERROR_STATE' ? (
        <div className="absolute inset-0 grid place-items-center p-6">
          <Surface className="max-w-sm space-y-3 p-6 text-center text-foreground">
            <CameraOffIcon className="mx-auto size-8 text-muted-foreground" aria-hidden />
            {/* The camera failing is the one thing a screen-reader user cannot see for
                themselves — the viewfinder looks identical either way. `role="alert"` is
                announced on insertion, so entering ERROR_STATE reads the reason out rather
                than leaving the user pointing a dead camera at a code. */}
            <p role="alert" className="text-sm">
              {error}
            </p>
            <Button onClick={onRetry}>Try the camera again</Button>
          </Surface>
        </div>
      ) : null}

      {/* The permission wait, announced as well as drawn. The region is **always mounted** and
          only its text changes — a live region inserted at the moment its message appears is
          frequently not announced at all (see {@link LiveRegion}), which is exactly the trap a
          conditionally-rendered `role="status"` would fall into here. It stays absolutely
          positioned so the empty region is out of flow and never shifts the centred video. */}
      <LiveRegion className="absolute text-sm text-white/80">
        {status === 'REQUESTING_PERMISSIONS' ? 'Requesting camera access…' : null}
      </LiveRegion>
    </>
  );
}

/**
 * What a camera row is called. Browsers only populate `label` once camera permission has been
 * granted, so an unnamed camera falls back to its position in the device's own list — "Camera 2"
 * still distinguishes it, where a blank row would not.
 */
function cameraLabel(option: CameraOption, index: number, t: ReturnType<typeof useT>): string {
  return option.label === '' ? t('scanner.camera.unnamed', { vars: { position: index + 1 } }) : option.label;
}

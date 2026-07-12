import { Button, Surface } from '@/components/foundry';
import { CameraOffIcon } from '@/components/icons';
import type { ScannerStatus } from '../scanner-machine';

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
 */
export function ScannerViewfinder({
  status,
  hint,
  hintTestId,
  error,
  onRetry,
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
}) {
  return (
    <>
      {status === 'STREAM_ACTIVE' ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4">
          {/* The framing reticle. `overflow-hidden` clips the sweep line at its edges; the huge
              spread shadow dims everything outside it (box-shadow is not clipped by overflow). */}
          <div className="relative size-[min(28rem,80vmin)] overflow-hidden rounded-3xl border-2 border-white/70 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]">
            <div
              className="animate-scanline absolute inset-x-0 h-0.5 -translate-y-1/2 bg-gradient-to-r from-transparent via-primary to-transparent"
              aria-hidden
            />
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
        </div>
      ) : null}

      {status === 'ERROR_STATE' ? (
        <div className="absolute inset-0 grid place-items-center p-6">
          <Surface className="max-w-sm space-y-3 p-6 text-center text-foreground">
            <CameraOffIcon className="mx-auto size-8 text-muted-foreground" aria-hidden />
            <p className="text-sm">{error}</p>
            <Button onClick={onRetry}>Try the camera again</Button>
          </Surface>
        </div>
      ) : null}

      {status === 'REQUESTING_PERMISSIONS' ? (
        <p className="absolute text-sm text-white/80">Requesting camera access…</p>
      ) : null}
    </>
  );
}

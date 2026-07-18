/**
 * Best-effort camera-track tuning for the live scanner (issue #59).
 *
 * `getUserMedia` gives us a stream, but the *track* exposes extra, camera-specific controls the
 * initial constraints can't request — chiefly **continuous autofocus**. A barcode held at reading
 * distance on a fixed-focus or manually-focused camera comes through soft, and a soft frame is one
 * of the most common reasons a clear, well-framed code simply "won't scan". Where the camera
 * supports it, switching it to continuous autofocus keeps the code sharp as the user moves it.
 *
 * These controls are **non-standard and unevenly implemented** (they are not in `lib.dom`), so the
 * whole path is feature-detected against the track's advertised capabilities and every call is
 * guarded: a camera that can't honour a request ignores it, and nothing here ever throws or blocks
 * the scan. {@link pickFocusConstraints} is the pure capability→constraint decision, unit-testable
 * without a real camera; {@link applyScannerTrackConstraints} does the guarded DOM apply.
 */

/** The slice of a track's capabilities we probe (all optional; none modelled by `lib.dom`). */
interface ScannerTrackCapabilities {
  readonly focusMode?: readonly string[];
}

/** The advanced constraint set we may apply (non-standard keys, hence the local shape). */
export interface ScannerAdvancedConstraint {
  readonly focusMode?: string;
}

/**
 * Decide which advanced track constraints to apply from a camera's advertised capabilities: ask
 * for `continuous` focus only when the track lists it as supported. Returns an empty list when the
 * camera advertises nothing useful (or no capabilities at all), so the caller applies nothing.
 * Pure — no DOM, fully unit-testable.
 *
 * @internal Exported for unit tests only.
 */
export function pickFocusConstraints(
  capabilities: ScannerTrackCapabilities | null | undefined,
): ScannerAdvancedConstraint[] {
  const advanced: ScannerAdvancedConstraint[] = [];
  if (capabilities?.focusMode?.includes('continuous')) {
    advanced.push({ focusMode: 'continuous' });
  }
  return advanced;
}

/** The minimal slice of `MediaStreamTrack` this helper drives (capabilities are not in `lib.dom`). */
interface ScannerTrackLike {
  getCapabilities?: () => ScannerTrackCapabilities;
  applyConstraints?: (constraints: { advanced: ScannerAdvancedConstraint[] }) => Promise<void>;
}

/**
 * Apply the best-effort scanner tuning to every video track of a stream: continuous autofocus
 * where the camera supports it (issue #59). Fully guarded and fire-and-forget — a track without
 * `getCapabilities`/`applyConstraints`, a camera that advertises nothing useful, or a rejected
 * apply all resolve quietly, so this only ever improves a scan and never disrupts one.
 */
export async function applyScannerTrackConstraints(stream: MediaStream): Promise<void> {
  const tracks = stream.getVideoTracks?.() ?? [];
  await Promise.all(
    tracks.map(async (track) => {
      const t = track as unknown as ScannerTrackLike;
      if (typeof t.getCapabilities !== 'function' || typeof t.applyConstraints !== 'function') return;
      let advanced: ScannerAdvancedConstraint[];
      try {
        advanced = pickFocusConstraints(t.getCapabilities());
      } catch {
        return; // getCapabilities can throw on some platforms — treat as "no tuning available"
      }
      if (advanced.length === 0) return;
      try {
        await t.applyConstraints({ advanced });
      } catch {
        // The camera declined the request (unsupported/busy) — the scan continues unchanged.
      }
    }),
  );
}

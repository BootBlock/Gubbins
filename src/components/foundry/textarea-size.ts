/**
 * The remembered heights of text boxes the user has dragged bigger (issue #615).
 *
 * A {@link Textarea} given a `sizeKey` records the height its resize handle was last
 * dragged to, so the box reopens at the size that suited the user's content instead of
 * snapping back to a three-line default every time.
 *
 * Two rules shape the design:
 *
 *  1. **Only a genuine user resize is stored.** A box the user never touched has no entry
 *     at all, so it keeps following whatever the app's default size happens to be — and a
 *     future change to that default reaches everyone who never overrode it. Shrinking a box
 *     back to its default size *removes* the entry rather than pinning today's default.
 *  2. **One key holds every box.** Heights are device-local UI trivia, so they share a
 *     single registered `gubbins:` key (see `lib/storage-keys.ts`) rather than one key per
 *     control — which would leave the registry unable to name them and the Danger Zone
 *     unable to clear them.
 *
 * Reads and writes are guarded: a private-mode or quota-refused `localStorage` degrades to
 * "sizes don't persist", never to a thrown error in a render path.
 */
import { TEXTAREA_SIZES_KEY } from '@/lib/storage-keys';

/**
 * Bounds a stored height is clamped to. A corrupt or hand-edited value must never be able
 * to collapse a box to nothing or stretch it past any plausible screen.
 */
const MIN_HEIGHT_PX = 24;
const MAX_HEIGHT_PX = 4000;

/** Every remembered height, keyed by `sizeKey`. */
type RememberedHeights = Record<string, number>;

/**
 * The height last stored for `key`, or `null` when the box has never been resized (or the
 * stored value was unusable). Already clamped to the bounds above.
 */
export function readRememberedHeight(key: string): number | null {
  const height = readAll()[key];
  return typeof height === 'number' ? clamp(height) : null;
}

/** Record `key`'s new height. */
export function rememberHeight(key: string, height: number): void {
  if (!Number.isFinite(height)) return;
  const heights = readAll();
  heights[key] = clamp(height);
  writeAll(heights);
}

/** Drop `key`'s entry, so the box goes back to following the app's default size. */
export function forgetHeight(key: string): void {
  const heights = readAll();
  if (!(key in heights)) return;
  delete heights[key];
  writeAll(heights);
}

/**
 * The whole stored map.
 *
 * @internal Exported for unit tests only.
 */
export function readRememberedHeights(): RememberedHeights {
  return readAll();
}

function clamp(height: number): number {
  return Math.round(Math.min(Math.max(height, MIN_HEIGHT_PX), MAX_HEIGHT_PX));
}

function readAll(): RememberedHeights {
  try {
    const raw = localStorage.getItem(TEXTAREA_SIZES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const heights: RememberedHeights = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) heights[key] = value;
    }
    return heights;
  } catch {
    // Malformed value or storage unavailable — behave as though nothing was remembered.
    return {};
  }
}

function writeAll(heights: RememberedHeights): void {
  try {
    if (Object.keys(heights).length === 0) {
      localStorage.removeItem(TEXTAREA_SIZES_KEY);
      return;
    }
    localStorage.setItem(TEXTAREA_SIZES_KEY, JSON.stringify(heights));
  } catch {
    // Storage full / unavailable (private mode) — the size simply won't persist.
  }
}

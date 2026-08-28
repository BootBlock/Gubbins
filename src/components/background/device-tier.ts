/**
 * device-tier — how much fill rate the weather layer may spend on this device (issue #419).
 *
 * The engine renders into a backing store of `cssSize × devicePixelRatio`, and every clear, blit
 * and sprite draw pays for every one of those pixels. A budget phone reports a DPR of 2.6–3 with a
 * GPU that is a fraction of a desktop's, so it is asked for six to nine times the fill of a 1×
 * display to paint a decoration nobody is looking closely at. Capping the ratio is the one lever
 * that scales the *whole* frame — clear, mound blit, haze stretch and every `drawImage` alike —
 * rather than trimming one draw call.
 *
 * There is no media feature that asks "how fast is this GPU", so the answer is assembled from the
 * three hints browsers do expose. Each is a proxy, none is authoritative, and two of the three are
 * Chromium-only — which is why the fallback is the engine's existing cap rather than a low one: an
 * absent hint must never quietly downgrade a device that is in fact capable.
 *
 * Pure and injectable so the thresholds are testable without a browser; {@link readDeviceTier}
 * reads the real globals.
 */

/** The hints {@link precipDprCap} reasons over. Every field is optional — none is universal. */
export interface DeviceTierHints {
  /** `navigator.hardwareConcurrency` — logical CPU cores. Widely supported. */
  readonly cores?: number;
  /** `navigator.deviceMemory` — GiB of RAM, quantised to 0.25/0.5/1/2/4/8. Chromium only. */
  readonly memory?: number;
  /** `navigator.connection.saveData` — the user asked for less data/work. Chromium only. */
  readonly saveData?: boolean;
  /** `matchMedia('(pointer: coarse)')` — a touch device, so likely a phone or tablet. */
  readonly coarsePointer?: boolean;
}

/** The engine's own default cap, applied when nothing suggests the device needs help. */
export const DEFAULT_DPR_CAP = 2;

/** The cap for a device the hints call weak — still above 1, so the field keeps its soft edges. */
export const REDUCED_DPR_CAP = 1.5;

/**
 * Choose the device-pixel-ratio cap for the weather layer's backing store.
 *
 * Any *one* of the weak signals is enough. They are deliberately not scored together: a phone that
 * reports 8 cores and 8 GiB is still a phone, and `saveData` is an explicit request rather than a
 * measurement, so requiring agreement would let the common cases through. The thresholds are the
 * conventional "low-end" lines — ≤4 cores, ≤4 GiB — and both hints are absent on a device that
 * cannot answer, which correctly leaves it at the default.
 *
 * Note this only bounds the ratio: a 1×-DPR device is unaffected either way, and a capable 3×
 * desktop display still renders at 2×.
 */
export function precipDprCap(hints: DeviceTierHints): number {
  const weak =
    hints.saveData === true ||
    hints.coarsePointer === true ||
    (typeof hints.cores === 'number' && hints.cores <= 4) ||
    (typeof hints.memory === 'number' && hints.memory <= 4);
  return weak ? REDUCED_DPR_CAP : DEFAULT_DPR_CAP;
}

/** Read the hints {@link precipDprCap} wants from the live environment. Safe outside a browser. */
export function readDeviceTier(): DeviceTierHints {
  if (typeof navigator === 'undefined') return {};
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  return {
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    memory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    saveData: nav.connection?.saveData === true,
    coarsePointer: typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : undefined,
  };
}

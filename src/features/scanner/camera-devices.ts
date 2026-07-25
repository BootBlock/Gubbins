/**
 * Which camera the live scanner opens (issue #135).
 *
 * `getUserMedia({ facingMode: 'environment' })` asks for "a rear camera" and lets the browser
 * choose. On a phone with several rear lenses that choice is frequently the **ultra-wide**, which
 * cannot focus at the distance a barcode is held at — so a perfectly clear code simply never comes
 * into focus. The fix is to let the user pick the lens themselves and remember it, which needs two
 * things: the list of video inputs, and constraints that name one.
 *
 * Both pure decisions live here so they are unit-testable without a camera:
 * {@link toCameraOptions} turns a raw `enumerateDevices()` list into the pickable choices, and
 * {@link buildVideoConstraints} turns a chosen `deviceId` (or none) into the video constraints.
 * {@link listCameras} is the thin guarded DOM read around the former.
 *
 * Note the ordering the browser gives us is kept as-is: labels are platform-worded ("Back Camera",
 * "camera2 0, facing back") and there is no reliable, locale-independent way to rank them, so the
 * user picks by name rather than being second-guessed.
 */

/** A camera the user can choose between in the scanner's camera menu. */
export interface CameraOption {
  /** The `deviceId` to request. Stable per origin for as long as camera permission is granted. */
  readonly deviceId: string;
  /**
   * The platform's own name for the camera ("Back Camera"). Empty where the browser withholds
   * it — labels are only populated once camera permission has been granted, so the caller
   * supplies a positional fallback rather than showing a blank row.
   */
  readonly label: string;
}

/**
 * The pickable cameras from a raw `enumerateDevices()` list: video inputs only, de-duplicated,
 * and without the blank-`deviceId` placeholder a browser lists before permission is granted (it
 * cannot be requested, so it is no use as a choice). Order is the platform's own.
 *
 * Pure — no DOM, fully unit-testable.
 */
export function toCameraOptions(devices: readonly MediaDeviceInfo[] | null | undefined): CameraOption[] {
  const seen = new Set<string>();
  const options: CameraOption[] = [];
  for (const device of devices ?? []) {
    if (device?.kind !== 'videoinput') continue;
    const deviceId = device.deviceId ?? '';
    if (deviceId === '' || seen.has(deviceId)) continue;
    seen.add(deviceId);
    options.push({ deviceId, label: (device.label ?? '').trim() });
  }
  return options;
}

/**
 * The video constraints for a scanner stream: the named camera when the user has chosen one, else
 * "a rear camera" for the browser to pick (the first-run default).
 *
 * The resolution ask rides along either way. It is deliberately `ideal`, never required: more
 * pixels per bar reads far better than the browser's low default, but a camera that cannot manage
 * it must still open (issue #58).
 *
 * Pure — no DOM, fully unit-testable.
 */
export function buildVideoConstraints(deviceId: string | null | undefined): MediaTrackConstraints {
  const resolution = { width: { ideal: 1920 }, height: { ideal: 1080 } } as const;
  return deviceId
    ? { deviceId: { exact: deviceId }, ...resolution }
    : { facingMode: 'environment', ...resolution };
}

/**
 * The cameras this device offers, or an empty list where enumeration is unavailable or fails.
 * Guarded and never throws — a browser without `enumerateDevices` simply offers no picker, and
 * scanning carries on with whichever camera the stream opened.
 *
 * Call this only *after* a stream has been granted: before that, browsers withhold device labels
 * (and often the ids too) to avoid fingerprinting, so the list would be unlabelled and unpickable.
 */
export async function listCameras(): Promise<CameraOption[]> {
  const devices = navigator.mediaDevices;
  if (typeof devices?.enumerateDevices !== 'function') return [];
  try {
    return toCameraOptions(await devices.enumerateDevices());
  } catch {
    return [];
  }
}

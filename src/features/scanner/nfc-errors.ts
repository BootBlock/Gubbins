/**
 * Friendly, user-facing messages for the `DOMException`s the Web NFC API rejects with
 * (issue #71). The raw names (`NotAllowedError`, `NetworkError`, …) are meaningless to a
 * user, so both the read and write hooks map them here to plain, actionable copy. Pure and
 * unit-testable; no DOM access.
 */

/** Map a caught NFC error to a short, plain-language sentence. `AbortError` is caller-handled. */
export function nfcErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
      // Permission denied, or NFC turned off in the OS.
      return 'NFC permission was denied, or NFC is switched off on your device.';
    case 'NotSupportedError':
      return 'This device can’t use NFC tags.';
    case 'NotReadableError':
      return 'Couldn’t reach the NFC hardware. Make sure NFC is on and try again.';
    case 'NetworkError':
      return 'The tag moved away too soon. Hold it flat against the phone until it’s done.';
    default:
      return 'Something went wrong with the NFC tag. Try again.';
  }
}

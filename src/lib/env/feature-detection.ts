/**
 * Centralised browser-capability detection.
 *
 * The specification mandates strict feature-detection guards before touching any
 * optional platform API (e.g. `if ('wakeLock' in navigator)`), gracefully
 * degrading rather than throwing unhandled promise rejections that would crash
 * the application (§3, §2.2.7, §6.1). Every capability check lives here so call
 * sites stay declarative and we never scatter ad-hoc `in` probes across the code.
 *
 * All checks are written defensively with `in` / `typeof` probes so they remain
 * safe even where the TypeScript DOM lib does not yet model the API (e.g. the
 * Barcode Detection API used later in Phase 6).
 */

/** True when the document is cross-origin isolated, i.e. `SharedArrayBuffer` is permitted (§2.2.6). */
export function hasCrossOriginIsolation(): boolean {
  return typeof globalThis !== 'undefined' && globalThis.crossOriginIsolated === true;
}

/** True when `SharedArrayBuffer` is available — needed by the primary SQLite OPFS VFS (§2.2.6). */
export function hasSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== 'undefined';
}

/** True when the Origin Private File System is reachable — where the database lives (§2.2.1). */
export function hasOpfs(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    typeof navigator.storage?.getDirectory === 'function'
  );
}

/** True when the StorageManager exposes an explicit persistence request (§2 storage safeguards). */
export function hasStoragePersist(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    typeof navigator.storage?.persist === 'function'
  );
}

/** True when the StorageManager can report a quota estimate (§7.4, §7.6 telemetry). */
export function hasStorageEstimate(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    typeof navigator.storage?.estimate === 'function'
  );
}

/** True when the Web Locks API is available — preferred multi-tab guard mechanism (§2.2.7). */
export function hasWebLocks(): boolean {
  return typeof navigator !== 'undefined' && 'locks' in navigator;
}

/** True when the Screen Wake Lock API is available — kiosk/dashboard ergonomics (§3, §6.1). */
export function hasWakeLock(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

/** True when the File System Access API is available — desktop datasheet pointers & backups (§2, §4). */
export function hasFileSystemAccess(): boolean {
  return typeof globalThis !== 'undefined' && 'showSaveFilePicker' in globalThis;
}

/**
 * True when local OS notifications can be shown — the Notification API **and** a service
 * worker are both present (G3 reminders; notifications are shown via the SW registration).
 * Absent on iOS Safari's non-installed browser, so callers degrade to in-app only (§3, §6.1).
 */
export function hasNotifications(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator
  );
}

/**
 * True when the Periodic Background Sync API is present — lets the service worker wake
 * periodically to re-check reminders (G3, best-effort). Chromium-installed-PWA only; where
 * absent, reminders are foreground-only. Never gate correctness on this — it is advisory.
 */
export function hasPeriodicSync(): boolean {
  return (
    typeof window !== 'undefined' &&
    'ServiceWorkerRegistration' in window &&
    'periodicSync' in ServiceWorkerRegistration.prototype
  );
}

/** True when the native Barcode Detection API is available — primary scanner engine (§6.6). */
export function hasBarcodeDetector(): boolean {
  return typeof globalThis !== 'undefined' && 'BarcodeDetector' in globalThis;
}

/**
 * True when the Web NFC API (`NDEFReader`) is available — tap-to-scan and writing item
 * deep-links to NFC tags (issue #71). Chromium-on-Android only (Chrome/Samsung Internet/
 * Opera Mobile) and secure-context only; absent everywhere else (desktop, iOS, Firefox),
 * where the NFC affordances simply don't appear. Never gate correctness on this — it is a
 * progressive enhancement alongside the camera scanner.
 */
export function hasNfc(): boolean {
  return typeof globalThis !== 'undefined' && 'NDEFReader' in globalThis;
}

/**
 * True when on-device OCR can run — a `Worker` to host the Tesseract WASM engine and
 * `WebAssembly` itself (feature-gap G2). Absent → the opt-in receipt/label scanner degrades
 * to hidden, never a throw. The engine + language model are lazily fetched from our own
 * origin, so no CDN/key is required.
 */
export function hasOcr(): boolean {
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
}

/**
 * Best-effort mobile heuristic, used only for UX nudges (e.g. the mobile storage
 * eviction warning of §2). Never gate data-integrity logic on this — it is advisory.
 */
export function isLikelyMobile(): boolean {
  if (typeof navigator === 'undefined') return false;

  // Prefer the modern, privacy-preserving signal where present.
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof uaData?.mobile === 'boolean') return uaData.mobile;

  // Fall back to a coarse-pointer + no-hover media query (touch-first devices).
  if (typeof matchMedia === 'function') {
    return matchMedia('(pointer: coarse) and (hover: none)').matches;
  }

  return false;
}

/**
 * The non-negotiable platform requirements for Gubbins to run at all. If any of
 * these are missing the application cannot mount its database and must show a
 * blocking, explanatory screen rather than crashing (§2.2.6, §3).
 */
export interface CriticalSupportResult {
  readonly supported: boolean;
  readonly missing: readonly string[];
}

/**
 * The one thing Gubbins genuinely cannot run without: somewhere to keep the database.
 *
 * Cross-origin isolation used to be listed here too, because the primary SQLite VFS needs it.
 * It is no longer *critical* (issue #255) — without it the worker opens the database on the
 * `opfs-sahpool` VFS instead, which needs neither COOP/COEP nor `SharedArrayBuffer` — so an
 * un-isolated browser gets a working app rather than a blocking screen. See
 * {@link checkIsolationSupport} for what isolation still buys.
 */
export function checkCriticalSupport(): CriticalSupportResult {
  const missing: string[] = [];
  if (!hasOpfs()) missing.push('Origin Private File System (OPFS)');
  return { supported: missing.length === 0, missing };
}

/**
 * Whether this document can run the **primary** OPFS VFS (§2.2.6) — preferred, not required.
 *
 * Its absence is not a failure: it decides which VFS the database opens on, and on a first
 * visit it is merely the header-injecting service worker not having taken control yet. The
 * boot gate uses it to tell those two apart before committing an origin to the fallback.
 */
export function checkIsolationSupport(): CriticalSupportResult {
  const missing: string[] = [];
  if (!hasCrossOriginIsolation()) missing.push('Cross-Origin Isolation (COOP/COEP)');
  if (!hasSharedArrayBuffer()) missing.push('SharedArrayBuffer');
  return { supported: missing.length === 0, missing };
}

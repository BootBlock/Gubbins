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

/** True when `SharedArrayBuffer` is available — required by the synchronous SQLite OPFS VFS (§2.2.6). */
export function hasSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== 'undefined';
}

/** True when the Origin Private File System is reachable — the mandated primary VFS (§2.2.1). */
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

/** True when BroadcastChannel is available — fallback multi-tab guard / cross-tab messaging (§2.2.7). */
export function hasBroadcastChannel(): boolean {
  return typeof globalThis !== 'undefined' && 'BroadcastChannel' in globalThis;
}

/** True when the Screen Wake Lock API is available — kiosk/dashboard ergonomics (§3, §6.1). */
export function hasWakeLock(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

/** True when the File System Access API is available — desktop datasheet pointers & backups (§2, §4). */
export function hasFileSystemAccess(): boolean {
  return typeof globalThis !== 'undefined' && 'showSaveFilePicker' in globalThis;
}

/** True when the native Barcode Detection API is available — primary scanner engine (§6.6). */
export function hasBarcodeDetector(): boolean {
  return typeof globalThis !== 'undefined' && 'BarcodeDetector' in globalThis;
}

/** True when haptic feedback is available — scanner confirmation (§6.5). */
export function hasVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
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
 * Aggregate snapshot of the platform capabilities Gubbins cares about. Useful for
 * diagnostics surfaces (e.g. the Safe Mode screen of §3) and for one-shot reads in
 * React without re-probing individual APIs.
 */
export interface PlatformCapabilities {
  readonly crossOriginIsolated: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly opfs: boolean;
  readonly storagePersist: boolean;
  readonly storageEstimate: boolean;
  readonly webLocks: boolean;
  readonly broadcastChannel: boolean;
  readonly wakeLock: boolean;
  readonly fileSystemAccess: boolean;
  readonly barcodeDetector: boolean;
  readonly vibrate: boolean;
  readonly likelyMobile: boolean;
}

/** Snapshot every capability in one call. */
export function detectCapabilities(): PlatformCapabilities {
  return {
    crossOriginIsolated: hasCrossOriginIsolation(),
    sharedArrayBuffer: hasSharedArrayBuffer(),
    opfs: hasOpfs(),
    storagePersist: hasStoragePersist(),
    storageEstimate: hasStorageEstimate(),
    webLocks: hasWebLocks(),
    broadcastChannel: hasBroadcastChannel(),
    wakeLock: hasWakeLock(),
    fileSystemAccess: hasFileSystemAccess(),
    barcodeDetector: hasBarcodeDetector(),
    vibrate: hasVibrate(),
    likelyMobile: isLikelyMobile(),
  };
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

export function checkCriticalSupport(): CriticalSupportResult {
  const missing: string[] = [];
  if (!hasCrossOriginIsolation()) missing.push('Cross-Origin Isolation (COOP/COEP)');
  if (!hasSharedArrayBuffer()) missing.push('SharedArrayBuffer');
  if (!hasOpfs()) missing.push('Origin Private File System (OPFS)');
  return { supported: missing.length === 0, missing };
}

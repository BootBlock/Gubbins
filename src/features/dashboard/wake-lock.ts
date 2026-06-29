/**
 * Pure lifecycle decision for the Screen Wake Lock (spec §3 "Kiosk & Tablet Ergonomics").
 *
 * A hardwired dashboard/tablet must stay awake during active monitoring, which the
 * native Screen Wake Lock API provides. The browser automatically *releases* a wake
 * sentinel whenever the page is hidden, so a held lock has to be **re-acquired** once
 * the page becomes visible again — the well-known wake-lock gotcha. This module
 * isolates the "what should we do right now?" decision (acquire / release / nothing)
 * from the DOM glue, so it is exhaustively unit-testable without a real browser. The
 * Wake Lock API itself is reached through an injectable seam in {@link useWakeLock},
 * mirroring the scanner's pure-reducer + DOM-glue split.
 *
 * Every branch is feature-detection-guarded (`supported`), so an unsupported
 * environment (e.g. iOS/Safari) degrades to a no-op rather than throwing an
 * unhandled promise rejection (§3, §6.1).
 */

export type WakeLockAction = 'acquire' | 'release' | 'none';

export interface WakeLockSituation {
  /** The user has opted into kiosk mode (the Tier-2 `kioskMode` preference). */
  readonly enabled: boolean;
  /** The Screen Wake Lock API is present (feature-detected via `hasWakeLock`). */
  readonly supported: boolean;
  /** The document is currently visible (`document.visibilityState === 'visible'`). */
  readonly visible: boolean;
  /** We currently hold a live wake sentinel. */
  readonly held: boolean;
}

/**
 * True when a wake lock *should* be held right now: only when the user opted in, the
 * API exists, and the page is visible (a hidden page can hold no lock).
 */
export function shouldHoldWakeLock(situation: WakeLockSituation): boolean {
  return situation.enabled && situation.supported && situation.visible;
}

/**
 * Reconcile the desired wake-lock state against what we currently hold:
 *  - want a lock but hold none → `'acquire'`
 *  - hold a lock but no longer want one (disabled, unsupported, or hidden) → `'release'`
 *  - already in the desired state → `'none'`
 */
export function wakeLockAction(situation: WakeLockSituation): WakeLockAction {
  const want = shouldHoldWakeLock(situation);
  if (want && !situation.held) return 'acquire';
  if (!want && situation.held) return 'release';
  return 'none';
}

/**
 * The double-scan Cooldown Map (spec §6.4, Phase 6).
 *
 * In Continuous Mode a single physical label lingers in the viewfinder for many
 * frames, so the same code is decoded dozens of times in a row. This map records
 * the last-accepted timestamp per code and rejects a repeat within the cooldown
 * window (default **2000 ms** per §6.4), so one wave of the hand registers once.
 *
 * It is a pure, time-injectable structure (callers pass `now`), so the scanner's
 * accept/ignore decision is fully unit-testable without a real clock or camera.
 */

/** Default debounce window in milliseconds (spec §6.4). */
export const COOLDOWN_WINDOW_MS = 2000;

export class CooldownMap {
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly windowMs: number = COOLDOWN_WINDOW_MS) {}

  /**
   * Decide whether a freshly decoded `code` should be accepted, recording the time
   * when it is. Returns `false` (ignore) if the same code was accepted within the
   * cooldown window; `true` (act on it) otherwise.
   */
  accept(code: string, now: number = Date.now()): boolean {
    const previous = this.lastSeen.get(code);
    if (previous !== undefined && now - previous < this.windowMs) {
      return false;
    }
    this.lastSeen.set(code, now);
    return true;
  }

  /** Drop entries older than the window so the map cannot grow unbounded. */
  prune(now: number = Date.now()): void {
    for (const [code, seen] of this.lastSeen) {
      if (now - seen >= this.windowMs) this.lastSeen.delete(code);
    }
  }

  /** Forget all cooldowns (e.g. when the scanner overlay closes). */
  clear(): void {
    this.lastSeen.clear();
  }
}

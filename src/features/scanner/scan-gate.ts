/**
 * The raw-decode gate that sits in *front* of the scan resolution work (issue #512).
 *
 * The §6.4 {@link CooldownMap} is keyed on a *resolved item id*, so it can only be consulted
 * once the database has already answered. In Continuous Mode the decode loop runs every
 * animation frame, so a label resting in the viewfinder issued one repository round-trip per
 * frame for as long as it was in view — and the scan the cooldown then rejected produced no
 * beep, no haptic and no message, which is exactly what a code that failed to read looks like.
 *
 * This gate is asked about the *raw decoded string* instead, before any lookup, so one wave of
 * the hand costs one read whatever the code turns out to be — item, location, GTIN, printed
 * short code or nothing at all. It also remembers whether the accepted read went on to resolve,
 * because that is what separates the two things silence used to conflate:
 *
 * - a repeat of a code that **did** resolve deserves an "already scanned" acknowledgement;
 * - a repeat of a code that resolved to **nothing** must stay silent, or the tone would claim a
 *   scan that never registered.
 *
 * Like {@link CooldownMap} and the decode cadence it is pure and time-injectable (callers pass
 * `now`), so the accept/repeat/suppress decision is unit-testable without a clock or a camera.
 */
import { COOLDOWN_WINDOW_MS } from './cooldown';

/**
 * What the caller should do with a freshly decoded string.
 *
 * - `accept` — resolve it: this is the first read of this code in the current window.
 * - `repeat` — suppressed, and the first read resolved to something. Acknowledge it.
 * - `suppress` — suppressed, and the first read resolved to nothing. Say nothing.
 */
export type ScanDecision = 'accept' | 'repeat' | 'suppress';

interface GateEntry {
  /** When the read that opened this window was accepted. */
  readonly at: number;
  /** Whether that read went on to resolve to something the user was shown. */
  resolved: boolean;
}

export class ScanGate {
  private readonly seen = new Map<string, GateEntry>();

  private readonly windowMs: number;

  constructor(windowMs: number = COOLDOWN_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Decide what to do with `code`, opening a fresh window when it is accepted. A suppressed
   * repeat deliberately does *not* extend the window, so a label held steadily in view is
   * re-read once per window rather than being locked out for as long as it is held.
   */
  offer(code: string, now: number = Date.now()): ScanDecision {
    // Pruning here is what keeps the map bounded to the codes seen in the last window, however
    // long the overlay stays open.
    this.prune(now);
    const previous = this.seen.get(code);
    if (previous !== undefined && now - previous.at < this.windowMs) {
      return previous.resolved ? 'repeat' : 'suppress';
    }
    this.seen.set(code, { at: now, resolved: false });
    return 'accept';
  }

  /** Record that the accepted read of `code` resolved to something the user was shown. */
  resolved(code: string): void {
    const entry = this.seen.get(code);
    if (entry) entry.resolved = true;
  }

  /**
   * Forget every window, so the next read of any code is treated as fresh. Used when the user
   * deliberately asks for another scan (Discrete "Scan again", or a finished batch), where
   * re-presenting the label still in their hand is the point rather than a stutter.
   */
  clear(): void {
    this.seen.clear();
  }

  /** Drop windows that have already elapsed, so the map cannot grow unbounded. */
  private prune(now: number): void {
    for (const [code, entry] of this.seen) {
      if (now - entry.at >= this.windowMs) this.seen.delete(code);
    }
  }
}

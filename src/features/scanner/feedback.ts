/**
 * Non-visual scan feedback (spec §6.5, §2.4.3 native APIs).
 *
 * Because the user isn't looking at the screen during Continuous Mode, a successful
 * scan is confirmed with a crisp haptic bump (`navigator.vibrate`) and a short
 * synthesised beep via the **native Web Audio API** — no audio library (§2.4.3).
 * Both are feature-detected and fail silently when unsupported (e.g. iOS Safari has
 * no `vibrate`), so they never throw. The AudioContext must be created/resumed from
 * a user gesture to satisfy autoplay policies, so {@link ScanFeedback.prime} is
 * called on the first tap that opens the scanner.
 */

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ??
    null
  );
}

export class ScanFeedback {
  private ctx: AudioContext | null = null;

  /** Lazily create/resume the AudioContext from a user gesture (autoplay policy). */
  prime(): void {
    const Ctor = getAudioContextCtor();
    if (!Ctor) return;
    try {
      this.ctx ??= new Ctor();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  /** A short, premium-sounding confirmation beep (§6.5). No-op without Web Audio. */
  beep(durationMs = 90, frequency = 880): void {
    if (!this.ctx) this.prime();
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      // Quick attack + exponential release so it sounds like a tactile "tick".
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + durationMs / 1000 + 0.02);
    } catch {
      // ignore — feedback is best-effort
    }
  }

  /** Crisp haptic bump (§6.5). No-op where `navigator.vibrate` is unsupported. */
  vibrate(pattern: number | number[] = 200): void {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(pattern);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Fire the enabled confirmations for a successful scan (§6.5). Both default on;
   * a user can mute either independently via the Tier-2 scanner preferences
   * (`scannerBeep` / `scannerHaptics` in `usePreferencesStore`), so the overlay
   * passes the current flags through here.
   */
  confirm({ beep = true, haptics = true }: { beep?: boolean; haptics?: boolean } = {}): void {
    if (beep) this.beep();
    if (haptics) this.vibrate(200);
  }

  /** Release the AudioContext when the scanner closes. */
  dispose(): void {
    try {
      void this.ctx?.close();
    } catch {
      // ignore
    }
    this.ctx = null;
  }
}

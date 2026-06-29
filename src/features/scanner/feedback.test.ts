import { describe, it, expect, vi } from 'vitest';
import { ScanFeedback } from './feedback';

/**
 * §6.5 non-visual scan confirmation gating. The beep + haptic are best-effort and
 * fire on every successful scan by default, but a user can mute either via the
 * Tier-2 scanner preferences — so `confirm` must honour per-call enable flags.
 * We spy on the (browser-only) `beep`/`vibrate` members so the gating is asserted
 * without a real AudioContext or `navigator.vibrate`.
 */
describe('ScanFeedback.confirm — mutable beep/haptic gating (§6.5)', () => {
  function spies() {
    const fb = new ScanFeedback();
    const beep = vi.spyOn(fb, 'beep').mockImplementation(() => {});
    const vibrate = vi.spyOn(fb, 'vibrate').mockImplementation(() => {});
    return { fb, beep, vibrate };
  }

  it('fires both confirmations by default (no options)', () => {
    const { fb, beep, vibrate } = spies();
    fb.confirm();
    expect(beep).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('suppresses the beep when beep is disabled, keeping the haptic', () => {
    const { fb, beep, vibrate } = spies();
    fb.confirm({ beep: false });
    expect(beep).not.toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('suppresses the haptic when haptics is disabled, keeping the beep', () => {
    const { fb, beep, vibrate } = spies();
    fb.confirm({ haptics: false });
    expect(beep).toHaveBeenCalledTimes(1);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('suppresses both when both are disabled', () => {
    const { fb, beep, vibrate } = spies();
    fb.confirm({ beep: false, haptics: false });
    expect(beep).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
  });
});

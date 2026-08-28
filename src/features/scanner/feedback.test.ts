import { describe, it, expect, vi } from 'vitest';
import { ScanFeedback } from './feedback';

/**
 * §6.5 non-visual scan confirmation gating. The beep + haptic are best-effort and
 * fire on every successful scan by default, but a user can mute either via the
 * Tier-2 scanner preferences — so `confirm` must honour per-call enable flags.
 * We spy on the (browser-only) `beep`/`vibrate` members so the gating is asserted
 * without a real AudioContext or `navigator.vibrate`.
 */
function spies() {
  const fb = new ScanFeedback();
  const beep = vi.spyOn(fb, 'beep').mockImplementation(() => {});
  const vibrate = vi.spyOn(fb, 'vibrate').mockImplementation(() => {});
  return { fb, beep, vibrate };
}

describe('ScanFeedback.confirm — mutable beep/haptic gating (§6.5)', () => {
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

/**
 * The acknowledgement for a scan the app deliberately ignored (issue #512). It has to be
 * *audibly different* from a confirmation — a user sweeping a shelf is listening, not looking,
 * and a repeat that sounded like a fresh hit would inflate their count as surely as silence
 * hid it. It answers to the same user-mutable §6.5 flags.
 */
describe('ScanFeedback.repeat — the "already scanned" acknowledgement (issue #512)', () => {
  it('is a lower, shorter tone and a briefer bump than the confirmation', () => {
    // Read both signals off the calls the class actually makes, so retuning *either* tone into
    // the other's territory fails here. The contract is the difference, not either literal.
    const { fb, beep, vibrate } = spies();
    fb.confirm();
    const [confirmDuration, confirmFrequency] = beep.mock.calls[0] as [number, number];
    const [confirmPattern] = vibrate.mock.calls[0] as [number];

    beep.mockClear();
    vibrate.mockClear();
    fb.repeat();
    const [repeatDuration, repeatFrequency] = beep.mock.calls[0] as [number, number];
    const [repeatPattern] = vibrate.mock.calls[0] as [number];

    expect(repeatFrequency).toBeLessThan(confirmFrequency);
    expect(repeatDuration).toBeLessThan(confirmDuration);
    expect(repeatPattern).toBeLessThan(confirmPattern);
  });

  it('honours the same beep/haptic preferences as the confirmation', () => {
    const muted = spies();
    muted.fb.repeat({ beep: false, haptics: false });
    expect(muted.beep).not.toHaveBeenCalled();
    expect(muted.vibrate).not.toHaveBeenCalled();

    const quiet = spies();
    quiet.fb.repeat({ beep: false });
    expect(quiet.beep).not.toHaveBeenCalled();
    expect(quiet.vibrate).toHaveBeenCalledTimes(1);

    const still = spies();
    still.fb.repeat({ haptics: false });
    expect(still.beep).toHaveBeenCalledTimes(1);
    expect(still.vibrate).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import { shouldHoldWakeLock, wakeLockAction, type WakeLockSituation } from './wake-lock';

/** Build a situation with sensible "kiosk active and able to hold" defaults. */
function situation(overrides: Partial<WakeLockSituation> = {}): WakeLockSituation {
  return { enabled: true, supported: true, visible: true, held: false, ...overrides };
}

describe('shouldHoldWakeLock (spec §3 kiosk wake lock)', () => {
  it('wants a lock only when opted in, supported, and visible', () => {
    expect(shouldHoldWakeLock(situation())).toBe(true);
  });

  it('never wants a lock when kiosk mode is off', () => {
    expect(shouldHoldWakeLock(situation({ enabled: false }))).toBe(false);
  });

  it('never wants a lock when the API is unsupported (graceful degradation)', () => {
    expect(shouldHoldWakeLock(situation({ supported: false }))).toBe(false);
  });

  it('never wants a lock while the page is hidden', () => {
    expect(shouldHoldWakeLock(situation({ visible: false }))).toBe(false);
  });
});

describe('wakeLockAction (spec §3 kiosk wake lock)', () => {
  it('acquires when a lock is wanted but not held', () => {
    expect(wakeLockAction(situation({ held: false }))).toBe('acquire');
  });

  it('does nothing when the wanted lock is already held', () => {
    expect(wakeLockAction(situation({ held: true }))).toBe('none');
  });

  it('releases a held lock once kiosk mode is turned off', () => {
    expect(wakeLockAction(situation({ enabled: false, held: true }))).toBe('release');
  });

  it('releases a held lock when the page becomes hidden (re-acquire on return)', () => {
    expect(wakeLockAction(situation({ visible: false, held: true }))).toBe('release');
  });

  it('does nothing when no lock is wanted and none is held', () => {
    expect(wakeLockAction(situation({ enabled: false, held: false }))).toBe('none');
  });

  it('never acquires on an unsupported platform even when held is false', () => {
    expect(wakeLockAction(situation({ supported: false, held: false }))).toBe('none');
  });
});

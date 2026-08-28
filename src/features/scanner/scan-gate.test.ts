import { describe, it, expect } from 'vitest';
import { COOLDOWN_WINDOW_MS } from './cooldown';
import { ScanGate } from './scan-gate';

/**
 * The raw-decode gate (issue #512). It is what stands between a label resting in the viewfinder
 * and one repository round-trip per animation frame, so its window arithmetic and — just as
 * importantly — its three-way decision are pinned here without a clock or a camera.
 *
 * The decision matters because the two things it separates used to look identical to a user
 * sweeping a shelf: a code the app deliberately ignored, and a code it failed to read.
 */
describe('ScanGate — one read per wave of the hand', () => {
  it('accepts the first read of a code', () => {
    const gate = new ScanGate();
    expect(gate.offer('ABC', 0)).toBe('accept');
  });

  it('suppresses every repeat inside the window, so the lookup runs once', () => {
    const gate = new ScanGate();
    expect(gate.offer('ABC', 0)).toBe('accept');
    // The decode loop's per-frame cadence, well inside the 2000 ms window.
    for (const frame of [16, 33, 50, 1999]) {
      expect(gate.offer('ABC', frame)).toBe('suppress');
    }
  });

  it('re-accepts once the window has elapsed', () => {
    const gate = new ScanGate();
    gate.offer('ABC', 0);
    expect(gate.offer('ABC', COOLDOWN_WINDOW_MS)).toBe('accept');
  });

  it('does not let a suppressed repeat extend the window', () => {
    const gate = new ScanGate();
    gate.offer('ABC', 0);
    // A label held steadily in view is decoded throughout; it must still come round again on
    // schedule rather than being locked out for as long as it is held.
    gate.offer('ABC', 1500);
    gate.offer('ABC', 1900);
    expect(gate.offer('ABC', COOLDOWN_WINDOW_MS)).toBe('accept');
  });

  it('gates each code independently', () => {
    const gate = new ScanGate();
    expect(gate.offer('ABC', 0)).toBe('accept');
    expect(gate.offer('DEF', 10)).toBe('accept');
    expect(gate.offer('ABC', 20)).toBe('suppress');
  });

  it('honours a custom window', () => {
    const gate = new ScanGate(500);
    gate.offer('ABC', 0);
    expect(gate.offer('ABC', 499)).toBe('suppress');
    expect(gate.offer('ABC', 500)).toBe('accept');
  });
});

describe('ScanGate — what a repeat is allowed to claim', () => {
  it('reports a repeat once the accepted read resolved, so it can be acknowledged', () => {
    const gate = new ScanGate();
    gate.offer('ABC', 0);
    gate.resolved('ABC');
    expect(gate.offer('ABC', 16)).toBe('repeat');
  });

  it('stays silent for a code that resolved to nothing', () => {
    const gate = new ScanGate();
    gate.offer('ABC', 0);
    // Nothing in the inventory carries it, so `resolved` is never called. A tone here would
    // claim a scan that never registered.
    expect(gate.offer('ABC', 16)).toBe('suppress');
  });

  it('does not carry the resolved flag into the next window', () => {
    const gate = new ScanGate();
    gate.offer('ABC', 0);
    gate.resolved('ABC');
    expect(gate.offer('ABC', COOLDOWN_WINDOW_MS)).toBe('accept');
    // The fresh window starts unresolved: whether this read resolves is decided by this read.
    expect(gate.offer('ABC', COOLDOWN_WINDOW_MS + 16)).toBe('suppress');
  });

  it('ignores `resolved` for a code it is not currently holding', () => {
    const gate = new ScanGate();
    gate.resolved('ABC');
    expect(gate.offer('ABC', 0)).toBe('accept');
  });
});

describe('ScanGate — housekeeping', () => {
  it('re-arms every code when cleared, for a deliberate "scan again"', () => {
    const gate = new ScanGate();
    gate.offer('ABC', 0);
    gate.resolved('ABC');
    gate.clear();
    expect(gate.offer('ABC', 16)).toBe('accept');
  });

  it('cannot grow past the codes seen inside the current window', () => {
    const gate = new ScanGate();
    // A long sweep across many distinct labels: the map must not retain them all.
    for (let i = 0; i < 100; i += 1) gate.offer(`CODE-${i}`, i);
    // Long after the last of them, one more read prunes the lot.
    gate.offer('LAST', 10_000);
    expect(map(gate).size).toBe(1);
  });
});

/** Reach the private map, so the prune contract is asserted rather than assumed. */
function map(gate: ScanGate): Map<string, unknown> {
  return (gate as unknown as { seen: Map<string, unknown> }).seen;
}
